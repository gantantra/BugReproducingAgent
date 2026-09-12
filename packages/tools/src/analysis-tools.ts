import { capItems, toolError, toolOk, type Tool, type ToolResult } from "./index.js";

/**
 * The `analyze_failures` tools: read-only projections over runs that have already completed.
 *
 * Playwright produces evidence. Deterministic software normalizes and measures evidence. DeepSeek interprets and prioritizes evidence. Humans authorize consequential transitions.
 *
 * The division of labour here is the whole architecture in miniature. `contrastRuns` is a PURE
 * FUNCTION over measurements the extractor already produced: which console fingerprints appear
 * only in failing runs, which request orderings separate the two groups, how timings differ. It
 * decides nothing. The model reads that contrast and proposes what it means — and every claim it
 * makes is then reference-checked against these same measurements.
 *
 * So "what differs between the runs that failed and the runs that passed" is answered by
 * arithmetic, not by a model. That matters because it is the question an intermittent bug turns
 * on, and it is exactly the question a model is most tempted to answer plausibly rather than
 * correctly.
 */

// ---------------------------------------------------------------------------------------------
// Facts the CLI supplies
// ---------------------------------------------------------------------------------------------

export interface RunActionFacts {
  actionId: string;
  actionType: string;
  status: string;
  failureReason?: string | null;
  selectorCanonical?: string | null;
  startDeltaMs?: number | null;
  endDeltaMs?: number | null;
}

export interface RunEvidenceFacts {
  runId: string;
  experimentId: string | null;
  outcome: string;
  outcomeRuleId: number;
  outcomeDetail: string;
  attemptIndex?: number | null;
  durationMs?: number | null;
  /** The extractor's deterministic feature block, verbatim. */
  features: Record<string, unknown>;
  /** Category -> capture status, so a citation into a missing category can be refused. */
  captureStatus: Record<string, string>;
  limitations: string[];
  actions: RunActionFacts[];
}

export type RunEvidenceReader = (investigationId: string) => RunEvidenceFacts[];

const FAILING_OUTCOMES = new Set(["PRODUCT_FAILED", "AUTOMATION_FAILED"]);
const PASSING_OUTCOMES = new Set(["VALID_COMPLETED"]);

// ---------------------------------------------------------------------------------------------
// get_failure_evidence
// ---------------------------------------------------------------------------------------------

export interface GetFailureEvidenceInput {
  investigationId: string;
  /** Restrict to one outcome, e.g. PRODUCT_FAILED. Omit for every run. */
  outcome?: string;
}

export function makeGetFailureEvidence(
  read: RunEvidenceReader
): Tool<GetFailureEvidenceInput, { runs: RunEvidenceFacts[]; totalRuns: number }> {
  const meta = { id: "get_failure_evidence", version: "1.0.0" };
  return {
    ...meta,
    description:
      "Deterministic per-run measurements for this investigation: outcome and the rule that " +
      "produced it, console and exception fingerprints, request ordering and timings, assertion " +
      "results, navigation, and per-action status. Measurements only — no interpretation.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["investigationId"],
      properties: { investigationId: { type: "string" }, outcome: { type: "string" } },
    },
    async run(input, ctx) {
      if (input.investigationId !== ctx.investigationId) {
        return toolError(meta, "OUT_OF_SCOPE", "A tool may not read another investigation", ctx);
      }
      const all = read(input.investigationId);
      if (all.length === 0) {
        return toolError(meta, "NOT_READY", "No runs have completed for this investigation", ctx);
      }
      const selected = input.outcome ? all.filter((r) => r.outcome === input.outcome) : all;
      const { items, truncation } = capItems(selected, ctx.maxItems ?? 40);
      return toolOk(
        meta,
        { runs: items, totalRuns: all.length },
        ctx,
        items.map((r) => r.runId),
        truncation
      );
    },
  };
}

// ---------------------------------------------------------------------------------------------
// contrast_runs
// ---------------------------------------------------------------------------------------------

export interface GroupedValue {
  value: string;
  failing: number;
  passing: number;
  /** True when the value occurs in one group and never in the other. */
  discriminating: boolean;
}

export interface NumericContrast {
  key: string;
  failingMedianMs: number | null;
  passingMedianMs: number | null;
  deltaMs: number | null;
}

