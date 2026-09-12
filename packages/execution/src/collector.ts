import type { BrowserContext, Page, Request, Response, ConsoleMessage } from "playwright";
import type { Clock, EvidenceCategory } from "@investigator/core";
import { sha256Hex } from "@investigator/core";
import type { RawEvent } from "@investigator/evidence";
import type { Redactor } from "@investigator/evidence";

/**
 * Evidence collector (ADR-0007, stage 0).
 *
 * Two properties matter most:
 *
 *  1. ORDERING. Every event gets a `seq` from a single in-process counter, plus a monotonic
 *     `tMonoMs` and a wall `tWallMs` from the injected Clock. Timestamps are non-decreasing in
 *     seq order, which `monotonic_timestamps.spec.ts` asserts.
 *  2. COLLECTION-TIME REDACTION. Rules decidable per event without whole-run context run HERE,
 *     so the highest-risk values (cookie values, auth headers, URL secrets, form input) never
 *     reach a buffer that outlives the event (ADR-0008).
 */

export interface CollectorOptions {
  clock: Clock;
  redactor: Redactor;
  /** Wall time at run start, for tDeltaMs. */
  runStartWallMs: number;
  runStartMonoMs: number;
  capture: {
    responseBodyMaxBytes: number;
    responseBodyContentTypes: string[];
    webSocketFrames: boolean;
    captureBodies: boolean;
  };
  /** Hard ceiling on buffered events. Exceeding it is recorded, never silently dropped. */
  maxEvents?: number;
}

export interface CollectorNote {
  category: EvidenceCategory;
  code:
    | "SIZE_LIMIT"
    | "CONTENT_TYPE_NOT_CAPTURED"
    | "POLICY_REDACTED"
    | "CONFIG_OFF"
    | "COLLECTOR_UNSUPPORTED"
    | "RUN_INTERRUPTED"
    | "PARSE_FAILED"
    | "HASH_MISMATCH"
    | "DROPPED_BACKPRESSURE"
    | "TARGET_DETACHED"
    | "PERSISTED_UNREDACTED"
    | "NO_RECORDING_PRODUCED"
    | "PERSIST_FAILED";
  count?: number;
  limitBytes?: number;
}

/**
 * `Omit` over a discriminated union collapses to the keys common to every member, which would
 * reject every category-specific field. Distribute it so each union member keeps its own shape.
 */
type RawEventInput = RawEvent extends infer T
  ? T extends RawEvent
    ? Omit<T, "seq">
    : never
  : never;

/** Categories whose raw event may carry a content-addressed artifact id. */
const ARTIFACT_CATEGORIES = new Set(["screenshot", "video", "trace", "webSocketFrame"]);

export class Collector {
  private readonly events: RawEvent[] = [];
  private readonly notes: CollectorNote[] = [];
  private seq = 0;
  private requestUids = new WeakMap<Request, string>();
  private requestCounter = 0;
  private detached = false;
  private readonly maxEvents: number;
  private droppedCount = 0;
  private notesFlushed = false;

  constructor(private readonly opts: CollectorOptions) {
    this.maxEvents = opts.maxEvents ?? 200_000;
  }

  /**
   * Timestamps only. `seq` is deliberately NOT allocated here: an async collector path can
   * construct an event, await, and push later, and allocating early would leave the persisted
   * log out of seq order. Ordering is the whole point of seq, so it is assigned at push time.
   */
  private now(): { tMonoMs: number; tWallMs: number; tDeltaMs: number } {
    const mono = this.opts.clock.monotonicMs();
    const wall = this.opts.clock.nowMs();
    return {
      tMonoMs: mono,
      tWallMs: wall,
      // Monotonic delta, so a wall-clock adjustment mid-run cannot produce a negative duration.
      tDeltaMs: Math.max(0, mono - this.opts.runStartMonoMs),
    };
  }

  /** Assigns seq and appends. Returns the assigned seq, or -1 if dropped under backpressure. */
  private push(event: RawEventInput, opts: { bypassCeiling?: boolean } = {}): number {
    if (!opts.bypassCeiling && this.events.length >= this.maxEvents) {
      // Backpressure is recorded as a capture limitation, so downstream reasoning sees the gap
      // rather than inferring the events never happened.
      this.droppedCount++;
      return -1;
    }
    const seq = ++this.seq;
    this.events.push({ ...event, seq } as RawEvent);
    return seq;
  }

