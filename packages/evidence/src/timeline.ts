import type { EvidenceCategory, RedactionStamp } from "@investigator/core";
import { eventId as makeEventId } from "@investigator/core";
import type { RawEvent, RawRequestEvent } from "./raw-events.js";
import {
  durationBucket,
  exceptionFingerprint,
  normalizeMessageText,
  normalizePathTemplate,
  normalizeStack,
  requestKey,
  textFingerprint,
  type NormalizedFrame,
} from "./normalize.js";
import type { Redactor } from "./redaction.js";

/**
 * Session timeline and evidence index (ADR-0007, stage 5).
 *
 * Actions are the spine. Every other category is correlated to the action window it fell inside,
 * by `seq` rather than by timestamp: `seq` comes from a single in-process counter and is total,
 * whereas timestamps from different sources can tie.
 *
 * The rule reliability test 4 asserts: a network event belongs to the action whose
 * [actionStartSeq, actionEndSeq] window contains its START seq. A request that starts in one
 * window and finishes in a later one is attributed to its start window and carries
 * `finishedInActionId`. Events outside any window land in the synthetic `pre-first-action` or
 * `post-last-action` windows. Zero unattributed events.
 */

export type EventWindow = "pre-first-action" | "in-action" | "post-last-action";

export interface NormalizedUrl {
  origin: string;
  path: string;
  pathTemplate: string;
  queryKeys: string[];
  query: Record<string, string | null>;
  fragmentPresent: boolean;
  raw: string | null;
}

export interface EvidenceEvent {
  schemaVersion: "1.0.0";
  eventId: string;
  runId: string;
  category: EvidenceCategory;
  seq: number;
  tDeltaMs: number;
  tMonoMs: number;
  tWallMs: number;
  actionId?: string;
  window: EventWindow;
  artifactIds?: string[];
  redaction: RedactionStamp;
  redactedFields?: string[];
  // Category payloads. Exactly one is present, matching the schema conditionals.
  action?: {
    actionId: string;
    type: string;
    phase: "start" | "end";
    selectorCanonical?: string | null;
    status?: string;
    failureReason?: string | null;
  };
  navigation?: {
    kind: string;
    url: NormalizedUrl;
    isMainFrame: boolean;
  };
  console?: {
    level: string;
    text: string | null;
    textNormalized: string | null;
    textFingerprint: string;
    location: { file: string; line: number; column: number } | null;
  };
  exception?: {
    kind: string;
    name: string | null;
    messageNormalized: string;
    fingerprint: string;
    frames: NormalizedFrame[];
  };
  request?: {
    requestKey: string;
    method: string;
    url: NormalizedUrl;
    phase: string;
    resourceType?: string;
    status?: number | null;
    statusClass?: number | null;
    fromServiceWorker?: boolean;
    fromCache?: boolean;
    failureReason?: string | null;
    aborted?: boolean;
    timing?: {
      startDeltaMs: number;
      responseStartDeltaMs?: number | null;
      responseEndDeltaMs?: number | null;
      durationMs?: number | null;
      durationBucket?: string | null;
    } | null;
    sizes?: { requestBodyBytes?: number | null; responseBodyBytes?: number | null } | null;
    requestHeaderNames?: string[];
    responseHeaderNames?: string[];
    finishedInActionId?: string;
  };
  responseBody?: {
    requestEventId: string;
    contentType: string;
    byteLength: number;
    truncatedAtCapture: boolean;
    sha256?: string;
    excerptAvailable: boolean;
  };
  domSnapshot?: {
    snapshotId: string;
    trigger: string;
    nodeCount: number;
    structureHash: string;
  };
  storage?: {
    area: string;
    entries: Array<{
      key: string;
      value: string | null;
      valueShape: { type: string; length: number; sha256Prefix: string } | null;
    }>;
  };
}

export interface ActionWindow {
  actionId: string;
  actionType: string;
  startSeq: number;
  endSeq: number;
  startDeltaMs: number;
  endDeltaMs: number;
  status: string;
  selectorCanonical: string | null;
  failureReason: string | null;
  eventCounts: Partial<Record<EvidenceCategory, number>>;
}