export interface RunContrast {
  /**
   * A citable id for this comparison.
   *
   * The model is told to reason from the contrast, so the contrast has to be something it can
   * cite; a `comparison` evidence reference is invalid without one. Deterministic rather than
   * generated, so recomputing the contrast over the same runs yields the same id and an old
   * finding's citation still resolves.
   */
  comparisonId: string;
  failingRunIds: string[];
  passingRunIds: string[];
  otherRunIds: string[];
  /** Console message fingerprints, grouped. */
  consoleFingerprints: GroupedValue[];
  exceptionFingerprints: GroupedValue[];
  /** The ordered network request signature of the run. */
  requestOrderings: GroupedValue[];
  navigationSequences: GroupedValue[];
  httpStatusClasses: GroupedValue[];
  failedAssertions: GroupedValue[];
  firstFailingAction: GroupedValue[];
  requestTimings: NumericContrast[];
  /**
   * Values present in every failing run and in no passing run. The strongest deterministic
   * signal available, and the reason this function exists.
   */
  perfectDiscriminators: string[];
  /** Stated plainly so a reader is never invited to over-read a thin comparison. */
  caveats: string[];
}

function tally(
  runs: readonly RunEvidenceFacts[],
  failing: ReadonlySet<string>,
  passing: ReadonlySet<string>,
  extract: (r: RunEvidenceFacts) => string[]
): GroupedValue[] {
  const counts = new Map<string, { failing: number; passing: number }>();
  for (const run of runs) {
    const isFail = failing.has(run.runId);
    const isPass = passing.has(run.runId);
    if (!isFail && !isPass) continue;
    for (const value of new Set(extract(run))) {
      const entry = counts.get(value) ?? { failing: 0, passing: 0 };
      if (isFail) entry.failing++;
      else entry.passing++;
      counts.set(value, entry);
    }
  }
  return (
    [...counts.entries()]
      .map(([value, c]) => ({
        value,
        failing: c.failing,
        passing: c.passing,
        discriminating: (c.failing === 0) !== (c.passing === 0),
      }))
      // Sorted deterministically: discriminating first, then by how lopsided, then by name. Two
      // identical inputs must produce byte-identical output or the flowHash story is worthless.
      .sort(
        (a, b) =>
          Number(b.discriminating) - Number(a.discriminating) ||
          Math.abs(b.failing - b.passing) - Math.abs(a.failing - a.passing) ||
          (a.value < b.value ? -1 : a.value > b.value ? 1 : 0)
      )
  );
}

const asRecord = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : Math.round(((s[mid - 1]! + s[mid]!) / 2) * 1000) / 1000;
}

/**
 * Contrast failing runs against passing ones, using only what the extractor measured.
 *
 * Pure and total: no clock, no randomness, no I/O. Given the same runs it returns the same bytes,
 * which is what lets a finding built on it be re-checked later.
 */