  /**
   * Bind an artifact id to an already-buffered event.
   *
   * The artifact store is content-addressed, so the id only exists AFTER the bytes are written,
   * which is necessarily after the event that describes them was pushed. The raw log is not
   * durable until it is serialised, so late binding is sound — and it is required: without it the
   * seq -> artifact association lives only in process memory and a rebuild from persisted
   * artifacts alone silently loses `artifactIds` (ADR-0007 byte-identical rebuild).
   *
   * A dropped event (seq -1 under backpressure) has nothing to bind to; that is already recorded
   * as a capture limitation, so this is a no-op rather than an error.
   */
  attachArtifact(seq: number, artifactId: string): void {
    if (seq < 0) return;
    // seq is only incremented on a successful append, so this is a direct index; the find is a
    // fallback so a future change to push() degrades to slow rather than to silently wrong.
    const direct = this.events[seq - 1];
    const event = direct?.seq === seq ? direct : this.events.find((e) => e.seq === seq);
    if (!event) return;
    if (event.category === "domSnapshot" || ARTIFACT_CATEGORIES.has(event.category)) {
      (event as { artifactId?: string }).artifactId = artifactId;
    }
  }

  note(note: CollectorNote): void {
    const existing = this.notes.find((n) => n.category === note.category && n.code === note.code);
    if (existing) {
      existing.count = (existing.count ?? 1) + (note.count ?? 1);
      return;
    }
    this.notes.push({ ...note, count: note.count ?? 1 });
  }

  /** Called by the interpreter around each action, so actions form the timeline spine. */
  actionStart(actionId: string, actionType: string, selectorCanonical: string | null): void {
    this.push({
      ...this.now(),
      category: "action",
      actionId,
      actionType,
      phase: "start",
      selectorCanonical,
    });
  }

  actionEnd(
    actionId: string,
    actionType: string,
    status: "ok" | "failed" | "timeout" | "skipped",
    failureReason: string | null
  ): void {
    this.push({
      ...this.now(),
      category: "action",
      actionId,
      actionType,
      phase: "end",
      status,
      failureReason,
    });
  }

  domSnapshot(args: {
    snapshotId: string;
    trigger: "action" | "navigation" | "failure" | "manual";
    nodeCount: number;
    structureHash: string;
    truncated?: boolean;
  }): number {
    return this.push({ ...this.now(), category: "domSnapshot", ...args });
  }

  storageSnapshot(
    area: "localStorage" | "sessionStorage" | "cookies" | "indexedDb",
    entries: Array<{
      key: string;
      rawValue: string | null;
      metadata?: Record<string, string | number | boolean | null>;
    }>
  ): void {
    const scope =
      area === "cookies"
        ? "storage.cookies"
        : area === "indexedDb"
          ? "storage.indexedDb"
          : area === "localStorage"
            ? "storage.localStorage"
            : "storage.sessionStorage";

    const redacted = entries.map((e) => {
      const outcome = this.opts.redactor.redactField(scope, e.rawValue, { key: e.key });
      return {
        key: e.key,
        value: outcome.value ?? null,
        valueShape: outcome.shape ?? null,
        ...(e.metadata ? { metadata: e.metadata } : {}),
      };
    });
    if (redacted.some((r) => r.value === null || r.valueShape !== null)) {
      this.note({ category: "storage", code: "POLICY_REDACTED" });
    }
    this.push({ ...this.now(), category: "storage", area, entries: redacted });
  }

  artifact(
    category: "screenshot" | "video" | "trace" | "webSocketFrame",
    artifactId?: string,
    noteText?: string
  ): number {
    return this.push({
      ...this.now(),
      category,
      ...(artifactId ? { artifactId } : {}),
      ...(noteText ? { note: noteText } : {}),
    });
  }

