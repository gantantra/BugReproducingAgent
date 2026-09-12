import type { EvidenceCategory } from "@investigator/core";
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
  const idx = Math.min(
    sortedAsc.length - 1,
    Math.max(0, Math.ceil((p / 100) * sortedAsc.length) - 1)
  );
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