export interface SessionTimeline {
  runId: string;
  events: EvidenceEvent[];
  actions: ActionWindow[];
  /** (category, fingerprint) -> eventIds, for the evidence index. */
  fingerprints: Map<string, string[]>;
  unattributedCount: number;
}

const RAW_TO_CATEGORY: Record<string, EvidenceCategory> = {
  action: "actions",
  navigation: "navigation",
  console: "console",
  exception: "exceptions",
  request: "networkMetadata",
  response: "networkMetadata",
  requestFinished: "networkMetadata",
  requestFailed: "networkMetadata",
  responseBody: "responseBodies",
  domSnapshot: "domSnapshots",
  storage: "storage",
  screenshot: "screenshots",
  video: "video",
  trace: "trace",
  webSocketFrame: "webSocketFrames",
};

/** Half-open windows keyed by action, built from the paired start/end action events. */
function buildActionWindows(events: readonly RawEvent[]): ActionWindow[] {
  const windows = new Map<string, ActionWindow>();
  for (const e of events) {
    if (e.category !== "action") continue;
    const existing = windows.get(e.actionId);
    if (e.phase === "start") {
      windows.set(e.actionId, {
        actionId: e.actionId,
        actionType: e.actionType,
        startSeq: e.seq,
        // Left open until the end event arrives. An action with no end event (interrupted run)
        // stays open to the end of the log, which is the honest reading.
        endSeq: Number.MAX_SAFE_INTEGER,
        startDeltaMs: e.tDeltaMs,
        endDeltaMs: e.tDeltaMs,
        status: "unknown",
        selectorCanonical: e.selectorCanonical ?? null,
        failureReason: null,
        eventCounts: {},
      });
    } else if (existing) {
      existing.endSeq = e.seq;
      existing.endDeltaMs = e.tDeltaMs;
      existing.status = e.status ?? "unknown";
      existing.failureReason = e.failureReason ?? null;
    }
  }
  return [...windows.values()].sort((a, b) => a.startSeq - b.startSeq);
}

function attribute(
  seq: number,
  windows: readonly ActionWindow[]
): { actionId?: string; window: EventWindow } {
  if (!windows.length) return { window: "pre-first-action" };
  const first = windows[0] as ActionWindow;
  if (seq < first.startSeq) return { window: "pre-first-action" };
  for (const w of windows) {
    if (seq >= w.startSeq && seq <= w.endSeq) return { actionId: w.actionId, window: "in-action" };
  }
  return { window: "post-last-action" };
}

function statusClass(status: number | undefined): number | null {
  return status === undefined ? null : Math.floor(status / 100);
}

export interface BuildTimelineOptions {
  runId: string;
  redactor: Redactor;
  /** Artifact ids the collector already registered, keyed by the raw event seq that produced them. */
  artifactIdsBySeq?: Map<number, string[]>;
}

/**
 * Build the normalized timeline. Pure: same raw events plus same policy yields byte-identical
 * output, which `offline_session_reconstruction.spec.ts` asserts.
 */