  /** Subscribe to a context and page. Returns a detach function for the run `finally` block. */
  attach(context: BrowserContext, page: Page): () => void {
    const onConsole = (msg: ConsoleMessage): void => {
      const loc = msg.location();
      // Console text can contain anything the page chose to print, so it goes through the
      // redactor before it is buffered.
      const outcome = this.opts.redactor.redactField("console.text", msg.text());
      this.push({
        ...this.now(),
        category: "console",
        level: msg.type(),
        text: outcome.value ?? "[redacted]",
        file: loc.url,
        line: loc.lineNumber,
        column: loc.columnNumber,
      });
    };

    const onPageError = (err: Error): void => {
      const outcome = this.opts.redactor.redactField("exception.message", err.message);
      this.push({
        ...this.now(),
        category: "exception",
        kind: "pageerror",
        name: err.name,
        message: outcome.value ?? "[redacted]",
        ...(err.stack ? { stack: err.stack } : {}),
      });
    };

    const uidFor = (req: Request): string => {
      let uid = this.requestUids.get(req);
      if (!uid) {
        uid = `r${++this.requestCounter}`;
        this.requestUids.set(req, uid);
      }
      return uid;
    };

    const onRequest = (req: Request): void => {
      const t = this.now();
      const headers = req.headers();
      const { headerNames, values } = this.opts.redactor.redactHeaders(
        "network.requestHeaders",
        headers
      );
      this.push({
        ...t,
        category: "request",
        requestUid: uidFor(req),
        method: req.method(),
        url: this.opts.redactor.redactUrlString("network.url", req.url()),
        resourceType: req.resourceType(),
        headerNames,
        headerValues: values,
        requestBodyBytes: req.postDataBuffer()?.byteLength ?? null,
        timing: { startDeltaMs: t.tDeltaMs },
      });
    };

    const onResponse = (res: Response): void => {
      const t = this.now();
      const req = res.request();
      const headers = res.headers();
      const { headerNames, values } = this.opts.redactor.redactHeaders(
        "network.responseHeaders",
        headers
      );
      this.push({
        ...t,
        category: "response",
        requestUid: uidFor(req),
        method: req.method(),
        url: this.opts.redactor.redactUrlString("network.url", req.url()),
        status: res.status(),
        fromServiceWorker: res.fromServiceWorker(),
        headerNames,
        headerValues: values,
        timing: { startDeltaMs: t.tDeltaMs, responseStartDeltaMs: t.tDeltaMs },
      });
      void this.maybeCaptureBody(res, uidFor(req));
    };

    const onRequestFinished = (req: Request): void => {
      const t = this.now();
      this.push({
        ...t,
        category: "requestFinished",
        requestUid: uidFor(req),
        method: req.method(),
        url: this.opts.redactor.redactUrlString("network.url", req.url()),
        timing: { startDeltaMs: t.tDeltaMs, responseEndDeltaMs: t.tDeltaMs },
      });
    };

    const onRequestFailed = (req: Request): void => {
      const t = this.now();
      this.push({
        ...t,
        category: "requestFailed",
        requestUid: uidFor(req),
        method: req.method(),
        url: this.opts.redactor.redactUrlString("network.url", req.url()),
        failureReason: req.failure()?.errorText ?? "unknown",
        timing: { startDeltaMs: t.tDeltaMs },
      });
    };

    const onFrameNavigated = (): void => {
      this.push({
        ...this.now(),
        category: "navigation",
        kind: "framenavigated",
        url: this.opts.redactor.redactUrlString("navigation.url", page.url()),
        isMainFrame: true,
      });
    };

    const onDomContentLoaded = (): void => {
      this.push({
        ...this.now(),
        category: "navigation",
        kind: "domcontentloaded",
        url: this.opts.redactor.redactUrlString("navigation.url", page.url()),
        isMainFrame: true,
      });
    };

    const onLoad = (): void => {
      this.push({
        ...this.now(),
        category: "navigation",
        kind: "load",
        url: this.opts.redactor.redactUrlString("navigation.url", page.url()),
        isMainFrame: true,
      });
    };

    const onClose = (): void => {
      this.detached = true;
    };

    page.on("console", onConsole);
    page.on("pageerror", onPageError);
    page.on("domcontentloaded", onDomContentLoaded);
    page.on("load", onLoad);
    page.on("framenavigated", onFrameNavigated);
    page.on("close", onClose);
    context.on("request", onRequest);
    context.on("response", onResponse);
    context.on("requestfinished", onRequestFinished);
    context.on("requestfailed", onRequestFailed);

    if (!this.opts.capture.webSocketFrames) {
      // Recorded as an explicit capability gap rather than an absent key (ADR-0016).
      this.note({ category: "webSocketFrames", code: "COLLECTOR_UNSUPPORTED" });
    }

    return () => {
      page.off("console", onConsole);
      page.off("pageerror", onPageError);
      page.off("domcontentloaded", onDomContentLoaded);
      page.off("load", onLoad);
      page.off("framenavigated", onFrameNavigated);
      page.off("close", onClose);
      context.off("request", onRequest);
      context.off("response", onResponse);
      context.off("requestfinished", onRequestFinished);
      context.off("requestfailed", onRequestFailed);
    };
  }

