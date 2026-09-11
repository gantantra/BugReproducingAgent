import type {
  CaptureReason,
  CaptureReasonCode,
  CaptureStatus,
  CaptureStatusValue,
  CategoryStatus,
  EvidenceCategory,
  RedactionStamp,
  VersionStamps,
} from "@investigator/core";
import { EVIDENCE_CATEGORIES, worseCaptureStatus } from "@investigator/core";

/**
 * Capture completeness (ADR-0016).
 *
 * Every category appears in every CaptureStatus. There are no absent keys, because an omitted key
 * is indistinguishable from a forgotten one. The human-readable `limitations` array is GENERATED
 * from the machine-readable reasons by the template table below, so the prose and the data cannot
 * drift apart.
 */

const TEMPLATES: Record<CaptureReasonCode, (c: CaptureReason, cat: EvidenceCategory) => string> = {
  SIZE_LIMIT: (c, cat) =>
    `${count(c.count)} ${noun(cat, c.count)} exceeded the configured size limit${
      c.limitBytes ? ` of ${c.limitBytes} bytes` : ""
    }.`,
  CONTENT_TYPE_NOT_CAPTURED: (c, cat) =>
    `${count(c.count)} ${noun(cat, c.count)} were not captured because their content type is not in the capture list.`,
  POLICY_REDACTED: (c, cat) =>
    `Content material to analysis was removed from ${categoryLabel(cat)} by the redaction policy${
      c.count > 1 ? ` (${c.count} occurrences)` : ""
    }.`,
  CONFIG_OFF: (_c, cat) => `${capitalize(categoryLabel(cat))} capture is disabled by configuration.`,
  COLLECTOR_UNSUPPORTED: (_c, cat) =>
    `${capitalize(categoryLabel(cat))} capture is not supported by this collector version.`,
  RUN_INTERRUPTED: (_c, cat) =>
    `${capitalize(categoryLabel(cat))} collection stopped because the run was interrupted.`,
  PARSE_FAILED: (c, cat) =>
    `${count(c.count)} ${noun(cat, c.count)} are present but could not be parsed.`,
  HASH_MISMATCH: (c, cat) =>
    `${count(c.count)} ${noun(cat, c.count)} failed an integrity check.`,
  DROPPED_BACKPRESSURE: (c, cat) =>
    `${count(c.count)} ${noun(cat, c.count)} were dropped because event volume exceeded the in-process buffer.`,
  TARGET_DETACHED: (_c, cat) =>
    `${capitalize(categoryLabel(cat))} could not be captured because the page or context closed first.`,
};

const NOUNS: Partial<Record<EvidenceCategory, [string, string]>> = {
  responseBodies: ["response body", "response bodies"],
  domSnapshots: ["DOM snapshot", "DOM snapshots"],
  screenshots: ["screenshot", "screenshots"],
  console: ["console event", "console events"],
  networkMetadata: ["network event", "network events"],
  exceptions: ["exception", "exceptions"],
  actions: ["action", "actions"],
  navigation: ["navigation event", "navigation events"],
  storage: ["storage entry", "storage entries"],
  video: ["video", "videos"],
  trace: ["trace", "traces"],
  webSocketFrames: ["WebSocket frame", "WebSocket frames"],
};

const WORDS = [
  "Zero", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten",
  "Eleven", "Twelve",
];

function count(n: number): string {
  return WORDS[n] ?? String(n);
}

function noun(cat: EvidenceCategory, n: number): string {
  const pair = NOUNS[cat];
  if (!pair) return n === 1 ? "item" : "items";
  return n === 1 ? pair[0] : pair[1];
}

