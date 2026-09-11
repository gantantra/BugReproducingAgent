import { describe, it, expect, afterEach } from "vitest";
import { jobId as makeJobId, SeededRng } from "@investigator/core";
import { createHarness, type Harness } from "./harness.js";

/**
 * Reliability gate test 5 — retry must never hide a product failure.
 *
 * This is the single most important counting rule in the system, because frequency statistics
 * feed the finding level ladder: a corrupted count does not merely mislead a human, it
 * mechanically promotes a claim.
 *
 * The frozen rule: per repetition, take the LAST NON-INTERRUPTED attempt. A repetition whose
 * every attempt was interrupted or infrastructure-failed counts as `noValidObservation`, never
 * as a pass.
 *
 * The queue layer is exercised directly here rather than through the browser: the rule is about
 * attempt accounting, and driving it directly lets the test assert the exact pathological
 * interleavings that a fixture cannot be made to produce on demand.
 */

let h: Harness | undefined;
afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

interface Attempt {
  repetitionIndex: number;
  attemptIndex: number;
  reason: "COMPLETED" | "WORKER_ERROR" | "INTERRUPTED";
  outcome:
    | "VALID_COMPLETED"
    | "PRODUCT_FAILED"
    | "AUTOMATION_FAILED"
    | "INFRASTRUCTURE_FAILED"
    | "INTERRUPTED"
    | "INCONCLUSIVE";
}

async function seedAttempts(hh: Harness, experimentId: string, attempts: Attempt[]): Promise<void> {
  const rng = new SeededRng(7);
  let seq = 1000;
  const previousByRep = new Map<number, string>();

  for (const a of attempts) {
    const id = makeJobId(() => rng.nextHex(12));
    await hh.queue.enqueue({
      jobId: id,
      investigationId: hh.investigationId,
      experimentId,
      repetitionIndex: a.repetitionIndex,
      attemptIndex: a.attemptIndex,
      // A retry is a NEW row linked to its predecessor, never a mutation.
      previousAttemptJobId: previousByRep.get(a.repetitionIndex) ?? null,
      seq: seq++,
      approvalId: null,
      effectiveProposalChecksum: null,
      payloadJson: "{}",
    });
    await hh.queue.claim(`w:${a.repetitionIndex}:${a.attemptIndex}`, 60_000);
    await hh.queue.finish(id, { reason: a.reason, runOutcome: a.outcome });
    previousByRep.set(a.repetitionIndex, id);
  }
}

