import { readFileSync } from "node:fs";
import { basename } from "node:path";
import {
  canonicalJson,
  fail,
  investigationId as makeInvestigationId,
  systemClock,
} from "@investigator/core";
import { ensureInvestigationDirs } from "@investigator/storage";
import { LineageWriter } from "@investigator/lineage";
import { runFlow } from "@investigator/ai-flows";
import type { GlobalOptions, Runtime } from "../runtime.js";
import { openAiSession } from "../ai.js";

/**
 * `investigate intake --from <file>` — the first node in the chain.
 *
 * Playwright produces evidence. Deterministic software normalizes and measures evidence. DeepSeek interprets and prioritizes evidence. Humans authorize consequential transitions.
 *
 * Storing the report is deterministic and unconditional: the bytes land as an artifact, the
 * investigation is created, and the first lineage node is recorded before any model is reached.
 *
 * `--ai` then runs `intake_to_flow` over the STORED artifact rather than over the operator's
 * screen, so the interpretation is always traceable to bytes that existed before the model saw
 * them. It is additive: a provider failure loses nothing that was captured.
 */

export interface IntakeOptions {
  from?: string;
  title?: string;
  env?: string;
  /** Also interpret the report into a structured Flow with `intake_to_flow` (M3). */
  ai?: boolean;
  /** Replay recorded provider responses instead of calling one. */
  replay?: string;
}

export interface IntakeResult {
  json: unknown;
  human: () => string;
}

