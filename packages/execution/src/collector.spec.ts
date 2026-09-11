import { describe, it, expect } from "vitest";
import type { Redactor } from "@investigator/evidence";
import { Collector } from "./collector.js";

/**
 * Fast feedback for the raw-log completeness property.
 *
 * `offline_session_reconstruction` already asserts this end to end, but it takes minutes and
 * needs a browser. The defect it caught — the seq -> artifactId association living only in
 * process memory, so a rebuild from persisted artifacts silently lost every `artifactIds`
 * reference — is cheap to pin at this level, so it is pinned here too.
 *
 * The Redactor is a type-only import and a stub: `execution` must not depend on `evidence` at
 * runtime (ADR-0006 layering), and none of the paths under test consult the redactor anyway.
 */

const NO_REDACTION = {
  redactField: () => ({ value: undefined, shape: null }),
  resetCounters: () => {},
} as unknown as Redactor;

function collector(): Collector {
  return new Collector({
    clock: {
      nowMs: () => 1_700_000_000_000,
      nowIso: () => "2026-09-11T00:00:00.000Z",
      monotonicMs: () => 0,
    },
    redactor: NO_REDACTION,
    runStartWallMs: 1_700_000_000_000,
    runStartMonoMs: 0,
    capture: {
      responseBodyMaxBytes: 1024,
      responseBodyContentTypes: ["application/json"],
      webSocketFrames: false,
      captureBodies: false,
    },
  });
}

describe("collector artifact binding", () => {
  it("binds an artifact id onto the dom snapshot event that produced it", () => {
    const c = collector();
    const seq = c.domSnapshot({
      snapshotId: "S1",
      trigger: "action",
      nodeCount: 3,
      structureHash: "abc",
    });

    c.attachArtifact(seq, "DOM-001-deadbeef");

    const event = c.getEvents().find((e) => e.seq === seq);
    expect(event).toBeDefined();
    expect((event as { artifactId?: string }).artifactId).toBe("DOM-001-deadbeef");
  });

  it("binds an artifact id onto a screenshot event", () => {
    const c = collector();
    const seq = c.artifact("screenshot");

    c.attachArtifact(seq, "SHOT-001-cafe");

    expect((c.getEvents().find((e) => e.seq === seq) as { artifactId?: string }).artifactId).toBe(
      "SHOT-001-cafe"
    );
  });

  it("binds the id to the correct event when later events follow", () => {
    const c = collector();
    const first = c.domSnapshot({
      snapshotId: "S1",
      trigger: "action",
      nodeCount: 1,
      structureHash: "a",
    });
    const second = c.domSnapshot({
      snapshotId: "S2",
      trigger: "navigation",
      nodeCount: 2,
      structureHash: "b",
    });
    c.artifact("screenshot");

    c.attachArtifact(first, "DOM-001-aaaa");
    c.attachArtifact(second, "DOM-002-bbbb");

    const bySeq = new Map(c.getEvents().map((e) => [e.seq, e as { artifactId?: string }]));
    expect(bySeq.get(first)?.artifactId).toBe("DOM-001-aaaa");
    expect(bySeq.get(second)?.artifactId).toBe("DOM-002-bbbb");
  });

  it("is a no-op for a dropped event rather than throwing or mislabelling another event", () => {
    const c = collector();
    const kept = c.domSnapshot({
      snapshotId: "S1",
      trigger: "action",
      nodeCount: 1,
      structureHash: "a",
    });

    // -1 is what push() returns under backpressure. That gap is already recorded as a capture
    // limitation, so there is nothing to bind and nothing to fail.
    expect(() => c.attachArtifact(-1, "DOM-999-nope")).not.toThrow();

    const ids = c.getEvents().map((e) => (e as { artifactId?: string }).artifactId);
    expect(ids.filter((v) => v === "DOM-999-nope")).toHaveLength(0);
    expect(
      (c.getEvents().find((e) => e.seq === kept) as { artifactId?: string }).artifactId
    ).toBeUndefined();
  });

  it("survives serialisation, which is what makes an offline rebuild faithful", () => {
    const c = collector();
    const seq = c.domSnapshot({
      snapshotId: "S1",
      trigger: "action",
      nodeCount: 1,
      structureHash: "a",
    });
    c.attachArtifact(seq, "DOM-001-abcd");

    // The raw log is JSONL. Round-trip it the way the plane will read it back.
    const line = c
      .getEvents()
      .map((e) => JSON.stringify(e))
      .join("\n");
    const parsed = line
      .split("\n")
      .map((l) => JSON.parse(l) as { seq: number; artifactId?: string });

    expect(parsed.find((e) => e.seq === seq)?.artifactId).toBe("DOM-001-abcd");
  });
});

describe("collector backpressure", () => {
  it("records DROPPED_BACKPRESSURE with the dropped count instead of silently discarding", () => {
    // maxEvents is the hard ceiling. Exceeding it must be VISIBLE: an evidence gap that is not
    // reported is indistinguishable downstream from "the events never happened", which is the
    // failure mode ADR-0016 exists to prevent.
    const c = new Collector({
      clock: {
        nowMs: () => 1_700_000_000_000,
        nowIso: () => "2026-09-11T00:00:00.000Z",
        monotonicMs: () => 0,
      },
      redactor: NO_REDACTION,
      runStartWallMs: 1_700_000_000_000,
      runStartMonoMs: 0,
      capture: {
        responseBodyMaxBytes: 1024,
        responseBodyContentTypes: [],
        webSocketFrames: false,
        captureBodies: false,
      },
      maxEvents: 3,
    });

    const seqs = [1, 2, 3, 4, 5].map((i) =>
      c.domSnapshot({ snapshotId: `S${i}`, trigger: "action", nodeCount: 1, structureHash: "a" })
    );

    // The first three are accepted; the rest are refused with -1 rather than appended.
    expect(seqs.slice(0, 3).every((s) => s > 0)).toBe(true);
    expect(seqs.slice(3)).toEqual([-1, -1]);

    const notes = c.finalizeNotes();
    const dropped = notes.find((n) => n.code === "DROPPED_BACKPRESSURE");
    expect(dropped, "backpressure must be reported as a capture limitation").toBeDefined();
    expect(dropped?.count).toBe(2);

    // And it must reach the raw log, so an offline rebuild sees the same gap (ADR-0007).
    const logged = c.getEvents().filter((e) => e.category === "collectorNote");
    expect(logged.some((e) => (e as { code?: string }).code === "DROPPED_BACKPRESSURE")).toBe(true);
  });
});
