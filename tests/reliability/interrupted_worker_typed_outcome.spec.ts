import { describe, it, expect, afterEach } from "vitest";
import { jobId as makeJobId, SeededRng, systemClock } from "@investigator/core";
import { SqliteWorkQueue } from "@investigator/storage";
import { searchExperiment } from "@investigator/test-fixtures";
import { createHarness, runExperiment, type Harness } from "./harness.js";

/**
 * Reliability gate test 8 — an interrupted worker produces a typed outcome.
 *
 * A stale lease becomes TERMINAL/INTERRUPTED/INTERRUPTED, and is NEVER auto-requeued: re-running
 * is a decision a human or an orchestrating command makes, and it is recorded (ADR-0003).
 *
 * The kill is modelled by letting a lease expire rather than by killing a real OS process. That
 * is the same state a SIGKILL leaves behind — a claimed job whose worker never reports again —
 * and it is deterministic on both Windows and Linux, which a real kill is not.
 */

let h: Harness | undefined;
afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

describe("interrupted worker typed outcome", () => {
  it("a stale lease is reaped to TERMINAL/INTERRUPTED/INTERRUPTED", async () => {
    // Very short lease so expiry is immediate and no sleep is needed.
    h = await createHarness({ fixtures: ["passing"], leaseMs: 1000, heartbeatMs: 300 });

    const rng = new SeededRng(11);
    const id = makeJobId(() => rng.nextHex(12));
    await h.queue.enqueue({
      jobId: id,
      investigationId: h.investigationId,
      experimentId: "EXP-KILL",
      repetitionIndex: 0,
      attemptIndex: 0,
      seq: 1,
      approvalId: null,
      effectiveProposalChecksum: null,
      payloadJson: "{}",
    });

    const claimed = await h.queue.claim("doomed-worker", 1000);
    expect(claimed).toBeTruthy();
    await h.queue.markRunning(id, "doomed-worker", "RUN-900");

    let job = await h.queue.getJob(id);
    expect(job?.state).toBe("RUNNING");

    // Reap with a clock far past the lease: exactly the state a killed worker leaves.
    const result = await h.queue.reapStale(systemClock.nowMs() + 10_000);

    expect(result.reaped.map((r) => r.jobId)).toContain(id);
    job = await h.queue.getJob(id);
    expect(job?.state).toBe("TERMINAL");
    expect(job?.terminalReason).toBe("INTERRUPTED");
    expect(job?.runOutcome).toBe("INTERRUPTED");
    expect(job?.leaseExpiresAt).toBeNull();
    expect(job?.finishedAt).toBeTruthy();
    // The run id the worker had claimed is preserved, so partial evidence stays attributable.
    expect(job?.runId).toBe("RUN-900");
  });

  it("reaping never enqueues a replacement", async () => {
    h = await createHarness({ fixtures: ["passing"], leaseMs: 1000, heartbeatMs: 300 });

    const rng = new SeededRng(12);
    const id = makeJobId(() => rng.nextHex(12));
    await h.queue.enqueue({
      jobId: id,
      investigationId: h.investigationId,
      experimentId: "EXP-NOREQUEUE",
      repetitionIndex: 0,
      attemptIndex: 0,
      seq: 1,
      approvalId: null,
      effectiveProposalChecksum: null,
      payloadJson: "{}",
    });
    await h.queue.claim("doomed", 1000);

    const before = await h.queue.listJobs(h.investigationId);
    await h.queue.reapStale(systemClock.nowMs() + 10_000);
    const after = await h.queue.listJobs(h.investigationId);

    // Same rows, no new PENDING work. "Stale jobs are never silently re-run."
    expect(after).toHaveLength(before.length);
    expect(after.filter((j) => j.state === "PENDING")).toHaveLength(0);

    const stats = await h.queue.stats(h.investigationId);
    expect(stats.pending).toBe(0);
    expect(stats.byOutcome["INTERRUPTED"]).toBe(1);
  });

  it("a reaped job releases its lease so a later worker is not blocked", async () => {
    h = await createHarness({ fixtures: ["passing"], leaseMs: 1000, heartbeatMs: 300 });
    const rng = new SeededRng(13);

    const stale = makeJobId(() => rng.nextHex(12));
    await h.queue.enqueue({
      jobId: stale,
      investigationId: h.investigationId,
      experimentId: "EXP-A",
      repetitionIndex: 0,
      attemptIndex: 0,
      seq: 1,
      approvalId: null,
      effectiveProposalChecksum: null,
      payloadJson: "{}",
    });
    await h.queue.claim("doomed", 1000);
    await h.queue.reapStale(systemClock.nowMs() + 10_000);

    // A brand-new job is still claimable: no poisoned state, no stuck lock.
    const fresh = makeJobId(() => rng.nextHex(12));
    await h.queue.enqueue({
      jobId: fresh,
      investigationId: h.investigationId,
      experimentId: "EXP-B",
      repetitionIndex: 0,
      attemptIndex: 0,
      seq: 2,
      approvalId: null,
      effectiveProposalChecksum: null,
      payloadJson: "{}",
    });
    const claimed = await h.queue.claim("healthy", 60_000);
    expect(claimed?.jobId).toBe(fresh);
  });

  it("heartbeat after a reap fails loudly, so a zombie worker stops writing", async () => {
    h = await createHarness({ fixtures: ["passing"], leaseMs: 1000, heartbeatMs: 300 });
    const rng = new SeededRng(14);
    const id = makeJobId(() => rng.nextHex(12));
    await h.queue.enqueue({
      jobId: id,
      investigationId: h.investigationId,
      experimentId: "EXP-ZOMBIE",
      repetitionIndex: 0,
      attemptIndex: 0,
      seq: 1,
      approvalId: null,
      effectiveProposalChecksum: null,
      payloadJson: "{}",
    });
    await h.queue.claim("zombie", 1000);
    await h.queue.reapStale(systemClock.nowMs() + 10_000);

    await expect(h.queue.heartbeat(id, "zombie", 60_000)).rejects.toThrowError(
      /Lease lost|no longer held/
    );
  });

  it("TERMINAL is absorbing: finishing an already-terminal job is refused", async () => {
    h = await createHarness({ fixtures: ["passing"], leaseMs: 1000, heartbeatMs: 300 });
    const rng = new SeededRng(15);
    const id = makeJobId(() => rng.nextHex(12));
    await h.queue.enqueue({
      jobId: id,
      investigationId: h.investigationId,
      experimentId: "EXP-ABSORB",
      repetitionIndex: 0,
      attemptIndex: 0,
      seq: 1,
      approvalId: null,
      effectiveProposalChecksum: null,
      payloadJson: "{}",
    });
    await h.queue.claim("w", 1000);
    await h.queue.reapStale(systemClock.nowMs() + 10_000);

    await expect(
      h.queue.finish(id, { reason: "COMPLETED", runOutcome: "VALID_COMPLETED" })
    ).rejects.toThrowError(/already TERMINAL|absorbing/);
  });

  it("a worker reaps stale work before its first claim, then proceeds normally", async () => {
    h = await createHarness({ fixtures: ["passing"], leaseMs: 1000, heartbeatMs: 300 });

    // Leave a stale claimed job behind, as a crashed predecessor would.
    const rng = new SeededRng(16);
    const orphan = makeJobId(() => rng.nextHex(12));
    await h.queue.enqueue({
      jobId: orphan,
      investigationId: h.investigationId,
      experimentId: "EXP-ORPHAN",
      repetitionIndex: 0,
      attemptIndex: 0,
      seq: 1,
      approvalId: null,
      effectiveProposalChecksum: null,
      payloadJson: "{}",
    });
    const staleQueue = new SqliteWorkQueue({ store: h.metadata, clock: systemClock });
    await staleQueue.claim("crashed-predecessor", 1);

    // A normal run in the same workspace succeeds, and the orphan is classified, not ignored.
    const results = await runExperiment(h, searchExperiment("passing"), 1);
    expect(results).toHaveLength(1);
    expect(results[0]!.outcome).toBe("VALID_COMPLETED");

    const orphanJob = await h.queue.getJob(orphan);
    expect(orphanJob?.state).toBe("TERMINAL");
    expect(orphanJob?.runOutcome).toBe("INTERRUPTED");
  });
});
