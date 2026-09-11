import {
  capItems,
  toolError,
  toolOk,
  type Tool,
  type ToolContext,
  type ToolResult,
} from "./index.js";

/**
 * The three `propose_experiments` tools (M3).
 *
 * Playwright produces evidence. Deterministic software normalizes and measures evidence. DeepSeek interprets and prioritizes evidence. Humans authorize consequential transitions.
 *
 * Each takes a READER — a plain function supplying already-normalized, already-redacted facts —
 * rather than reaching for a store itself. Two consequences, both deliberate:
 *
 *  - `packages/tools` never imports `execution`, `storage` or `ai-gateway`, so a tool physically
 *    cannot drive a browser or call a provider (ADR-0011).
 *  - The contract test can run every tool with the network stubbed to throw and prove it, because
 *    there is nothing in here that could reach out.
 */

// ---------------------------------------------------------------------------------------------
// get_flow
// ---------------------------------------------------------------------------------------------

export interface FlowStep {
  stepId: string;
  description: string;
  actions: Array<{ actionId: string; type: string; selectorCanonical?: string; url?: string }>;
  assertions: Array<{ assertionId: string; kind: string }>;
}

export interface FlowFacts {
  flowId: string;
  flowVersion: string;
  targetName: string | null;
  steps: FlowStep[];
  /** Values the reporter did not supply. NEVER invented (M3-AT-8). */
  unknowns: Array<{ unknownId: string; field: string; why: string }>;
}

export interface GetFlowInput {
  investigationId: string;
}

export type FlowReader = (investigationId: string) => FlowFacts | null;

export function makeGetFlow(read: FlowReader): Tool<GetFlowInput, FlowFacts> {
  const meta = { id: "get_flow", version: "1.0.0" };
  return {
    ...meta,
    description:
      "The validated flow for this investigation: steps, actions, assertions, and the values the reporter did not supply. Returns facts only.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["investigationId"],
      properties: { investigationId: { type: "string" } },
    },
    async run(input: GetFlowInput, ctx: ToolContext): Promise<ToolResult<FlowFacts>> {
      if (input.investigationId !== ctx.investigationId) {
        // A tool may only ever read inside the investigation it was invoked for. Anything else
        // would let one investigation's evidence support another's finding.
        return toolError(meta, "OUT_OF_SCOPE", "A tool may not read another investigation", ctx);
      }
      const flow = read(input.investigationId);
      if (!flow) {
        return toolError(
          meta,
          "NOT_READY",
          "No flow has been produced for this investigation",
          ctx
        );
      }
      const { items, truncation } = capItems(flow.steps, ctx.maxItems ?? 200);
      return toolOk(meta, { ...flow, steps: items }, ctx, [], truncation);
    },
  };
}

// ---------------------------------------------------------------------------------------------
// get_application_constraints
// ---------------------------------------------------------------------------------------------

export interface ApplicationConstraints {
  targetName: string;
  classification: string;
  allowedOrigins: string[];
  resetStrategy: string;
  blockDestructiveActions: boolean;
  maxRunsPerInvestigation: number;
  /** The closed action vocabulary. A proposal outside it cannot be executed. */
  permittedActionTypes: string[];
  emulationProfiles: string[];
}

export interface GetConstraintsInput {
  investigationId: string;
  targetName?: string;
}

export type ConstraintsReader = (
  investigationId: string,
  targetName?: string
) => ApplicationConstraints | null;

export function makeGetApplicationConstraints(
  read: ConstraintsReader
): Tool<GetConstraintsInput, ApplicationConstraints> {
  const meta = { id: "get_application_constraints", version: "1.0.0" };
  return {
    ...meta,
    description:
      "What this target permits: allowed origins, the closed action vocabulary, reset strategy, and safety limits. A proposal outside these cannot run.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["investigationId"],
      properties: { investigationId: { type: "string" }, targetName: { type: "string" } },
    },
    async run(
      input: GetConstraintsInput,
      ctx: ToolContext
    ): Promise<ToolResult<ApplicationConstraints>> {
      if (input.investigationId !== ctx.investigationId) {
        return toolError(meta, "OUT_OF_SCOPE", "A tool may not read another investigation", ctx);
      }
      const constraints = read(input.investigationId, input.targetName);
      if (!constraints) {
        return toolError(
          meta,
          "NOT_FOUND",
          `No configured target${input.targetName ? ` named ${input.targetName}` : ""}`,
          ctx
        );
      }
      return toolOk(meta, constraints, ctx, []);
    },
  };
}

// ---------------------------------------------------------------------------------------------
// get_previous_experiment_summary
// ---------------------------------------------------------------------------------------------

export interface PreviousExperimentSummary {
  experimentId: string;
  /** Every datum a model could cite carries an id (contract invariant 3). */
  runs: Array<{ runId: string; outcome: string; outcomeRuleId: number }>;
  counts: Record<string, number>;
  hypothesis: string | null;
  variedFactor: string | null;
  /** What the deterministic extractor observed, so a proposal can build on measurement. */
  distinctExceptionFingerprints: Array<{ fingerprint: string; count: number }>;
  consoleErrorCount: number;
}

export interface GetPreviousInput {
  investigationId: string;
  experimentId?: string;
}

export type PreviousReader = (
  investigationId: string,
  experimentId?: string
) => PreviousExperimentSummary[];

export function makeGetPreviousExperimentSummary(
  read: PreviousReader
): Tool<GetPreviousInput, { experiments: PreviousExperimentSummary[] }> {
  const meta = { id: "get_previous_experiment_summary", version: "1.0.0" };
  return {
    ...meta,
    description:
      "Deterministic summaries of experiments already run in this investigation: outcomes per run, exception fingerprints, console error counts. Measurements, not interpretations.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["investigationId"],
      properties: { investigationId: { type: "string" }, experimentId: { type: "string" } },
    },
    async run(
      input: GetPreviousInput,
      ctx: ToolContext
    ): Promise<ToolResult<{ experiments: PreviousExperimentSummary[] }>> {
      if (input.investigationId !== ctx.investigationId) {
        return toolError(meta, "OUT_OF_SCOPE", "A tool may not read another investigation", ctx);
      }
      const all = read(input.investigationId, input.experimentId);
      const { items, truncation } = capItems(all, ctx.maxItems ?? 50);
      const runIds = items.flatMap((e) => e.runs.map((r) => r.runId));
      return toolOk(meta, { experiments: items }, ctx, runIds, truncation);
    },
  };
}

/** The M3 allowlist for `propose_experiments`. */
export const PROPOSE_EXPERIMENTS_TOOLS = [
  "get_flow",
  "get_application_constraints",
  "get_previous_experiment_summary",
] as const;