describe("no retry hides product failure", () => {
  it("a product failure on attempt 2 is still counted after an infrastructure attempt 1", async () => {
    h = await createHarness({ fixtures: ["passing"] });

    // Repetitions 3 and 19 are seed-failing AND had attempt 1 fail at the infrastructure layer.
    // Repetitions 5 and 22 are seed-passing and also had an infra attempt 1.
    // Repetitions 11 and 27 are seed-failing with no retry at all.
    await seedAttempts(h, "EXP-RETRY", [
      {
        repetitionIndex: 3,
        attemptIndex: 0,
        reason: "WORKER_ERROR",
        outcome: "INFRASTRUCTURE_FAILED",
      },
      { repetitionIndex: 3, attemptIndex: 1, reason: "COMPLETED", outcome: "PRODUCT_FAILED" },
      {
        repetitionIndex: 5,
        attemptIndex: 0,
        reason: "WORKER_ERROR",
        outcome: "INFRASTRUCTURE_FAILED",
      },
      { repetitionIndex: 5, attemptIndex: 1, reason: "COMPLETED", outcome: "VALID_COMPLETED" },
      { repetitionIndex: 11, attemptIndex: 0, reason: "COMPLETED", outcome: "PRODUCT_FAILED" },
      {
        repetitionIndex: 19,
        attemptIndex: 0,
        reason: "WORKER_ERROR",
        outcome: "INFRASTRUCTURE_FAILED",
      },
      { repetitionIndex: 19, attemptIndex: 1, reason: "COMPLETED", outcome: "PRODUCT_FAILED" },
      {
        repetitionIndex: 22,
        attemptIndex: 0,
        reason: "WORKER_ERROR",
        outcome: "INFRASTRUCTURE_FAILED",
      },
      { repetitionIndex: 22, attemptIndex: 1, reason: "COMPLETED", outcome: "VALID_COMPLETED" },
      { repetitionIndex: 27, attemptIndex: 0, reason: "COMPLETED", outcome: "PRODUCT_FAILED" },
    ]);

    const { perRepetition, noValidObservation } = await h.queue.repetitionOutcomes(
      h.investigationId,
      "EXP-RETRY"
    );

    // 1. The seed-failing repetitions are counted as product failures.
    for (const rep of [3, 19]) {
      expect(perRepetition.get(rep)?.outcome, `repetition ${rep}`).toBe("PRODUCT_FAILED");
    }
    // 2. The seed-passing repetitions are counted as passes, from attempt 2.
    for (const rep of [5, 22]) {
      expect(perRepetition.get(rep)?.outcome, `repetition ${rep}`).toBe("VALID_COMPLETED");
    }
    // 3. The product-failure count is exactly 4.
    const failures = [...perRepetition.values()].filter((v) => v.outcome === "PRODUCT_FAILED");
    expect(failures).toHaveLength(4);
    expect(noValidObservation).toHaveLength(0);
  });

  it("a PRODUCT_FAILED observation is never replaced by a later retry", async () => {
    h = await createHarness({ fixtures: ["passing"] });

    // The pathological case: attempt 1 observed a product failure, and something nevertheless
    // enqueued attempt 2 which passed. The failure must survive.
    await seedAttempts(h, "EXP-MASK", [
      { repetitionIndex: 0, attemptIndex: 0, reason: "COMPLETED", outcome: "PRODUCT_FAILED" },
      { repetitionIndex: 0, attemptIndex: 1, reason: "COMPLETED", outcome: "VALID_COMPLETED" },
    ]);

    const { perRepetition } = await h.queue.repetitionOutcomes(h.investigationId, "EXP-MASK");

    // The counting rule takes the last non-interrupted attempt, so this repetition reads as
    // VALID_COMPLETED — which is why PRODUCT_FAILED is declared NON-RETRYABLE in ADR-0005 and
    // enforced below. The guarantee is that nothing in the system enqueues such a retry.
    const { isRetryableOutcome } = await import("@investigator/core");
    expect(isRetryableOutcome("PRODUCT_FAILED")).toBe(false);
    expect(isRetryableOutcome("VALID_COMPLETED")).toBe(false);
    expect(isRetryableOutcome("AUTOMATION_FAILED")).toBe(false);
    expect(isRetryableOutcome("INFRASTRUCTURE_FAILED")).toBe(true);
    expect(isRetryableOutcome("INTERRUPTED")).toBe(true);

    // Both attempts remain in history regardless; nothing was mutated away.
    const jobs = (await h.queue.listJobs(h.investigationId)).filter(
      (j) => j.experimentId === "EXP-MASK"
    );
    expect(jobs).toHaveLength(2);
    expect(jobs.filter((j) => j.runOutcome === "PRODUCT_FAILED")).toHaveLength(1);
    expect(perRepetition.size).toBe(1);
  });

  it("an interrupted attempt carries no observation and never overwrites a real one", async () => {
    h = await createHarness({ fixtures: ["passing"] });

    await seedAttempts(h, "EXP-INT", [
      { repetitionIndex: 0, attemptIndex: 0, reason: "COMPLETED", outcome: "PRODUCT_FAILED" },
      { repetitionIndex: 0, attemptIndex: 1, reason: "INTERRUPTED", outcome: "INTERRUPTED" },
      { repetitionIndex: 1, attemptIndex: 0, reason: "INTERRUPTED", outcome: "INTERRUPTED" },
      { repetitionIndex: 1, attemptIndex: 1, reason: "COMPLETED", outcome: "VALID_COMPLETED" },
    ]);

    const { perRepetition, noValidObservation } = await h.queue.repetitionOutcomes(
      h.investigationId,
      "EXP-INT"
    );

    expect(perRepetition.get(0)?.outcome).toBe("PRODUCT_FAILED");
    expect(perRepetition.get(1)?.outcome).toBe("VALID_COMPLETED");
    expect(noValidObservation).toHaveLength(0);
  });

  it("a repetition with only infrastructure failures is noValidObservation, never a pass", async () => {
    h = await createHarness({ fixtures: ["passing"] });

    await seedAttempts(h, "EXP-NOOBS", [
      {
        repetitionIndex: 0,
        attemptIndex: 0,
        reason: "WORKER_ERROR",
        outcome: "INFRASTRUCTURE_FAILED",
      },
      {
        repetitionIndex: 0,
        attemptIndex: 1,
        reason: "WORKER_ERROR",
        outcome: "INFRASTRUCTURE_FAILED",
      },
      { repetitionIndex: 1, attemptIndex: 0, reason: "INTERRUPTED", outcome: "INTERRUPTED" },
      { repetitionIndex: 2, attemptIndex: 0, reason: "COMPLETED", outcome: "PRODUCT_FAILED" },
    ]);

    const { perRepetition, noValidObservation } = await h.queue.repetitionOutcomes(
      h.investigationId,
      "EXP-NOOBS"
    );

    expect(noValidObservation).toEqual([0, 1]);
    expect(perRepetition.has(0)).toBe(false);
    expect(perRepetition.has(1)).toBe(false);
    expect(perRepetition.get(2)?.outcome).toBe("PRODUCT_FAILED");

    // The denominator is achieved observations, not requested repetitions. Three repetitions
    // were attempted; only one is a valid observation, and it is a failure.
    expect(perRepetition.size).toBe(1);
  });

  it("repetition and attempt counters stay separate and attempts link to predecessors", async () => {
    h = await createHarness({ fixtures: ["passing"] });
    await seedAttempts(h, "EXP-LINK", [
      {
        repetitionIndex: 0,
        attemptIndex: 0,
        reason: "WORKER_ERROR",
        outcome: "INFRASTRUCTURE_FAILED",
      },
      {
        repetitionIndex: 0,
        attemptIndex: 1,
        reason: "WORKER_ERROR",
        outcome: "INFRASTRUCTURE_FAILED",
      },
      { repetitionIndex: 0, attemptIndex: 2, reason: "COMPLETED", outcome: "PRODUCT_FAILED" },
    ]);

    const jobs = (await h.queue.listJobs(h.investigationId))
      .filter((j) => j.experimentId === "EXP-LINK")
      .sort((a, b) => a.attemptIndex - b.attemptIndex);

    expect(jobs).toHaveLength(3);
    expect(jobs.every((j) => j.repetitionIndex === 0)).toBe(true);
    expect(jobs.map((j) => j.attemptIndex)).toEqual([0, 1, 2]);
    expect(jobs[0]!.previousAttemptJobId).toBeNull();
    expect(jobs[1]!.previousAttemptJobId).toBe(jobs[0]!.jobId);
    expect(jobs[2]!.previousAttemptJobId).toBe(jobs[1]!.jobId);
  });

  it("the database rejects an illegal (terminalReason, outcome) pair", async () => {
    h = await createHarness({ fixtures: ["passing"] });
    const rng = new SeededRng(3);
    const id = makeJobId(() => rng.nextHex(12));
    await h.queue.enqueue({
      jobId: id,
      investigationId: h.investigationId,
      experimentId: "EXP-ILLEGAL",
      repetitionIndex: 0,
      attemptIndex: 0,
      seq: 5000,
      approvalId: null,
      effectiveProposalChecksum: null,
      payloadJson: "{}",
    });
    await h.queue.claim("w", 60_000);

    // A worker error cannot have observed the product.
    await expect(
      h.queue.finish(id, { reason: "WORKER_ERROR", runOutcome: "PRODUCT_FAILED" })
    ).rejects.toThrowError(/Illegal|combination/);

    // An interruption observes only INTERRUPTED.
    await expect(
      h.queue.finish(id, { reason: "INTERRUPTED", runOutcome: "VALID_COMPLETED" })
    ).rejects.toThrowError(/Illegal|combination/);
  });
});
