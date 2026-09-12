import type { CaptureStatus, EvidenceCategory, VersionStamps } from "@investigator/core";
import { EXTRACTOR_VERSION, NORMALIZER_VERSION, canonicalJson } from "@investigator/core";
import { parseRawLog, type RawEvent } from "./raw-events.js";
import {
  buildEvidenceIndex,
  buildTimeline,
  type EvidenceIndex,
  type SessionTimeline,
} from "./timeline.js";
import { extractFeatures, type AssertionOutcome, type ExtractedFeatures } from "./extract.js";
import { CaptureStatusBuilder, requiredEvidenceUsable } from "./capture-status.js";
import type { Redactor } from "./redaction.js";
import { decideOutcome, type OutcomeDecision, type OutcomeInputs } from "./outcome.js";

/**
 * The Evidence Normalization Plane, stages 1 through 5 (ADR-0007).
 *
 * ```
 * raw log + raw artifacts
 *   -> parse -> normalize -> redact -> extract -> timeline + index
 * ```
 *
 * The whole plane is a pure function of `(raw artifacts, redactionPolicyVersion,
 * normalizerVersion, extractorVersion)`. `run()` takes the raw log text and returns everything
 * derived, so `offline_session_reconstruction.spec.ts` can rebuild with the network stubbed to
 * throw and no browser binary reachable, and compare bytes.
 */

export interface PlaneInput {
  runId: string;
  rawLogText: string;
  redactor: Redactor;
  collectorVersion: string;
  requiredCategories?: readonly EvidenceCategory[];
  assertionOutcomes?: AssertionOutcome[];
  /** Artifact ids the collector registered, keyed by the raw event seq that produced them. */
  artifactIdsBySeq?: Map<number, string[]>;
  /** Categories the collector reported as unavailable, with the reason. */
  collectorNotes?: Array<{
    category: EvidenceCategory;
    code: Parameters<CaptureStatusBuilder["reason"]>[1];
    count?: number;
    limitBytes?: number;
  }>;
  /** Set when the run was killed or its lease expired. Drives outcome rule 1. */
  interrupted?: boolean;
  infrastructureFailure?: { reason: string } | null;
  automationFailure?: { reason: string; actionId?: string } | null;
  unsafeTrace?: boolean;
  unsafeDebug?: boolean;
}

export interface PlaneResult {
  runId: string;
  versions: VersionStamps;
  events: SessionTimeline["events"];
  actions: SessionTimeline["actions"];
  index: EvidenceIndex;
  features: ExtractedFeatures;
  captureStatus: CaptureStatus;
  outcome: OutcomeDecision;
  parse: { truncatedTail: boolean; eventCount: number };
  /** Byte-identical for identical inputs. This is what the reconstruction test compares. */
  normalizedJson: string;
}

const DEFAULT_REQUIRED: readonly EvidenceCategory[] = [
  "actions",
  "navigation",
  "console",
  "exceptions",
  "networkMetadata",
];

/**
 * Recover the seq -> artifact id association from the raw log.
 *
 * The collector binds each content-addressed artifact id onto the event that produced it, so this
 * association survives in the persisted log and a rebuild reproduces `artifactIds` without the
 * in-process map. A caller-supplied map is still merged, which keeps
 * `offline_session_reconstruction` a live tripwire: a future capture path that sets the in-memory
 * map but forgets the log would make the original and the rebuild diverge, and the test fails
 * rather than the evidence quietly losing its artifact references.
 */
function recoverArtifactIds(
  rawEvents: readonly RawEvent[],
  supplied?: Map<number, string[]>
): Map<number, string[]> {
  const out = new Map<number, string[]>();
  for (const e of rawEvents) {
    const id = (e as { artifactId?: unknown }).artifactId;
    if (typeof id === "string" && id.length > 0) out.set(e.seq, [id]);
  }
  if (supplied) for (const [seq, ids] of supplied) out.set(seq, ids);
  return out;
}

export function runPlane(input: PlaneInput): PlaneResult {
  const versions: VersionStamps = {
    collectorVersion: input.collectorVersion,
    normalizerVersion: NORMALIZER_VERSION,
    extractorVersion: EXTRACTOR_VERSION,
  };

  // Stage 1: parse. A truncated final line is what a killed worker leaves; report it, do not throw.
  const { events: rawEvents, truncatedTail } = parseRawLog(input.rawLogText);

  // Stages 2 and 3: normalize and redact, inside the timeline builder so the pure-function
  // property and the redaction boundary are the same property.
  input.redactor.resetCounters();
  const artifactIdsBySeq = recoverArtifactIds(rawEvents, input.artifactIdsBySeq);
  const timeline = buildTimeline(rawEvents, {
    runId: input.runId,
    redactor: input.redactor,
    ...(artifactIdsBySeq.size > 0 ? { artifactIdsBySeq } : {}),
  });

  // Stage 4: extract.
  const features = extractFeatures(timeline, {
    ...(input.assertionOutcomes ? { assertionOutcomes: input.assertionOutcomes } : {}),
  });

  // Stage 5: index.
  const index = buildEvidenceIndex(timeline);

  const required = input.requiredCategories ?? DEFAULT_REQUIRED;
  const captureStatus = buildCaptureStatus(
    input,
    rawEvents,
    features,
    required,
    versions,
    truncatedTail
  );

  const outcomeInputs: OutcomeInputs = {
    interrupted: input.interrupted === true,
    infrastructureFailure: input.infrastructureFailure ?? null,
    automationFailure: input.automationFailure ?? null,
    assertionOutcomes: features.assertionOutcomes,
    consoleErrorCount: features.consoleCounts.byLevel["error"] ?? 0,
    exceptionCount: features.exceptionFingerprints.reduce((a, e) => a + e.count, 0),
    captureStatus,
    requiredCategories: required,
  };
  const outcome = decideOutcome(outcomeInputs);

  // The canonical serialisation of everything derived. Byte-identical for identical inputs.
  const normalizedJson = canonicalJson({
    runId: input.runId,
    versions,
    events: timeline.events,
    actions: timeline.actions,
    features,
    captureStatus,
    outcome,
  });

  return {
    runId: input.runId,
    versions,
    events: timeline.events,
    actions: timeline.actions,
    index,
    features,
    captureStatus,
    outcome,
    parse: { truncatedTail, eventCount: rawEvents.length },
    normalizedJson,
  };
}