function categoryLabel(cat: EvidenceCategory): string {
  const pair = NOUNS[cat];
  return pair ? pair[1] : cat;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Accumulates per-category counts and reasons during a run, then seals into a CaptureStatus. */
export class CaptureStatusBuilder {
  private readonly categories = new Map<EvidenceCategory, CategoryStatus>();

  constructor(private readonly requiredCategories: readonly EvidenceCategory[] = []) {
    for (const cat of EVIDENCE_CATEGORIES) {
      this.categories.set(cat, { status: "complete", expected: null, collected: 0, reasons: [] });
    }
  }

  collected(cat: EvidenceCategory, n = 1): void {
    const entry = this.categories.get(cat)!;
    entry.collected = (entry.collected ?? 0) + n;
  }

  expected(cat: EvidenceCategory, n: number): void {
    this.categories.get(cat)!.expected = n;
  }

  /** Record a reason. Status is derived from the reasons at seal time, never set directly. */
  reason(cat: EvidenceCategory, code: CaptureReasonCode, opts: { count?: number; limitBytes?: number; detail?: string } = {}): void {
    const entry = this.categories.get(cat)!;
    entry.reasons ??= [];
    const existing = entry.reasons.find((r) => r.code === code);
    if (existing) {
      existing.count += opts.count ?? 1;
      return;
    }
    const reason: CaptureReason = { code, count: opts.count ?? 1 };
    if (opts.limitBytes !== undefined) reason.limitBytes = opts.limitBytes;
    if (opts.detail !== undefined) reason.detail = opts.detail;
    entry.reasons.push(reason);
  }

  /** Explicit override for the cases where a reason alone cannot determine the status. */
  setStatus(cat: EvidenceCategory, status: CaptureStatusValue): void {
    this.categories.get(cat)!.status = status;
    (this.categories.get(cat) as CategoryStatus & { _explicit?: boolean })._explicit = true;
  }

  /**
   * Derive status from reasons. The precedence here is what makes `disabled` worth having: an
   * operator choice reads differently from a collector limitation, and both differ from a
   * partial capture.
   */
  private deriveStatus(cat: EvidenceCategory, entry: CategoryStatus): CaptureStatusValue {
    if ((entry as CategoryStatus & { _explicit?: boolean })._explicit) return entry.status;
    const codes = new Set((entry.reasons ?? []).map((r) => r.code));

    if (codes.has("PARSE_FAILED") || codes.has("HASH_MISMATCH")) return "corrupted";
    if (codes.has("COLLECTOR_UNSUPPORTED")) return "unsupported";
    if (codes.has("CONFIG_OFF")) return "disabled";
    if (codes.has("POLICY_REDACTED")) return "redacted";

    const collected = entry.collected ?? 0;
    if (codes.has("RUN_INTERRUPTED")) return collected > 0 ? "partial" : "missing";
    if (codes.has("SIZE_LIMIT") || codes.has("CONTENT_TYPE_NOT_CAPTURED") || codes.has("DROPPED_BACKPRESSURE") || codes.has("TARGET_DETACHED")) {
      return collected > 0 ? "partial" : "missing";
    }
    if (entry.expected !== null && entry.expected !== undefined && collected < entry.expected) {
      return collected > 0 ? "partial" : "missing";
    }
    return "complete";
  }

  seal(args: { runId: string; versions: VersionStamps; redaction: RedactionStamp; unsafeTrace?: boolean; unsafeDebug?: boolean }): CaptureStatus {
    const categories = {} as Record<EvidenceCategory, CategoryStatus>;
    const limitations: string[] = [];

    for (const cat of EVIDENCE_CATEGORIES) {
      const entry = this.categories.get(cat)!;
      const status = this.deriveStatus(cat, entry);
      const out: CategoryStatus = { status };
      if (entry.expected !== null && entry.expected !== undefined) out.expected = entry.expected;
      if (entry.collected !== undefined) out.collected = entry.collected;
      if (entry.reasons?.length) out.reasons = entry.reasons.slice();
      categories[cat] = out;

      for (const r of entry.reasons ?? []) {
        limitations.push(TEMPLATES[r.code](r, cat));
      }
    }

    const status: CaptureStatus = {
      schemaVersion: "1.0.0",
      runId: args.runId,
      versions: args.versions,
      redaction: args.redaction,
      categories,
      limitations,
    };
    if (this.requiredCategories.length) {
      status.requiredCategories = [...this.requiredCategories];
    }
    if (args.unsafeTrace) status.unsafeTrace = true;
    if (args.unsafeDebug) status.unsafeDebug = true;
    return status;
  }
}

/**
 * Are the categories this operation requires actually usable? Drives RunOutcome rule 6: a green
 * run with a missing required category is INCONCLUSIVE, not a proof of correctness.
 */
export function requiredEvidenceUsable(
  status: CaptureStatus,
  required: readonly EvidenceCategory[]
): { ok: boolean; offending: Array<{ category: EvidenceCategory; status: CaptureStatusValue }> } {
  const offending: Array<{ category: EvidenceCategory; status: CaptureStatusValue }> = [];
  for (const cat of required) {
    const s = status.categories[cat]?.status ?? "missing";
    if (s === "missing" || s === "corrupted") offending.push({ category: cat, status: s });
  }
  return { ok: offending.length === 0, offending };
}

/** Aggregate across runs by taking the worst status per category. Never improves a status. */
export function aggregateCaptureStatus(
  statuses: readonly CaptureStatus[]
): Record<EvidenceCategory, CaptureStatusValue> {
  const out = {} as Record<EvidenceCategory, CaptureStatusValue>;
  for (const cat of EVIDENCE_CATEGORIES) {
    let worst: CaptureStatusValue = "complete";
    for (const s of statuses) {
      worst = worseCaptureStatus(worst, s.categories[cat]?.status ?? "missing");
    }
    out[cat] = worst;
  }
  return out;
}

/**
 * Forbidden overclaiming phrases (docs/architecture/capture-completeness.md). Linted over
 * rendered reports so generated prose cannot claim capture of all browser-visible data.
 */
export const FORBIDDEN_CLAIM_PHRASES: readonly RegExp[] = [
  /\ball browser data\b/i,
  /\bcomplete browser state\b/i,
  /\bfull session capture\b/i,
  /\beverything the browser saw\b/i,
  /\bnothing was missed\b/i,
  /\bon Android\b(?!.*emulated)/i,
  /\bon a real device\b/i,
  /\bon mobile Chrome\b(?!.*emulated)/i,
];

export function lintForOverclaiming(text: string): string[] {
  const hits: string[] = [];
  for (const re of FORBIDDEN_CLAIM_PHRASES) {
    const m = re.exec(text);
    if (m) hits.push(m[0]);
  }
  return hits;
}
