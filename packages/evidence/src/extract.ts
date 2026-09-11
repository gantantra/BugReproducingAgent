import type { EvidenceCategory, WilsonInterval } from "@investigator/core";
import type { EvidenceEvent, SessionTimeline } from "./timeline.js";

/**
 * Deterministic feature extraction (ADR-0007, stage 4).
 *
 * Pure computation over normalized, redacted events. This is the layer that makes the AI layer
 * possible: the model chooses among differences we measured, rather than mining raw archives for
 * coincidences (ADR-0011).
 *
 * Every feature listed in docs/architecture/evidence-normalization-plane.md is produced here.
 */

export interface StatusDistribution {
  /** exact status -> count */
  byStatus: Record<string, number>;
  /** 2xx/3xx/4xx/5xx -> count */
  byClass: Record<string, number>;
  /** `${origin}${pathTemplate}` -> exact status -> count */
  byPathTemplate: Record<string, Record<string, number>>;
}

export interface DurationStats {
  requestKey: string;
  count: number;
  minMs: number;
  medianMs: number;
  p95Ms: number;
  maxMs: number;
  buckets: Record<string, number>;
}

export interface OrderingFeature {
  /** The observed order of normalized request keys, first occurrence only. */
  sequence: string[];
  /** Stable hash-free fingerprint: the joined sequence, which is directly comparable. */
  fingerprint: string;
}

export interface AssertionOutcome {
  assertionId: string;
  actionId: string | null;
  result: "pass" | "fail" | "not-evaluated";
  isFailurePredicate: boolean;
  detail: string | null;
}

export interface DomDiffSummary {
  fromSnapshotId: string;
  toSnapshotId: string;
  structureChanged: boolean;
  nodeCountDelta: number;
}

export interface StorageDiffEntry {
  area: string;
  key: string;
  change: "added" | "removed" | "changed";
  /** Present only where policy permitted a value; otherwise the shape hash proves difference. */
  fromShape: string | null;
  toShape: string | null;
}

export interface NavigationFeature {
  sequence: string[];
  count: number;
  unexpectedReloads: number;
  redirectChains: number;
}

export interface ExtractedFeatures {
  runId: string;
  httpStatusDistribution: StatusDistribution;
  requestDurations: DurationStats[];
  requestOrdering: OrderingFeature;
  abortedRequests: { count: number; byReason: Record<string, number>; eventIds: string[] };
  consoleCounts: { byLevel: Record<string, number>; byFingerprint: Record<string, number> };
  exceptionFingerprints: { fingerprint: string; count: number; eventIds: string[] }[];
  assertionOutcomes: AssertionOutcome[];
  domDiffs: DomDiffSummary[];
  storageChanges: StorageDiffEntry[];
  navigation: NavigationFeature;
  eventCountsByCategory: Partial<Record<EvidenceCategory, number>>;
  actionCount: number;
  unattributedEventCount: number;
}

function percentile(sortedAsc: readonly number[], p: number): number {
  if (!sortedAsc.length) return 0;
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, Math.ceil((p / 100) * sortedAsc.length) - 1));
  return sortedAsc[idx] as number;
}

export interface ExtractOptions {
  assertionOutcomes?: AssertionOutcome[];
}

