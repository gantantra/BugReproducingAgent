import type { JsonPrimitive } from "@investigator/core";

/**
 * The raw append-only event log the collector writes (stage 0), and the normalized event the
 * plane produces (stage 5).
 *
 * `seq` is assigned by a single in-process counter and is total. Everything downstream orders and
 * correlates by `seq`, never by timestamp, because timestamps from different sources can tie
 * (ADR-0007).
 */

export type RawEventCategory =
  | "action"
  | "navigation"
  | "console"
  | "exception"
  | "request"
  | "response"
  | "requestFinished"
  | "requestFailed"
  | "responseBody"
  | "domSnapshot"
  | "storage"
  | "screenshot"
  | "video"
  | "trace"
  | "webSocketFrame"
  | "collectorNote";

export interface RawEventBase {
  seq: number;
  category: RawEventCategory;
  /** Monotonic milliseconds since collector start. Non-decreasing in seq order. */
  tMonoMs: number;
  /** Wall milliseconds from the injected Clock. */
  tWallMs: number;
  /** Delta from run start. Comparison uses this, not absolute time. */
  tDeltaMs: number;
}

export interface RawActionEvent extends RawEventBase {
  category: "action";
  actionId: string;
  actionType: string;
  phase: "start" | "end";
  selectorCanonical?: string | null;
  status?: "ok" | "failed" | "timeout" | "skipped";
  failureReason?: string | null;
}

export interface RawNavigationEvent extends RawEventBase {
  category: "navigation";
  kind: "framenavigated" | "domcontentloaded" | "load" | "popup" | "reload" | "history";
  url: string;
  isMainFrame: boolean;
}

export interface RawConsoleEvent extends RawEventBase {
  category: "console";
  level: string;
  /** Already collection-time redacted where the policy could decide per event. */
  text: string;
  file?: string;
  line?: number;
  column?: number;
}

export interface RawExceptionEvent extends RawEventBase {
  category: "exception";
  kind: "pageerror" | "unhandledrejection";
  name?: string;
  message: string;
  stack?: string;
}

export interface RawRequestEvent extends RawEventBase {
  category: "request" | "response" | "requestFinished" | "requestFailed";
  /** Correlates the four phases of one request. */
  requestUid: string;
  method: string;
  url: string;
  resourceType?: string;
  status?: number;
  fromServiceWorker?: boolean;
  fromCache?: boolean;
  failureReason?: string | null;
  headerNames?: string[];
  headerValues?: Record<string, string>;
  requestBodyBytes?: number | null;
  responseBodyBytes?: number | null;
  timing?: { startDeltaMs: number; responseStartDeltaMs?: number | null; responseEndDeltaMs?: number | null };
}

export interface RawResponseBodyEvent extends RawEventBase {
  category: "responseBody";
  requestUid: string;
  contentType: string;
  byteLength: number;
  truncatedAtCapture: boolean;
  captured: boolean;
  /** Reason a body was not captured, so absence is never confused with emptiness. */
  skipReason?: "SIZE_LIMIT" | "CONTENT_TYPE_NOT_CAPTURED" | "CONFIG_OFF" | "POLICY_REDACTED";
  sha256?: string;
  excerpt?: string;
}

export interface RawDomSnapshotEvent extends RawEventBase {
  category: "domSnapshot";
  snapshotId: string;
  trigger: "action" | "navigation" | "failure" | "manual";
  nodeCount: number;
  structureHash: string;
  artifactId?: string;
  truncated?: boolean;
}

export interface RawStorageEvent extends RawEventBase {
  category: "storage";
  area: "localStorage" | "sessionStorage" | "cookies" | "indexedDb";
  entries: Array<{
    key: string;
    value?: string | null;
    valueShape?: { type: string; length: number; sha256Prefix: string } | null;
    metadata?: Record<string, JsonPrimitive>;
  }>;
}

export interface RawArtifactEvent extends RawEventBase {
  category: "screenshot" | "video" | "trace" | "webSocketFrame";
  artifactId?: string;
  note?: string;
}

export interface RawCollectorNote extends RawEventBase {
  category: "collectorNote";
  /** The capture reason code this note records. */
  code: string;
  /** The evidence category the note is about. Named explicitly so a rebuild can restore it. */
  evidenceCategory: string;
  count?: number;
  limitBytes?: number;
  detail?: string;
}

export type RawEvent =
  | RawActionEvent
  | RawNavigationEvent
  | RawConsoleEvent
  | RawExceptionEvent
  | RawRequestEvent
  | RawResponseBodyEvent
  | RawDomSnapshotEvent
  | RawStorageEvent
  | RawArtifactEvent
  | RawCollectorNote;

/** Serialise as JSON Lines. One event per line, append-only, so a crash truncates at a boundary. */
export function serializeRawLog(events: readonly RawEvent[]): string {
  return events.map((e) => JSON.stringify(e)).join("\n") + (events.length ? "\n" : "");
}

/**
 * Parse a raw log. Tolerates a truncated final line, which is exactly what a killed worker
 * leaves behind, and reports it rather than throwing: an interrupted run still has usable
 * evidence up to the truncation.
 */
export function parseRawLog(text: string): { events: RawEvent[]; truncatedTail: boolean } {
  const lines = text.split("\n");
  const events: RawEvent[] = [];
  let truncatedTail = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line || !line.trim()) continue;
    try {
      events.push(JSON.parse(line) as RawEvent);
    } catch {
      // Only the last line may legitimately be a partial write.
      if (i === lines.length - 1 || lines.slice(i + 1).every((l) => !l || !l.trim())) {
        truncatedTail = true;
      } else {
        throw new Error(`Raw log line ${i + 1} is not valid JSON and is not the final line`);
      }
    }
  }
  return { events, truncatedTail };
}
