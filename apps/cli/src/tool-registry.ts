import {
  makeContrastRuns,
  makeGetApplicationConstraints,
  makeGetFailureEvidence,
  makeGetFlow,
  makeGetPreviousExperimentSummary,
  type ApplicationConstraints,
  type FlowFacts,
  type PreviousExperimentSummary,
  type RunEvidenceFacts,
  type Tool,
} from "@investigator/tools";
import { ACTION_TYPES } from "@investigator/core";
import type { Runtime } from "./runtime.js";

/**
 * Wiring the read-only tools to real data.
 *
 * Playwright produces evidence. Deterministic software normalizes and measures evidence. DeepSeek interprets and prioritizes evidence. Humans authorize consequential transitions.
 *
 * The tools themselves take READER FUNCTIONS, so `packages/tools` never imports a store, a
 * browser, or a provider. This module is where those readers are supplied — in the CLI, which is
 * allowed to depend on everything. The separation is what lets the tool contract test prove the
 * read-only claim instead of asserting it.
 *
 * Everything a reader returns is already normalized and already redacted. A tool is a projection
 * over evidence that crossed the redaction boundary long before, never a fresh read of raw bytes.
 */

export interface ToolRegistryData {
  flow: FlowFacts | null;
  previous: PreviousExperimentSummary[];
}

export function buildToolRegistry(
  rt: Runtime,
  investigationId: string,
  data: ToolRegistryData
): Map<string, Tool<never, unknown>> {
  const constraintsFor = (targetName?: string): ApplicationConstraints | null => {
    const names = Object.keys(rt.config.execution.targets);
    const name = targetName ?? names[0];
    if (!name) return null;
    const target = rt.config.execution.targets[name];
    if (!target) return null;
    return {
      targetName: name,
      classification: target.classification,
      allowedOrigins: [...rt.config.safety.allowedOrigins],
      resetStrategy: target.resetStrategy,
      blockDestructiveActions: rt.config.safety.blockDestructiveActions,
      maxRunsPerInvestigation: rt.config.safety.maxRunsPerInvestigation,
      // The closed vocabulary, stated plainly. A proposal outside it cannot be executed, so the
      // model is told the boundary rather than left to discover it by being refused.
      permittedActionTypes: [...ACTION_TYPES],
      emulationProfiles: Object.keys(rt.config.execution.emulation.profiles),
    };
  };

  const registry = new Map<string, Tool<never, unknown>>();
  registry.set("get_flow", makeGetFlow(() => data.flow) as never);
  registry.set(
    "get_application_constraints",
    makeGetApplicationConstraints((_inv, target) => constraintsFor(target)) as never
  );
  registry.set(
    "get_previous_experiment_summary",
    makeGetPreviousExperimentSummary((_inv, experimentId) =>
      experimentId ? data.previous.filter((p) => p.experimentId === experimentId) : data.previous
    ) as never
  );
  void investigationId;
  return registry;
}

/**
 * Deterministic summaries of what already ran.
 *
 * These are MEASUREMENTS, not interpretations: outcomes as the extractor classified them and
 * counts as it computed them. Handing a model an interpretation of previous runs would let one
 * model's guess become the next model's evidence.
 */
export async function readPreviousExperiments(
  rt: Runtime,
  investigationId: string
): Promise<PreviousExperimentSummary[]> {
  const runs = await rt.metadata.read((t) => t.listRuns(investigationId));
  const jobs = await rt.queue.listJobs(investigationId);
  const jobById = new Map(jobs.map((j) => [j.jobId, j]));

  const byExperiment = new Map<string, PreviousExperimentSummary>();
  for (const run of runs) {
    const job = jobById.get(run.jobId);
    const experimentId = job?.experimentId ?? "unknown";
    let entry = byExperiment.get(experimentId);
    if (!entry) {
      entry = {
        experimentId,
        runs: [],
        counts: {},
        hypothesis: null,
        variedFactor: null,
        distinctExceptionFingerprints: [],
        consoleErrorCount: 0,
      };
      byExperiment.set(experimentId, entry);
    }
    if (run.outcome) {
      entry.runs.push({
        runId: run.runId,
        outcome: run.outcome,
        outcomeRuleId: run.outcomeRuleId ?? 0,
      });
      entry.counts[run.outcome] = (entry.counts[run.outcome] ?? 0) + 1;
    }
  }
  return [...byExperiment.values()];
}

/**
 * Read back the Flow that `intake_to_flow` interpreted from the human's report.
 *
 * Returns null when no AI intake has run, and `get_flow` then reports NOT_READY rather than
 * inventing a flow — the same distinction the tool contract draws everywhere else: an absence is
 * reported, never filled in.
 */