export function extractFeatures(
  timeline: SessionTimeline,
  opts: ExtractOptions = {}
): ExtractedFeatures {
  const byStatus: Record<string, number> = {};
  const byClass: Record<string, number> = {};
  const byPathTemplate: Record<string, Record<string, number>> = {};

  const durationsByKey = new Map<string, number[]>();
  const bucketsByKey = new Map<string, Record<string, number>>();
  const orderSeen = new Set<string>();
  const orderSequence: string[] = [];

  const abortedByReason: Record<string, number> = {};
  const abortedEventIds: string[] = [];

  const consoleByLevel: Record<string, number> = {};
  const consoleByFingerprint: Record<string, number> = {};

  const exceptionsByFp = new Map<string, string[]>();

  const navSequence: string[] = [];
  let unexpectedReloads = 0;

  const eventCountsByCategory: Partial<Record<EvidenceCategory, number>> = {};

  const domSnapshots: Array<{ snapshotId: string; nodeCount: number; structureHash: string }> = [];
  const storageByArea = new Map<string, Array<EvidenceEvent>>();

  for (const e of timeline.events) {
    eventCountsByCategory[e.category] = (eventCountsByCategory[e.category] ?? 0) + 1;

    if (e.request) {
      const r = e.request;
      // Status distribution is counted on the response phase only, so one request is not
      // counted four times.
      if (r.phase === "response" && r.status != null) {
        const s = String(r.status);
        byStatus[s] = (byStatus[s] ?? 0) + 1;
        const cls = `${r.statusClass}xx`;
        byClass[cls] = (byClass[cls] ?? 0) + 1;
        const tmplKey = `${r.url.origin}${r.url.pathTemplate}`;
        const perTmpl = (byPathTemplate[tmplKey] ??= {});
        perTmpl[s] = (perTmpl[s] ?? 0) + 1;
      }

      if (r.phase === "request" && !orderSeen.has(r.requestKey)) {
        orderSeen.add(r.requestKey);
        orderSequence.push(r.requestKey);
      }

      if (r.phase === "requestFinished" && r.timing?.durationMs != null) {
        const list = durationsByKey.get(r.requestKey) ?? [];
        list.push(r.timing.durationMs);
        durationsByKey.set(r.requestKey, list);
        const buckets = bucketsByKey.get(r.requestKey) ?? {};
        const b = r.timing.durationBucket ?? "unknown";
        buckets[b] = (buckets[b] ?? 0) + 1;
        bucketsByKey.set(r.requestKey, buckets);
      }

      if (r.phase === "requestFailed") {
        const reason = r.failureReason ?? "unknown";
        abortedByReason[reason] = (abortedByReason[reason] ?? 0) + 1;
        abortedEventIds.push(e.eventId);
      }
    }

    if (e.console) {
      consoleByLevel[e.console.level] = (consoleByLevel[e.console.level] ?? 0) + 1;
      const fp = e.console.textFingerprint;
      consoleByFingerprint[fp] = (consoleByFingerprint[fp] ?? 0) + 1;
    }

    if (e.exception) {
      const list = exceptionsByFp.get(e.exception.fingerprint) ?? [];
      list.push(e.eventId);
      exceptionsByFp.set(e.exception.fingerprint, list);
    }

    if (e.navigation) {
      const label = `${e.navigation.kind} ${e.navigation.url.origin}${e.navigation.url.pathTemplate}`;
      navSequence.push(label);
      if (e.navigation.kind === "reload") unexpectedReloads++;
    }

    if (e.domSnapshot) domSnapshots.push(e.domSnapshot);

    if (e.storage) {
      const list = storageByArea.get(e.storage.area) ?? [];
      list.push(e);
      storageByArea.set(e.storage.area, list);
    }
  }

  const requestDurations: DurationStats[] = [...durationsByKey.entries()]
    .map(([key, values]) => {
      const sorted = [...values].sort((a, b) => a - b);
      return {
        requestKey: key,
        count: sorted.length,
        minMs: sorted[0] as number,
        medianMs: percentile(sorted, 50),
        p95Ms: percentile(sorted, 95),
        maxMs: sorted[sorted.length - 1] as number,
        buckets: bucketsByKey.get(key) ?? {},
      };
    })
    .sort((a, b) => (a.requestKey < b.requestKey ? -1 : 1));

  // Consecutive snapshot pairs. Structural change is compared on the hash, which deliberately
  // excludes text, so a content change does not register as structural.
  const domDiffs: DomDiffSummary[] = [];
  for (let i = 1; i < domSnapshots.length; i++) {
    const prev = domSnapshots[i - 1] as (typeof domSnapshots)[number];
    const cur = domSnapshots[i] as (typeof domSnapshots)[number];
    domDiffs.push({
      fromSnapshotId: prev.snapshotId,
      toSnapshotId: cur.snapshotId,
      structureChanged: prev.structureHash !== cur.structureHash,
      nodeCountDelta: cur.nodeCount - prev.nodeCount,
    });
  }

  const storageChanges: StorageDiffEntry[] = [];
  for (const [area, snaps] of storageByArea) {
    for (let i = 1; i < snaps.length; i++) {
      const before = new Map(
        (snaps[i - 1]!.storage!.entries ?? []).map((x) => [
          x.key,
          x.valueShape?.sha256Prefix ?? x.value ?? null,
        ])
      );
      const after = new Map(
        (snaps[i]!.storage!.entries ?? []).map((x) => [
          x.key,
          x.valueShape?.sha256Prefix ?? x.value ?? null,
        ])
      );
      for (const [key, toShape] of after) {
        if (!before.has(key)) {
          storageChanges.push({ area, key, change: "added", fromShape: null, toShape });
        } else if (before.get(key) !== toShape) {
          storageChanges.push({
            area,
            key,
            change: "changed",
            fromShape: before.get(key) ?? null,
            toShape,
          });
        }
      }
      for (const [key, fromShape] of before) {
        if (!after.has(key)) {
          storageChanges.push({ area, key, change: "removed", fromShape, toShape: null });
        }
      }
    }
  }

  return {
    runId: timeline.runId,
    httpStatusDistribution: { byStatus, byClass, byPathTemplate },
    requestDurations,
    requestOrdering: { sequence: orderSequence, fingerprint: orderSequence.join(" -> ") },
    abortedRequests: {
      count: abortedEventIds.length,
      byReason: abortedByReason,
      eventIds: abortedEventIds,
    },
    consoleCounts: { byLevel: consoleByLevel, byFingerprint: consoleByFingerprint },
    exceptionFingerprints: [...exceptionsByFp.entries()]
      .map(([fingerprint, eventIds]) => ({ fingerprint, count: eventIds.length, eventIds }))
      .sort((a, b) => (a.fingerprint < b.fingerprint ? -1 : 1)),
    assertionOutcomes: opts.assertionOutcomes ?? [],
    domDiffs,
    storageChanges,
    navigation: {
      sequence: navSequence,
      count: navSequence.length,
      unexpectedReloads,
      redirectChains: 0,
    },
    eventCountsByCategory,
    actionCount: timeline.actions.length,
    unattributedEventCount: timeline.unattributedCount,
  };
}

