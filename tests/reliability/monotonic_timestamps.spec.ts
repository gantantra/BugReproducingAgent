import { describe, it, expect, afterEach } from "vitest";
import { searchExperiment } from "@investigator/test-fixtures";
import { parseRawLog } from "@investigator/evidence";
import { createHarness, readNormalized, readRawLog, runExperiment, type Harness } from "./harness.js";

/**
 * Reliability gate test 3 — monotonic timestamps and gap-free ordering.
 *
 * Everything downstream orders and correlates by `seq`, never by timestamp, because timestamps
 * from different sources can tie. This test proves `seq` is total and gap-free, and that both
 * time bases are non-decreasing in `seq` order across ALL categories in one merged stream.
 */

let h: Harness | undefined;
afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

describe("monotonic timestamps", () => {
  it("seq is gap-free and both time bases are non-decreasing across every category", async () => {
    h = await createHarness({ fixtures: ["passing"] });
    const results = await runExperiment(h, searchExperiment("passing"), 5);
    expect(results).toHaveLength(5);

    for (const r of results) {
      const raw = await readRawLog(h, r.runId);
      expect(raw, `no raw log for ${r.runId}`).toBeTruthy();

      const { events, truncatedTail } = parseRawLog(raw!);
      expect(truncatedTail).toBe(false);
      expect(events.length).toBeGreaterThan(0);

      // 1. seq is a gap-free ascending integer sequence starting at 1.
      for (let i = 0; i < events.length; i++) {
        expect(events[i]!.seq, `run ${r.runId} event ${i} seq`).toBe(i + 1);
      }

      // 2, 3, 4. All three time bases non-decreasing in seq order, deltas non-negative.
      let prevMono = -Infinity;
      let prevDelta = -Infinity;
      let prevWall = -Infinity;
      for (const e of events) {
        expect(e.tMonoMs, `run ${r.runId} seq ${e.seq} tMonoMs went backwards`).toBeGreaterThanOrEqual(prevMono);
        expect(e.tDeltaMs, `run ${r.runId} seq ${e.seq} tDeltaMs went backwards`).toBeGreaterThanOrEqual(prevDelta);
        expect(e.tWallMs, `run ${r.runId} seq ${e.seq} tWallMs went backwards`).toBeGreaterThanOrEqual(prevWall);
        expect(e.tDeltaMs).toBeGreaterThanOrEqual(0);
        prevMono = e.tMonoMs;
        prevDelta = e.tDeltaMs;
        prevWall = e.tWallMs;
      }

      // 5. Every action end follows its own start, in both seq and monotonic time.
      const starts = new Map<string, { seq: number; t: number }>();
      for (const e of events) {
        if (e.category !== "action") continue;
        if (e.phase === "start") {
          starts.set(e.actionId, { seq: e.seq, t: e.tMonoMs });
        } else {
          const s = starts.get(e.actionId);
          expect(s, `action ${e.actionId} ended without a start`).toBeTruthy();
          expect(e.seq).toBeGreaterThan(s!.seq);
          expect(e.tMonoMs).toBeGreaterThanOrEqual(s!.t);
        }
      }
      expect(starts.size).toBeGreaterThan(0);
    }
  });

  it("the normalized stream preserves raw seq ordering exactly", async () => {
    h = await createHarness({ fixtures: ["passing"] });
    const [r] = await runExperiment(h, searchExperiment("passing"), 1);

    const raw = await readRawLog(h, r!.runId);
    const normalizedText = await readNormalized(h, r!.runId);
    expect(normalizedText).toBeTruthy();

    const { events: rawEvents } = parseRawLog(raw!);
    const normalized = JSON.parse(normalizedText!) as { events: Array<{ seq: number; eventId: string }> };

    // The plane drops collectorNote events (diagnostics, not evidence), so normalized is a
    // subsequence of raw — but the ORDER must be identical and strictly ascending.
    const rawSeqs = rawEvents.map((e) => e.seq);
    const normSeqs = normalized.events.map((e) => e.seq);

    for (let i = 1; i < normSeqs.length; i++) {
      expect(normSeqs[i]!).toBeGreaterThan(normSeqs[i - 1]!);
    }
    for (const s of normSeqs) expect(rawSeqs).toContain(s);

    // Event ids are assigned in seq order, so they too are monotone.
    const ids = normalized.events.map((e) => Number.parseInt(e.eventId.replace("EV-", ""), 10));
    for (let i = 1; i < ids.length; i++) expect(ids[i]!).toBeGreaterThan(ids[i - 1]!);
  });
});
