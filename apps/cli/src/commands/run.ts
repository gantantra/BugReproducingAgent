import { readFileSync } from "node:fs";
import { fail, investigationId as makeInvestigationId, systemClock } from "@investigator/core";
import { ensureInvestigationDirs } from "@investigator/storage";
import { Worker, enqueueExperiment, type ExperimentSpec } from "@investigator/execution";
import type { GlobalOptions, Runtime } from "../runtime.js";

/**
 * `investigate run` — the deterministic execution path. Makes no provider calls, and works with
 * no DEEPSEEK_API_KEY present (ADR-0006).
 *
 * M1 NOTE: `--fixture-experiment` accepts an experiment file directly. This is NOT a bypass of
 * gate 1, because gate 1 does not exist until M2; M2 adds enforcement and deletes the flag.
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
  fixtureExperiment?: string;
  target?: string;
}

export async function runCommand(
  rt: Runtime,
  opts: RunOptions,
  globals: GlobalOptions
): Promise<RunCommandResult> {
  if (!opts.fixtureExperiment) {
    fail(
      "GATE_REQUIRED",
      "No approved experiment to run. Gate 1 (experiment_selection) arrives in M2; until then use --fixture-experiment.",
      { context: { milestone: "M1" } }
    );
  }

  const investigationId = globals.investigation ?? makeInvestigationId(1);

  let experiment: ExperimentSpec;
  try {
    experiment = JSON.parse(readFileSync(opts.fixtureExperiment, "utf8")) as ExperimentSpec;
  } catch (e) {
    return fail("INPUT_INVALID", "Cannot read fixture experiment file", {
      context: { path: opts.fixtureExperiment },
      cause: e,
    });
  }
  if (opts.target) experiment.targetName = opts.target;
  experiment.investigationId = investigationId;

  ensureInvestigationDirs(rt.workspace, investigationId);
  await rt.metadata.tx(async (t) => {
    if (!(await t.getInvestigation(investigationId))) {
      await t.insertInvestigation({
        investigationId,
        title: `Fixture run: ${experiment.experimentId}`,
        targetName: experiment.targetName,
        createdAt: systemClock.nowIso(),
        status: "open",
      });
    }
  });

  const repetitions = opts.repeat ?? experiment.repetitions ?? 1;
  await enqueueExperiment({
    config: rt.config,
    metadata: rt.metadata,
    queue: rt.queue,
    investigationId,
    experiment,
    repetitions,
    approvalId: null,
    effectiveProposalChecksum: null,
    clock: systemClock,
  });

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

  const results = await worker.drain(repetitions);

  const byOutcome: Record<string, number> = {};
  for (const r of results) byOutcome[r.outcome] = (byOutcome[r.outcome] ?? 0) + 1;
  const stats = await rt.queue.stats(investigationId);

  return {
    json: {
      ok: true,
      investigationId,
      experimentId: experiment.experimentId,
      requested: repetitions,
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
        `Investigation ${investigationId}   experiment ${experiment.experimentId}`,
        `Runs completed: ${results.length} of ${repetitions} requested`,
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