/**
 * Pairwise ordering inversions relative to a reference sequence. This is the feature that made
 * the worked example possible: "in failing runs the initial results request finishes after the
 * filter request" is an inversion count, not a narrative.
 */
export function orderingInversions(
  reference: readonly string[],
  observed: readonly string[]
): { inversions: number; pairs: Array<[string, string]> } {
  const rank = new Map<string, number>();
  reference.forEach((k, i) => rank.set(k, i));
  const filtered = observed.filter((k) => rank.has(k));
  const pairs: Array<[string, string]> = [];
  let inversions = 0;
  for (let i = 0; i < filtered.length; i++) {
    for (let j = i + 1; j < filtered.length; j++) {
      const a = filtered[i] as string;
      const b = filtered[j] as string;
      if ((rank.get(a) as number) > (rank.get(b) as number)) {
        inversions++;
        pairs.push([a, b]);
      }
    }
  }
  return { inversions, pairs };
}

/**
 * Wilson score interval. Chosen over the normal approximation deliberately: at the small n and
 * low rates this product deals in, the normal approximation gives intervals that include
 * negative rates, and interval overlap is a promotion gate for `probable_trigger` (ADR-0012).
 *
 * Unit-tested against published reference values in M5.
 */
export function wilsonInterval(successes: number, n: number, confidence = 0.95): WilsonInterval {
  if (n <= 0) return { lower: 0, upper: 1, confidence };
  // Two-sided z for the requested confidence. 0.95 -> 1.959963985 exactly as tabulated.
  const z = zForConfidence(confidence);
  const p = successes / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = p + z2 / (2 * n);
  const spread = z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return {
    lower: Math.max(0, (centre - spread) / denom),
    upper: Math.min(1, (centre + spread) / denom),
    confidence,
  };
}

const Z_TABLE: Record<string, number> = {
  "0.8": 1.2815515655446004,
  "0.9": 1.6448536269514722,
  "0.95": 1.959963984540054,
  "0.98": 2.3263478740408408,
  "0.99": 2.5758293035489004,
};

export function zForConfidence(confidence: number): number {
  const key = String(confidence);
  const exact = Z_TABLE[key];
  if (exact !== undefined) return exact;
  // Acklam-style inverse normal, adequate for non-tabulated confidences.
  const p = 1 - (1 - confidence) / 2;
  return inverseNormalCdf(p);
}

function inverseNormalCdf(p: number): number {
  if (p <= 0 || p >= 1) throw new Error("inverseNormalCdf requires 0 < p < 1");
  const a = [-39.6968302866538, 220.946098424521, -275.928510446969, 138.357751867269, -30.6647980661472, 2.50662827745924];
  const b = [-54.4760987982241, 161.585836858041, -155.698979859887, 66.8013118877197, -13.2806815528857];
  const c = [-7.78489400243029e-3, -0.322396458041136, -2.40075827716184, -2.54973253934373, 4.37466414146497, 2.93816398269878];
  const d = [7.78469570904146e-3, 0.32246712907004, 2.445134137143, 3.75440866190742];
  const pLow = 0.02425;
  if (p < pLow) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) /
      ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1);
  }
  if (p <= 1 - pLow) {
    const q = p - 0.5;
    const r = q * q;
    return ((((((a[0]! * r + a[1]!) * r + a[2]!) * r + a[3]!) * r + a[4]!) * r + a[5]!) * q) /
      (((((b[0]! * r + b[1]!) * r + b[2]!) * r + b[3]!) * r + b[4]!) * r + 1);
  }
  const q = Math.sqrt(-2 * Math.log(1 - p));
  return -(((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) /
    ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1);
}

export function intervalsOverlap(a: WilsonInterval, b: WilsonInterval): boolean {
  return a.lower <= b.upper && b.lower <= a.upper;
}
