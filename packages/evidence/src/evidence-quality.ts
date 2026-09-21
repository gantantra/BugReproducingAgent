import type {
  CaptureReasonCode,
  CaptureStatus,
  CaptureStatusValue,
  EvidenceCategory,
} from "@investigator/core";
import { CAPTURE_STATUS_VALUES, EVIDENCE_CATEGORIES } from "@investigator/core";

/**
 * Evidence quality for one batch of runs (ADR-0032).
 *
 * A summary of every run's own CaptureStatus, plus the fixed table of which evidence each kind
 * of claim rests on. It is internal: it never blocks a batch and is never shown by default. Its
 * one job is to let a later step withhold a single finding when the evidence THAT finding needs
 * was incomplete in a run it cites -- and only that finding, never one resting on a category
 * that was fine.
 *
 * Pure: the same capture statuses in the same order give the same bytes.
 */

/**
 * What each kind of claim needs to have been captured completely. The keys are the
 * `claimCategory` values `analyze_failures` already declares (analyze-failures.output.v1.json).
 * Timing rests on the network and navigation timestamps, which every run carries; an authored
 * suite's own statements are not captured as actions, so they cannot be what timing needs.
 */
export const CLAIM_EVIDENCE_REQUIREMENTS = {
  network: ["networkMetadata"],
  console: ["console"],
  exception: ["exceptions"],
  dom: ["domSnapshots"],
  storage: ["storage"],
  navigation: ["navigation"],
  timing: ["networkMetadata", "navigation"],
} as const satisfies Record<string, readonly EvidenceCategory[]>;

export type ClaimCategory = keyof typeof CLAIM_EVIDENCE_REQUIREMENTS;

export interface EvidenceQuality {
  schemaVersion: "1.0.0";
  batchId: string;
  runCount: number;
  /** Per category: how many runs had each status, and the reason codes behind them. */
  categories: Record<
    EvidenceCategory,
    {
      runs: Record<CaptureStatusValue, number>;
      reasons: Partial<Record<CaptureReasonCode, number>>;
    }
  >;
  /** Per run, the status of every category a claim can rest on. */
  runs: Array<{ runId: string; statuses: Partial<Record<EvidenceCategory, CaptureStatusValue>> }>;
  requirements: typeof CLAIM_EVIDENCE_REQUIREMENTS;
}

const CLAIM_CATEGORIES: readonly EvidenceCategory[] = [
  ...new Set(Object.values(CLAIM_EVIDENCE_REQUIREMENTS).flat()),
].sort() as EvidenceCategory[];

export function buildEvidenceQuality(
  batchId: string,
  runs: ReadonlyArray<{ runId: string; captureStatus: CaptureStatus }>
): EvidenceQuality {
  const categories = {} as EvidenceQuality["categories"];
  for (const cat of EVIDENCE_CATEGORIES) {
    const counts = {} as Record<CaptureStatusValue, number>;
    for (const v of CAPTURE_STATUS_VALUES) counts[v] = 0;
    categories[cat] = { runs: counts, reasons: {} };
  }

  const perRun: EvidenceQuality["runs"] = [];
  for (const run of runs) {
    const statuses: Partial<Record<EvidenceCategory, CaptureStatusValue>> = {};
    for (const cat of EVIDENCE_CATEGORIES) {
      const entry = run.captureStatus.categories[cat];
      // An absent category is not "complete by default": it is evidence nobody recorded.
      const status: CaptureStatusValue = entry?.status ?? "missing";
      categories[cat].runs[status] += 1;
      for (const r of entry?.reasons ?? []) {
        categories[cat].reasons[r.code] = (categories[cat].reasons[r.code] ?? 0) + r.count;
      }
      if (CLAIM_CATEGORIES.includes(cat)) statuses[cat] = status;
    }
    perRun.push({ runId: run.runId, statuses });
  }

  return {
    schemaVersion: "1.0.0",
    batchId,
    runCount: runs.length,
    categories,
    runs: perRun,
    requirements: CLAIM_EVIDENCE_REQUIREMENTS,
  };
}

/**
 * The categories a claim needs that were not complete in the given runs. Empty means the claim
 * stands on complete evidence. A run the record does not know is treated as incomplete: a
 * citation to a run with no capture record cannot be vouched for.
 */
export function incompleteEvidenceFor(
  quality: EvidenceQuality,
  claim: ClaimCategory,
  runIds: readonly string[]
): Array<{ runId: string; category: EvidenceCategory; status: CaptureStatusValue }> {
  const out: Array<{ runId: string; category: EvidenceCategory; status: CaptureStatusValue }> = [];
  for (const runId of runIds) {
    const run = quality.runs.find((r) => r.runId === runId);
    for (const category of CLAIM_EVIDENCE_REQUIREMENTS[claim]) {
      const status = run?.statuses[category] ?? "missing";
      if (status !== "complete") out.push({ runId, category, status });
    }
  }
  return out;
}