export async function intakeCommand(
  rt: Runtime,
  opts: IntakeOptions,
  globals: GlobalOptions
): Promise<IntakeResult> {
  if (!opts.from) {
    fail("INPUT_INVALID", "`investigate intake` requires --from <file>", {
      context: { flag: "--from" },
    });
  }

  let reportText: string;
  try {
    reportText = readFileSync(opts.from, "utf8");
  } catch (e) {
    return fail("INPUT_INVALID", "Cannot read the intake report file", {
      context: { path: opts.from },
      cause: e,
    });
  }
  if (reportText.trim().length === 0) {
    fail("INPUT_INVALID", "The intake report is empty", { context: { path: opts.from } });
  }

  // A new investigation unless the operator named an existing one.
  const existingCount = (await rt.metadata.read((t) => t.listInvestigations())).length;
  const investigationId = globals.investigation ?? makeInvestigationId(existingCount + 1);

  if (opts.env && !rt.config.execution.targets[opts.env]) {
    fail("CONFIG_INVALID", `--env names a target that is not configured: ${opts.env}`, {
      context: {
        target: opts.env,
        configured: Object.keys(rt.config.execution.targets).join(",") || "(none)",
      },
    });
  }

  ensureInvestigationDirs(rt.workspace, investigationId);
  const createdAt = systemClock.nowIso();

  await rt.metadata.tx(async (t) => {
    if (!(await t.getInvestigation(investigationId))) {
      await t.insertInvestigation({
        investigationId,
        title: opts.title ?? basename(opts.from!),
        targetName: opts.env ?? null,
        createdAt,
        status: "open",
      });
    }
  });

  // The report goes through the redaction boundary like any other durable byte. A human's bug
  // report routinely contains a session id or a customer name pasted from a console.
  const outcome = rt.redactor.redactField("report.body", reportText);
  const storedText = outcome.value ?? "[redacted]";

  const ref = await rt.artifacts.put({
    investigationId,
    kind: "intake-report",
    filename: basename(opts.from),
    bytes: storedText,
    contentType: "text/markdown",
    redactionApplied: rt.redactor.policyStamp(),
  });

  // The report is the root of the provenance chain. Recorded as an edge from the artifact to
  // itself would be meaningless, so the node enters lineage when it is first interpreted (M3).
  // What M2 records is that a human supplied it.
  const lineage = lineageWriterFor(rt);
  await lineage.append({
    investigationId,
    edge: "superseded_by",
    fromKind: "intake_report",
    fromId: ref.artifactId,
    toKind: "intake_report",
    toId: ref.artifactId,
    actor: { kind: "deterministic", component: "cli:intake", version: "0.1.0" },
    inputs: { sourceFile: basename(opts.from), bytes: storedText.length, target: opts.env ?? null },
  });

  const redacted = outcome.value !== reportText;

  // The AI interpretation is OPT-IN and strictly additive. The report is already stored and the
  // investigation already exists, so a provider failure here loses nothing that was captured --
  // which is the isolation ADR-0006 requires, made concrete.
  let flow: {
    flowId: string;
    artifactId: string;
    sha256: string;
    steps: number;
    unknowns: number;
    aiRequestIds: string[];
  } | null = null;
  if (opts.ai) {
    const session = await openAiSession({
      rt,
      investigationId,
      flowId: "intake_to_flow",
      ...(opts.replay ? { replayDir: opts.replay } : {}),
    });
    const result = await runFlow<{
      flowId?: string;
      steps?: unknown[];
      unknowns?: unknown[];
    }>(
      {
        flow: session.flow,
        input: { report: storedText },
        userContent: JSON.stringify({
          report: storedText,
          targets: Object.keys(rt.config.execution.targets),
        }),
      },
      {
        investigationId,
        gateway: session.gateway,
        capabilities: session.capabilities,
        registry: new Map(),
        toolContext: {
          investigationId,
          normalizerVersion: "1.0.0",
          extractorVersion: "1.0.0",
          redaction: rt.redactor.policyStamp(),
          captureStatus: {},
        },
      }
    );

    if (result.status !== "complete") {
      // Typed, and nothing partial is persisted: an interpretation that did not finish is not a
      // half-flow, it is no flow.
      fail(
        "AI_INVALID_OUTPUT",
        `intake_to_flow did not complete: ${result.status === "inconclusive" ? result.reason : "partial"}`,
        { context: { flowId: "intake_to_flow", status: result.status } }
      );
    }

    const value = result.value;
    const flowId = String(value.flowId ?? "FLOW-001");

    // Persist the interpretation as an artifact, not merely as a lineage edge.
    //
    // Without this the model's reading of the human's report would exist only as a count in this
    // command's output, and `propose_experiments` would have to propose experiments blind to the
    // report it is investigating. Storing it canonically means the bytes a later flow reasons
    // over through `get_flow` are the same bytes a human can open, diff, and cite.
    const flowRef = await rt.artifacts.put({
      investigationId,
      kind: "flow",
      filename: `${flowId}.json`,
      bytes: canonicalJson({ ...value, investigationId }),
      contentType: "application/json",
      redactionApplied: rt.redactor.policyStamp(),
    });

    await lineageWriterFor(rt).append({
      investigationId,
      edge: "interpreted_as",
      fromKind: "intake_report",
      fromId: ref.artifactId,
      toKind: "flow",
      toId: flowId,
      actor: {
        kind: "ai",
        aiCallId: result.record.aiRequestIds[0] ?? "AIC-unknown",
        flowId: session.flow.definition.id,
        flowVersion: session.flow.definition.version,
        flowHash: session.flow.flowHash,
      },
      inputs: {
        reportArtifactId: ref.artifactId,
        flowArtifactId: flowRef.artifactId,
        turns: result.record.turns,
      },
    });

    flow = {
      flowId,
      artifactId: flowRef.artifactId,
      sha256: flowRef.sha256,
      steps: (value.steps ?? []).length,
      unknowns: (value.unknowns ?? []).length,
      aiRequestIds: result.record.aiRequestIds,
    };
  }

  return {
    json: {
      ok: true,
      investigationId,
      reportArtifactId: ref.artifactId,
      sha256: ref.sha256,
      bytes: storedText.length,
      redacted,
      target: opts.env ?? null,
      flow,
      nextCommand: `investigate plan --investigation ${investigationId} --from <proposal.json>`,
    },
    human: () =>
      [
        `Investigation ${investigationId} opened.`,
        `  report      ${ref.artifactId}  (${storedText.length} bytes${redacted ? ", redacted" : ""})`,
        `  target      ${opts.env ?? "(none yet)"}`,
        "",
        flow
          ? `  flow        ${flow.flowId}  (${flow.steps} steps, ${flow.unknowns} unknown${flow.unknowns === 1 ? "" : "s"}, interpreted by intake_to_flow)`
          : "  flow        (none — pass --ai to interpret this report with intake_to_flow)",
        "",
        "Next: render a gate-1 proposal.",
        `  investigate plan --investigation ${investigationId} --from <proposal.json>`,
        `  investigate plan --investigation ${investigationId} --ai`,
        "",
        "Interpretation is advisory. A human still approves what runs, at gate 1.",
      ].join("\n"),
  };
}

function lineageWriterFor(rt: Runtime): LineageWriter {
  return new LineageWriter(rt.metadata, systemClock);
}