  /**
   * Response bodies are the highest-volume and highest-risk category, so they are opt-in by
   * content type AND size-capped, and every skip records WHY. Absence is never confused with
   * emptiness.
   */
  private async maybeCaptureBody(res: Response, requestUid: string): Promise<void> {
    const contentType = (res.headers()["content-type"] ?? "").split(";")[0]?.trim() ?? "";

    if (!this.opts.capture.captureBodies) {
      this.push({
        ...this.now(),
        category: "responseBody",
        requestUid,
        contentType,
        byteLength: 0,
        truncatedAtCapture: false,
        captured: false,
        skipReason: "CONFIG_OFF",
      });
      this.note({ category: "responseBodies", code: "CONFIG_OFF" });
      return;
    }

    if (!this.opts.capture.responseBodyContentTypes.some((c) => contentType.startsWith(c))) {
      this.push({
        ...this.now(),
        category: "responseBody",
        requestUid,
        contentType,
        byteLength: 0,
        truncatedAtCapture: false,
        captured: false,
        skipReason: "CONTENT_TYPE_NOT_CAPTURED",
      });
      this.note({ category: "responseBodies", code: "CONTENT_TYPE_NOT_CAPTURED" });
      return;
    }

    let buf: Buffer;
    try {
      buf = await res.body();
    } catch {
      // A body can be unavailable for legitimate reasons (redirect, aborted, served from cache).
      this.push({
        ...this.now(),
        category: "responseBody",
        requestUid,
        contentType,
        byteLength: 0,
        truncatedAtCapture: false,
        captured: false,
        skipReason: "CONFIG_OFF",
      });
      return;
    }

    const overLimit = buf.byteLength > this.opts.capture.responseBodyMaxBytes;
    if (overLimit) {
      this.note({
        category: "responseBodies",
        code: "SIZE_LIMIT",
        limitBytes: this.opts.capture.responseBodyMaxBytes,
      });
    }

    const sliced = overLimit ? buf.subarray(0, this.opts.capture.responseBodyMaxBytes) : buf;
    const text = sliced.toString("utf8");
    const outcome = this.opts.redactor.redactField("network.responseBody", text, {
      contentType,
      optIns: new Set(["captureBodies"]),
    });
    if (outcome.value === undefined) {
      this.note({ category: "responseBodies", code: "POLICY_REDACTED" });
    }

    this.push({
      ...this.now(),
      category: "responseBody",
      requestUid,
      contentType,
      byteLength: buf.byteLength,
      truncatedAtCapture: overLimit,
      captured: outcome.value !== undefined,
      sha256: sha256Hex(buf),
      ...(outcome.value !== undefined ? { excerpt: outcome.value } : {}),
    });
    // Release the buffer reference promptly. Raw bodies live only in bounded process memory.
    buf = Buffer.alloc(0);
  }

  /**
   * Write accumulated notes into the raw log as `collectorNote` events.
   *
   * Must be called BEFORE the log is serialised. Without this the notes exist only in process
   * memory, and a rebuild from persisted artifacts alone cannot reproduce CaptureStatus — which
   * is precisely the property ADR-0007 requires and `offline_session_reconstruction` asserts.
   */
  flushNotesToLog(): void {
    if (this.notesFlushed) return;
    this.notesFlushed = true;
    if (this.droppedCount > 0) {
      this.note({ category: "console", code: "DROPPED_BACKPRESSURE", count: this.droppedCount });
    }
    if (this.detached) {
      this.note({ category: "domSnapshots", code: "TARGET_DETACHED" });
    }
    for (const n of this.notes) {
      this.push(
        {
          ...this.now(),
          category: "collectorNote",
          code: n.code,
          evidenceCategory: n.category,
          ...(n.count !== undefined ? { count: n.count } : {}),
          ...(n.limitBytes !== undefined ? { limitBytes: n.limitBytes } : {}),
        },
        // Notes bypass the event ceiling deliberately. A run that hit the ceiling is exactly the
        // run whose limitation MUST be recorded, and pushing the note through the ceiling check
        // meant the DROPPED_BACKPRESSURE note was itself dropped -- leaving the gap invisible to
        // an offline rebuild, which is the property ADR-0007 requires. Notes are deduplicated by
        // (category, code), so their number is bounded by the taxonomy, not by traffic.
        { bypassCeiling: true }
      );
    }
  }

  targetDetached(): boolean {
    return this.detached;
  }

  finalizeNotes(): CollectorNote[] {
    this.flushNotesToLog();
    return this.notes.slice();
  }

  getEvents(): readonly RawEvent[] {
    return this.events;
  }

  eventCount(): number {
    return this.events.length;
  }
}
