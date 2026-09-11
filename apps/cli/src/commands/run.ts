import { fail, systemClock } from "@investigator/core";
import { startFixture, type FixtureKind } from "@investigator/test-fixtures";
import { ensureInvestigationDirs } from "@investigator/storage";
import { Worker, enqueueExperiment, type ExperimentSpec } from "@investigator/execution";
import { LineageWriter } from "@investigator/lineage";
import type { GlobalOptions, Runtime } from "../runtime.js";
import { requireGateApproval } from "../gates.js";

/**
 * `investigate run` — the deterministic execution path. Makes no provider calls, and works with
 * no DEEPSEEK_API_KEY present (ADR-0006).
 *
 * Playwright produces evidence. Deterministic software normalizes and measures evidence. DeepSeek interprets and prioritizes evidence. Humans authorize consequential transitions.
 *
 * From M2 there is exactly ONE path from intent to browser and it passes through a human. The M1
 * `--fixture-experiment` flag, which accepted an experiment file directly, has been REMOVED: it
 * existed only because gate 1 did not yet exist, and leaving it would have left a door open that
 * the whole approval mechanism assumes is shut.
 *
 * What executes is the EFFECTIVE proposal — the post-edit document the approval recorded — never
 * the pre-edit one a human read but then changed.
 */

export interface RunCommandResult {
  json: unknown;
  human: () => string;
}

interface RunOptions {
  experiment?: string[];
  repeat?: number;
  maxParallel?: number;
  stopAfterFailures?: number;
  /** Starts a local fixture app and allowlists its origin for this run. Never bypasses a gate. */
  fixtureApp?: string;
  target?: string;
}