export function contrastRuns(
  runs: readonly RunEvidenceFacts[],
  comparisonId = "CMP-001"
): RunContrast {
  const failingRunIds = runs.filter((r) => FAILING_OUTCOMES.has(r.outcome)).map((r) => r.runId);
  const passingRunIds = runs.filter((r) => PASSING_OUTCOMES.has(r.outcome)).map((r) => r.runId);
  const otherRunIds = runs
    .filter((r) => !FAILING_OUTCOMES.has(r.outcome) && !PASSING_OUTCOMES.has(r.outcome))
    .map((r) => r.runId);

  const failing = new Set(failingRunIds);
  const passing = new Set(passingRunIds);

  const consoleFingerprints = tally(runs, failing, passing, (r) =>
    Object.keys(asRecord(asRecord(r.features["consoleCounts"])["byFingerprint"]))
  );
  const exceptionFingerprints = tally(runs, failing, passing, (r) =>
    asArray(r.features["exceptionFingerprints"]).map((e) => String(asRecord(e)["fingerprint"] ?? e))
  );
  const requestOrderings = tally(runs, failing, passing, (r) => {
    const fp = asRecord(r.features["requestOrdering"])["fingerprint"];
    return fp ? [String(fp)] : [];
  });
  const navigationSequences = tally(runs, failing, passing, (r) =>
    asArray(asRecord(r.features["navigation"])["sequence"]).map(String)
  );
  const httpStatusClasses = tally(runs, failing, passing, (r) =>
    Object.entries(asRecord(asRecord(r.features["httpStatusDistribution"])["byClass"])).map(
      ([cls, n]) => `${cls}=${String(n)}`
    )
  );
  const failedAssertions = tally(runs, failing, passing, (r) =>
    asArray(r.features["assertionOutcomes"])
      .map(asRecord)
      .filter((a) => a["result"] === "fail")
      .map((a) => `${String(a["assertionId"])}: ${String(a["detail"] ?? "")}`)
  );
  const firstFailingAction = tally(runs, failing, passing, (r) => {
    const failed = r.actions.find((a) => a.status !== "ok" && a.status !== "completed");
    return failed ? [`${failed.actionId} ${failed.actionType}: ${failed.status}`] : [];
  });

  // Request timings per request key, failing vs passing.
  const keys = new Set<string>();
  for (const r of runs) {
    for (const d of asArray(r.features["requestDurations"])) {
      const k = asRecord(d)["requestKey"];
      if (k) keys.add(String(k));
    }
  }
  const timingsFor = (ids: ReadonlySet<string>, key: string): number[] =>
    runs
      .filter((r) => ids.has(r.runId))
      .flatMap((r) =>
        asArray(r.features["requestDurations"])
          .map(asRecord)
          .filter((d) => String(d["requestKey"]) === key)
          .map((d) => Number(d["medianMs"] ?? 0))
      );

  const requestTimings: NumericContrast[] = [...keys]
    .sort()
    .map((key) => {
      const f = median(timingsFor(failing, key));
      const p = median(timingsFor(passing, key));
      return {
        key,
        failingMedianMs: f,
        passingMedianMs: p,
        deltaMs: f !== null && p !== null ? Math.round((f - p) * 1000) / 1000 : null,
      };
    })
    .filter((t) => t.failingMedianMs !== null || t.passingMedianMs !== null);

  const perfectDiscriminators = [
    ...consoleFingerprints,
    ...exceptionFingerprints,
    ...requestOrderings,
    ...navigationSequences,
    ...failedAssertions,
    ...firstFailingAction,
  ]
    .filter(
      (g) => g.failing === failingRunIds.length && g.passing === 0 && failingRunIds.length > 0
    )
    .map((g) => g.value)
    .sort();

  const caveats: string[] = [];
  if (failingRunIds.length === 0) caveats.push("No run failed, so there is nothing to contrast.");
  if (passingRunIds.length === 0) {
    caveats.push(
      "Every run failed. With no passing run, nothing here discriminates: a value common to all " +
        "failures may be common to all runs of this experiment."
    );
  }
  if (failingRunIds.length > 0 && failingRunIds.length < 3) {
    caveats.push(
      `Only ${failingRunIds.length} failing run(s). A value seen in all of them may be coincidence.`
    );
  }
  if (otherRunIds.length > 0) {
    caveats.push(
      `${otherRunIds.length} run(s) were neither a clean pass nor a product/automation failure ` +
        `(infrastructure or interrupted) and are excluded from the contrast.`
    );
  }
  const withMissing = runs.filter((r) =>
    Object.values(r.captureStatus).some((s) => s === "missing" || s === "corrupted")
  );
  if (withMissing.length > 0) {
    caveats.push(
      `${withMissing.length} run(s) have a missing or corrupted evidence category. An absent ` +
        `signal in those runs means "not captured", never "did not happen".`
    );
  }

  return {
    comparisonId,
    failingRunIds,
    passingRunIds,
    otherRunIds,
    consoleFingerprints,
    exceptionFingerprints,
    requestOrderings,
    navigationSequences,
    httpStatusClasses,
    failedAssertions,
    firstFailingAction,
    requestTimings,
    perfectDiscriminators,
    caveats,
  };
}

export interface ContrastInput {
  investigationId: string;
}

export function makeContrastRuns(read: RunEvidenceReader): Tool<ContrastInput, RunContrast> {
  const meta = { id: "contrast_runs", version: "1.0.0" };
  return {
    ...meta,
    description:
      "A deterministic comparison of the runs that failed against the runs that passed: which " +
      "console and exception fingerprints, request orderings, navigation sequences, assertions " +
      "and timings separate the two groups. Arithmetic over measurements, with the limits of " +
      "the comparison stated. Use this before proposing any cause.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["investigationId"],
      properties: { investigationId: { type: "string" } },
    },
    async run(input, ctx): Promise<ToolResult<RunContrast>> {
      if (input.investigationId !== ctx.investigationId) {
        return toolError(meta, "OUT_OF_SCOPE", "A tool may not read another investigation", ctx);
      }
      const runs = read(input.investigationId);
      if (runs.length === 0) {
        return toolError(meta, "NOT_READY", "No runs have completed for this investigation", ctx);
      }
      const contrast = contrastRuns(runs);
      return toolOk(meta, contrast, ctx, [...contrast.failingRunIds, ...contrast.passingRunIds]);
    },
  };
}