function buildCaptureStatus(
  input: PlaneInput,
  rawEvents: readonly RawEvent[],
  features: ExtractedFeatures,
  required: readonly EvidenceCategory[],
  versions: VersionStamps,
  truncatedTail: boolean
): CaptureStatus {
  const builder = new CaptureStatusBuilder(required);

  for (const [cat, count] of Object.entries(features.eventCountsByCategory)) {
    builder.collected(cat as EvidenceCategory, count ?? 0);
  }

  // Actions: expected is known exactly, since every action emits a start and an end event.
  const actionStarts = rawEvents.filter(
    (e) => e.category === "action" && e.phase === "start"
  ).length;
  const actionEnds = rawEvents.filter((e) => e.category === "action" && e.phase === "end").length;
  builder.expected("actions", actionStarts * 2);
  if (actionEnds < actionStarts) {
    builder.reason("actions", "RUN_INTERRUPTED", { count: actionStarts - actionEnds });
  }

  // Response bodies: the collector records per-body skip reasons, which become the counts.
  const bodyEvents = rawEvents.filter((e) => e.category === "responseBody");
  if (bodyEvents.length) {
    builder.expected("responseBodies", bodyEvents.length);
    for (const e of bodyEvents) {
      if (e.category !== "responseBody") continue;
      if (e.captured) continue;
      if (e.skipReason) {
        builder.reason("responseBodies", e.skipReason, { count: 1 });
      }
    }
  }

  // Notes recovered from the log itself, so a rebuild from artifacts alone is faithful.
  // Anything passed in by the caller is merged on top for the live path.
  const fromLog = rawEvents.filter(
    (e): e is Extract<RawEvent, { category: "collectorNote" }> => e.category === "collectorNote"
  );
  for (const n of fromLog) {
    builder.reason(
      n.evidenceCategory as EvidenceCategory,
      n.code as Parameters<CaptureStatusBuilder["reason"]>[1],
      {
        ...(n.count !== undefined ? { count: n.count } : {}),
        ...(n.limitBytes !== undefined ? { limitBytes: n.limitBytes } : {}),
      }
    );
    // Applied on THIS path too, not only the caller-supplied one below. A rebuild reads notes
    // from the log alone, and a capture status that differed between the live run and its
    // rebuild would break the byte-identical guarantee the plane exists to provide.
    if (n.code === "PERSISTED_UNREDACTED") {
      builder.collected(n.evidenceCategory as EvidenceCategory, n.count ?? 1);
    }
  }
  const alreadyFromLog = new Set(fromLog.map((n) => `${n.evidenceCategory}:${n.code}`));
  for (const note of input.collectorNotes ?? []) {
    if (alreadyFromLog.has(`${note.category}:${note.code}`)) continue;
    builder.reason(note.category, note.code, {
      ...(note.count !== undefined ? { count: note.count } : {}),
      ...(note.limitBytes !== undefined ? { limitBytes: note.limitBytes } : {}),
    });

    // A stored recording is not an event in the raw log, so the per-category event counter never
    // sees it. Without this the video category sealed as "complete, collected 0" — a status that
    // says the opposite of what happened and would have a reader conclude nothing was captured.
    if (note.code === "PERSISTED_UNREDACTED") {
      builder.collected(note.category, note.count ?? 1);
    }
  }

  if (truncatedTail || input.interrupted) {
    // An interrupted run has an incomplete tail across every category that was still streaming.
    for (const cat of [
      "actions",
      "console",
      "networkMetadata",
      "navigation",
    ] as EvidenceCategory[]) {
      builder.reason(cat, "RUN_INTERRUPTED", { count: 1 });
    }
  }

  return builder.seal({
    runId: input.runId,
    versions,
    redaction: input.redactor.stamp(),
    ...(input.unsafeTrace ? { unsafeTrace: true } : {}),
    ...(input.unsafeDebug ? { unsafeDebug: true } : {}),
  });
}

export { requiredEvidenceUsable };