export async function runCommand(
  rt: Runtime,
  opts: RunOptions,
  globals: GlobalOptions
): Promise<RunCommandResult> {
  const investigationId = globals.investigation;
  if (!investigationId) {
    fail("INPUT_INVALID", "`investigate run` requires --investigation <id>", {
      context: { flag: "--investigation" },
    });
  }

  // THE gate. Everything below this line is authorised by a recorded human decision, or it does
  // not happen. There is no flag, config value, or environment variable that skips this call.
  const authorised = await requireGateApproval(rt, investigationId, "experiment_selection");

  const selected = authorised.effective.items.filter((item) => {
    if (!authorised.approvedItemIds.includes(item.itemId)) return false;
    if (opts.experiment?.length) return opts.experiment.includes(item.itemId);
    return true;
  });
  if (selected.length === 0) {
    fail(
      "GATE_REQUIRED",
      opts.experiment?.length
        ? `None of the requested experiments are in the approved set (${authorised.approvedItemIds.join(", ")}).`
        : "The approval authorised no items.",
      {
        context: {
          approved: authorised.approvedItemIds.join(","),
          requested: (opts.experiment ?? []).join(","),
        },
      }
    );
  }

  ensureInvestigationDirs(rt.workspace, investigationId);

  // `--fixture-app` starts a local fixture application for the duration of the run and allowlists
  // its origin in memory. It supplies a TARGET, never an experiment: what runs is still only what
  // was approved.
  let fixture: { origin: string; baseUrl: string; close: () => Promise<void> } | undefined;
  if (opts.fixtureApp) {
    fixture = await startFixture(opts.fixtureApp as FixtureKind);
    rt.config.execution.targets[opts.fixtureApp] = {
      baseUrl: fixture.baseUrl,
      classification: "fixture",
      resetStrategy: "fresh-context",
      correlationHeaderAllowed: false,
    };
    rt.config.safety.allowedOrigins = [...rt.config.safety.allowedOrigins, fixture.origin];
  }

  const lineage = new LineageWriter(rt.metadata, systemClock);
  const enqueued: Array<{ experimentId: string; jobIds: string[]; repetitions: number }> = [];
  let totalRepetitions = 0;

  for (const item of selected) {
    const experiment: ExperimentSpec = {
      experimentId: item.itemId,
      investigationId,
      actions: (item["actions"] ?? []) as ExperimentSpec["actions"],
      assertions: (item["assertions"] ?? []) as ExperimentSpec["assertions"],
      repetitions: (item["repetitions"] as number | undefined) ?? 1,
      requiredEvidence: (item["requiredEvidence"] ?? []) as ExperimentSpec["requiredEvidence"],
      ...(item["emulationProfile"] ? { emulationProfile: String(item["emulationProfile"]) } : {}),
      safety: (item["safety"] ?? {
        maxSideEffectClass: "read",
        destructiveActionIds: [],
        resetStrategy: "fresh-context",
      }) as ExperimentSpec["safety"],
      targetName: opts.target ?? opts.fixtureApp ?? String(item["targetName"] ?? ""),
    };

    const repetitions = opts.repeat ?? experiment.repetitions ?? 1;
    totalRepetitions += repetitions;

    // The acknowledged destructive actions come from the approval, so enqueue can enforce the
    // same requirement the gate did rather than trusting that it happened.
    const acknowledgedDestructiveActionIds = await acknowledgedFor(
      rt,
      investigationId,
      item.itemId
    );

    const result = await enqueueExperiment({
      config: rt.config,
      metadata: rt.metadata,
      queue: rt.queue,
      investigationId,
      experiment,
      repetitions,
      approvalId: authorised.approvalId,
      effectiveProposalChecksum: authorised.effectiveProposalChecksum,
      acknowledgedDestructiveActionIds,
      clock: systemClock,
    });
    enqueued.push({ experimentId: item.itemId, jobIds: result.jobIds, repetitions });

    for (const jobId of result.jobIds) {
      await lineage.append({
        investigationId,
        edge: "scheduled_as",
        fromKind: "approved_experiment",
        fromId: `A${item.itemId}`,
        toKind: "job",
        toId: jobId,
        actor: { kind: "deterministic", component: "cli:run", version: "0.1.0" },
        inputs: {
          approvalId: authorised.approvalId,
          effectiveProposalChecksum: authorised.effectiveProposalChecksum,
          seed: rt.config.execution.seed,
        },
      });
    }
  }

  const worker = new Worker({
    config: rt.config,
    metadata: rt.metadata,
    artifacts: rt.artifacts,
    queue: rt.queue,
    redactor: rt.redactor,
    clock: systemClock,
    workerId: rt.workerId,
    loadExperiment: (payloadJson) => JSON.parse(payloadJson) as ExperimentSpec,
  });

  let results;
  try {
    results = await worker.drain(totalRepetitions);
  } finally {
    // Explicit teardown, even if the batch threw: a fixture server left listening would hold a
    // port and outlive the command that started it.
    await fixture?.close();
  }

  // Every run is linked back to the job that produced it, which is what makes
  // "what authorised this run?" answerable offline.
  for (const r of results) {
    await lineage.append({
      investigationId,
      edge: "executed_as",
      fromKind: "job",
      fromId: r.jobId,
      toKind: "run",
      toId: r.runId,
      actor: { kind: "deterministic", component: "execution", version: "0.1.0" },
      inputs: { outcome: r.outcome, outcomeRuleId: r.outcomeRuleId, durationMs: r.durationMs },
    });
  }

  const byOutcome: Record<string, number> = {};
  for (const r of results) byOutcome[r.outcome] = (byOutcome[r.outcome] ?? 0) + 1;
  const stats = await rt.queue.stats(investigationId);

  return {
    json: {
      ok: true,
      investigationId,
      approvalId: authorised.approvalId,
      effectiveProposalChecksum: authorised.effectiveProposalChecksum,
      experiments: enqueued.map((e) => e.experimentId),
      requested: totalRepetitions,
      completed: results.length,
      byOutcome,
      queue: stats,
      runs: results.map((r) => ({
        runId: r.runId,
        jobId: r.jobId,
        outcome: r.outcome,
        outcomeRuleId: r.outcomeRuleId,
        terminalReason: r.terminalReason,
        durationMs: r.durationMs,
      })),
    },
    human: () => {
      const lines = [
        `Investigation ${investigationId}`,
        `Authorised by ${authorised.approvalId}  (effective ${authorised.effectiveProposalChecksum.slice(0, 23)}...)`,
        `Experiments:  ${enqueued.map((e) => e.experimentId).join(", ")}`,
        `Runs completed: ${results.length} of ${totalRepetitions} requested`,
        "",
        "Outcomes:",
      ];
      for (const [outcome, count] of Object.entries(byOutcome).sort()) {
        lines.push(`  ${outcome.padEnd(24)} ${count}`);
      }
      if (byOutcome["PRODUCT_FAILED"]) {
        lines.push(
          "",
          "A captured product failure is a successful worker execution, not a CLI error."
        );
      }
      return lines.join("\n");
    },
  };
}

/**
 * The destructive actions a human acknowledged for one item, read back from the approval record.
 *
 * Enqueue enforces the acknowledgement requirement independently of the gate, so a job cannot be
 * scheduled for a destructive action merely because some earlier step believed it was approved.
 */
async function acknowledgedFor(
  rt: Runtime,
  investigationId: string,
  itemId: string
): Promise<string[]> {
  const approvals = await rt.metadata.read((t) => t.listApprovals(investigationId));
  const out: string[] = [];
  for (const a of approvals) {
    if (a.gate !== "experiment_selection" || a.decision !== "approve") continue;
    const payload = JSON.parse(a.payloadJson) as {
      safetyAcknowledgements?: Array<{ itemId: string; actionId: string; acknowledged: boolean }>;
    };
    for (const ack of payload.safetyAcknowledgements ?? []) {
      if (ack.itemId === itemId && ack.acknowledged) out.push(ack.actionId);
    }
  }
  return out;
}