export async function readFlowFacts(
  rt: Runtime,
  investigationId: string
): Promise<FlowFacts | null> {
  const refs = await rt.artifacts.list(investigationId, { kind: "flow" });
  const latest = refs[refs.length - 1];
  if (!latest) return null;

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(await rt.artifacts.getText(latest)) as Record<string, unknown>;
  } catch {
    // A flow artifact that will not parse is unusable evidence, not a reason to stop planning.
    return null;
  }

  return {
    flowId: String(parsed["flowId"] ?? "FLOW-001"),
    flowVersion: String(parsed["schemaVersion"] ?? "1.0.0"),
    targetName: parsed["targetName"] ? String(parsed["targetName"]) : null,
    steps: (parsed["steps"] ?? []) as FlowFacts["steps"],
    unknowns: (parsed["unknowns"] ?? []) as FlowFacts["unknowns"],
  };
}

/**
 * Read the deterministic per-run measurements the analysis tools project over.
 *
 * Everything here comes from artifacts that were written, hashed, and redacted during the run.
 * Nothing is recomputed: the extractor already decided what the features are, and a second
 * opinion computed here would be a second source of truth.
 */
export async function readRunEvidence(
  rt: Runtime,
  investigationId: string
): Promise<RunEvidenceFacts[]> {
  const runs = await rt.metadata.read((t) => t.listRuns(investigationId));
  const normalized = await rt.artifacts.list(investigationId, { kind: "normalized-evidence" });
  const byRun = new Map<string, (typeof normalized)[number]>();
  for (const ref of normalized) if (ref.runId) byRun.set(ref.runId, ref);

  const out: RunEvidenceFacts[] = [];
  for (const run of runs) {
    const ref = byRun.get(run.runId);
    if (!ref) continue;

    let doc: Record<string, unknown>;
    try {
      doc = JSON.parse(await rt.artifacts.getText(ref)) as Record<string, unknown>;
    } catch {
      // Unusable evidence is skipped rather than guessed at. `contrast_runs` reports the shortfall
      // through its own caveats, which is where a reader will look for it.
      continue;
    }

    const outcome = (doc["outcome"] ?? {}) as Record<string, unknown>;
    const capture = (doc["captureStatus"] ?? {}) as Record<string, unknown>;
    const categories = (capture["categories"] ?? {}) as Record<string, { status?: string }>;

    out.push({
      runId: run.runId,
      experimentId: run.experimentId ?? null,
      outcome: String(outcome["outcome"] ?? run.outcome ?? "UNKNOWN"),
      outcomeRuleId: Number(outcome["ruleId"] ?? run.outcomeRuleId ?? 0),
      outcomeDetail: String(outcome["detail"] ?? ""),
      attemptIndex: run.attemptIndex,
      durationMs: run.durationMs,
      features: (doc["features"] ?? {}) as Record<string, unknown>,
      captureStatus: Object.fromEntries(
        Object.entries(categories).map(([k, v]) => [k, String(v?.status ?? "unknown")])
      ),
      limitations: ((capture["limitations"] ?? []) as unknown[]).map(String),
      actions: ((doc["actions"] ?? []) as Array<Record<string, unknown>>).map((a) => ({
        actionId: String(a["actionId"] ?? ""),
        actionType: String(a["actionType"] ?? ""),
        status: String(a["status"] ?? ""),
        failureReason: a["failureReason"] === undefined ? null : String(a["failureReason"]),
        selectorCanonical:
          a["selectorCanonical"] === undefined || a["selectorCanonical"] === null
            ? null
            : String(a["selectorCanonical"]),
        startDeltaMs: a["startDeltaMs"] === undefined ? null : Number(a["startDeltaMs"]),
        endDeltaMs: a["endDeltaMs"] === undefined ? null : Number(a["endDeltaMs"]),
      })),
    });
  }
  return out;
}

/** The registry `analyze_failures` is allowed to reach. */
export function buildAnalysisRegistry(
  rt: Runtime,
  investigationId: string,
  data: { flow: FlowFacts | null; runs: RunEvidenceFacts[] }
): Map<string, Tool<never, unknown>> {
  const registry = new Map<string, Tool<never, unknown>>();
  registry.set("get_flow", makeGetFlow(() => data.flow) as never);
  registry.set("get_failure_evidence", makeGetFailureEvidence(() => data.runs) as never);
  registry.set("contrast_runs", makeContrastRuns(() => data.runs) as never);
  void rt;
  void investigationId;
  return registry;
}