export function buildTimeline(
  raw: readonly RawEvent[],
  opts: BuildTimelineOptions
): SessionTimeline {
  const { runId, redactor } = opts;
  const sorted = [...raw].sort((a, b) => a.seq - b.seq);
  const windows = buildActionWindows(sorted);

  const events: EvidenceEvent[] = [];
  const fingerprints = new Map<string, string[]>();
  let unattributedCount = 0;
  let eventCounter = 0;

  // requestUid -> the eventId of its `request` phase, so a response body can cite the request.
  const requestPhaseEventId = new Map<string, string>();
  // requestUid -> the action window it STARTED in, so a late finish is attributed correctly.
  const requestStartAction = new Map<string, { actionId?: string; window: EventWindow }>();

  const noteFingerprint = (key: string, id: string): void => {
    const list = fingerprints.get(key) ?? [];
    list.push(id);
    fingerprints.set(key, list);
  };

  for (const e of sorted) {
    const category = RAW_TO_CATEGORY[e.category];
    // collectorNote events are diagnostics for CaptureStatus, not evidence.
    if (!category) continue;

    const id = makeEventId(++eventCounter);
    const attribution = attribute(e.seq, windows);
    if (attribution.window === "in-action" && !attribution.actionId) unattributedCount++;

    const base: EvidenceEvent = {
      schemaVersion: "1.0.0",
      eventId: id,
      runId,
      category,
      seq: e.seq,
      tDeltaMs: e.tDeltaMs,
      tMonoMs: e.tMonoMs,
      tWallMs: e.tWallMs,
      window: attribution.window,
      redaction: redactor.policyStamp(),
    };
    if (attribution.actionId) base.actionId = attribution.actionId;
    const artifactIds = opts.artifactIdsBySeq?.get(e.seq);
    if (artifactIds?.length) base.artifactIds = artifactIds;

    const win = windows.find((w) => w.actionId === attribution.actionId);
    if (win) win.eventCounts[category] = (win.eventCounts[category] ?? 0) + 1;

    switch (e.category) {
      case "action": {
        base.action = {
          actionId: e.actionId,
          type: e.actionType,
          phase: e.phase,
          selectorCanonical: e.selectorCanonical ?? null,
        };
        if (e.status) base.action.status = e.status;
        if (e.failureReason !== undefined) base.action.failureReason = e.failureReason;
        break;
      }

      case "navigation": {
        const u = redactor.redactUrl("navigation.url", e.url);
        base.navigation = {
          kind: e.kind,
          url: {
            origin: u.origin,
            path: u.path,
            pathTemplate: normalizePathTemplate(u.path),
            queryKeys: u.queryKeys,
            query: u.query,
            fragmentPresent: u.fragmentPresent,
            raw: null,
          },
          isMainFrame: e.isMainFrame,
        };
        if (u.redactedKeys.length) {
          base.redactedFields = u.redactedKeys.map((k) => `/navigation/url/query/${k}`);
        }
        break;
      }

      case "console": {
        const outcome = redactor.redactField("console.text", e.text);
        const shownText = outcome.value ?? null;
        // Fingerprint the ORIGINAL text: redaction must not split a defect into two clusters.
        const fp = textFingerprint(e.text);
        base.console = {
          level: e.level,
          text: shownText,
          textNormalized: shownText === null ? null : normalizeMessageText(shownText),
          textFingerprint: fp,
          location:
            e.file !== undefined
              ? { file: e.file, line: e.line ?? 0, column: e.column ?? 0 }
              : null,
        };
        if (outcome.changed) base.redactedFields = ["/console/text"];
        noteFingerprint(`console:${fp}`, id);
        break;
      }

      case "exception": {
        const frames = normalizeStack(e.stack);
        const fp = exceptionFingerprint(e.message, frames);
        const outcome = redactor.redactField("exception.message", e.message);
        base.exception = {
          kind: e.kind,
          name: e.name ?? null,
          messageNormalized: normalizeMessageText(outcome.value ?? e.message),
          fingerprint: fp,
          frames,
        };
        if (outcome.changed) base.redactedFields = ["/exception/messageNormalized"];
        noteFingerprint(`exception:${fp}`, id);
        break;
      }

      case "request":
      case "response":
      case "requestFinished":
      case "requestFailed": {
        const re = e as RawRequestEvent;
        const u = redactor.redactUrl("network.url", re.url);
        const key = requestKey(re.method, u.origin, u.path);
        const durationMs =
          re.timing?.responseEndDeltaMs != null
            ? re.timing.responseEndDeltaMs - re.timing.startDeltaMs
            : null;

        base.request = {
          requestKey: key,
          method: re.method.toUpperCase(),
          url: {
            origin: u.origin,
            path: u.path,
            pathTemplate: normalizePathTemplate(u.path),
            queryKeys: u.queryKeys,
            query: u.query,
            fragmentPresent: u.fragmentPresent,
            raw: null,
          },
          phase: re.category,
          status: re.status ?? null,
          statusClass: statusClass(re.status),
          aborted: re.category === "requestFailed",
          failureReason: re.failureReason ?? null,
          timing: re.timing
            ? {
                startDeltaMs: re.timing.startDeltaMs,
                responseStartDeltaMs: re.timing.responseStartDeltaMs ?? null,
                responseEndDeltaMs: re.timing.responseEndDeltaMs ?? null,
                durationMs,
                durationBucket: durationMs === null ? null : durationBucket(durationMs),
              }
            : null,
          sizes: {
            requestBodyBytes: re.requestBodyBytes ?? null,
            responseBodyBytes: re.responseBodyBytes ?? null,
          },
        };
        if (re.resourceType) base.request.resourceType = re.resourceType;
        if (re.fromServiceWorker !== undefined) base.request.fromServiceWorker = re.fromServiceWorker;
        if (re.fromCache !== undefined) base.request.fromCache = re.fromCache;
        if (re.headerNames) {
          if (re.category === "request") base.request.requestHeaderNames = [...re.headerNames].sort();
          else base.request.responseHeaderNames = [...re.headerNames].sort();
        }
        if (u.redactedKeys.length) {
          base.redactedFields = u.redactedKeys.map((k) => `/request/url/query/${k}`);
        }

        if (re.category === "request") {
          requestPhaseEventId.set(re.requestUid, id);
          requestStartAction.set(re.requestUid, attribution);
          noteFingerprint(`request:${key}`, id);
        } else {
          // Attribution follows the START window, not this event's own position.
          const start = requestStartAction.get(re.requestUid);
          if (start) {
            base.window = start.window;
            if (start.actionId) base.actionId = start.actionId;
            else delete base.actionId;
            // If the request finished in a different window, say so explicitly.
            if (attribution.actionId && attribution.actionId !== start.actionId) {
              base.request.finishedInActionId = attribution.actionId;
            }
          }
        }
        break;
      }

      case "responseBody": {
        const reqEventId = requestPhaseEventId.get(e.requestUid);
        base.responseBody = {
          requestEventId: reqEventId ?? "EV-0000",
          contentType: e.contentType,
          byteLength: e.byteLength,
          truncatedAtCapture: e.truncatedAtCapture,
          excerptAvailable: e.captured && e.excerpt !== undefined,
        };
        if (e.sha256) base.responseBody.sha256 = e.sha256;
        break;
      }

      case "domSnapshot": {
        base.domSnapshot = {
          snapshotId: e.snapshotId,
          trigger: e.trigger,
          nodeCount: e.nodeCount,
          structureHash: e.structureHash,
        };
        noteFingerprint(`dom:${e.structureHash}`, id);
        break;
      }

      case "storage": {
        base.storage = {
          area: e.area,
          entries: e.entries.map((entry) => ({
            key: entry.key,
            value: entry.value ?? null,
            valueShape: entry.valueShape ?? null,
          })),
        };
        break;
      }

      case "screenshot":
      case "video":
      case "trace":
      case "webSocketFrame":
        // Artifact-only categories. artifactIds is already set from artifactIdsBySeq.
        break;
    }

    events.push(base);
  }

  return { runId, events, actions: windows, fingerprints, unattributedCount };
}

/** The queryable projection tools read. Derived, cacheable, rebuildable with no browser. */
export interface EvidenceIndex {
  runId: string;
  byCategory: Map<EvidenceCategory, string[]>;
  byFingerprint: Map<string, string[]>;
  byAction: Map<string, string[]>;
  byEventId: Map<string, EvidenceEvent>;
}

export function buildEvidenceIndex(timeline: SessionTimeline): EvidenceIndex {
  const byCategory = new Map<EvidenceCategory, string[]>();
  const byAction = new Map<string, string[]>();
  const byEventId = new Map<string, EvidenceEvent>();

  for (const e of timeline.events) {
    byEventId.set(e.eventId, e);
    const cat = byCategory.get(e.category) ?? [];
    cat.push(e.eventId);
    byCategory.set(e.category, cat);
    if (e.actionId) {
      const list = byAction.get(e.actionId) ?? [];
      list.push(e.eventId);
      byAction.set(e.actionId, list);
    }
  }

  return {
    runId: timeline.runId,
    byCategory,
    byFingerprint: timeline.fingerprints,
    byAction,
    byEventId,
  };
}
