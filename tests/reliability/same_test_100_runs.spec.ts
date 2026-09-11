import { describe, it, expect, afterEach } from "vitest";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { searchExperiment } from "@investigator/test-fixtures";
import { createHarness, readManifests, runExperiment, type Harness } from "./harness.js";

/**
 * Reliability gate test 1 — the performance fixture (frozen decision 3).
 *
 * 100 SEQUENTIAL runs of the four-action sequence, with the agreed budget:
 *   - 100/100 VALID_COMPLETED
 *   - total wall clock < 600s
 *   - p95 per-run < 8s, max < 20s
 *   - workspace disk growth < 1.5 GB
 *   - no required category worse than `complete`
 *
 * If the runner class cannot meet the budget, the BUDGET is renegotiated in writing in
 * docs/FREEZE-M0.md. It is never quietly relaxed to make CI green.
 *
 * ZERO RETRIES IS PART OF THE CRITERION (docs/m0-decisions.md, decision 3). An earlier version of
 * this file asserted only that retries were "bounded and linked", reasoning that demanding zero
 * retries asserts the environment never hiccups. That reasoning was rejected: this fixture is a
 * deterministic local app driven by a seeded experiment, so an infrastructure failure here is a
 * defect in this system until proven otherwise, not weather. The relaxed version also passed while
 * printing "4 infrastructure retries occurred", which is precisely the false green a gate exists to
 * prevent.
 *
 * The run count is fixed at 100 and deliberately NOT configurable. Meeting this criterion by
 * lowering the repetition count through an environment variable is explicitly disallowed.
 */

const REQUESTED = 100;
const WALL_CLOCK_BUDGET_MS = 600_000;
const P95_BUDGET_MS = 8_000;
const MAX_RUN_BUDGET_MS = 20_000;
const DISK_BUDGET_BYTES = 1.5 * 1024 * 1024 * 1024;

function dirSize(dir: string): number {
  let total = 0;
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const s = statSync(p);
    total += s.isDirectory() ? dirSize(p) : s.size;
  }
  return total;
}

function percentile(sortedAsc: number[], p: number): number {
  if (!sortedAsc.length) return 0;
  const idx = Math.min(
    sortedAsc.length - 1,
    Math.max(0, Math.ceil((p / 100) * sortedAsc.length) - 1)
  );
  return sortedAsc[idx]!;
}

let h: Harness | undefined;
afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

describe("same test, 100 sequential runs", () => {
  it(
    `completes ${REQUESTED} sequential runs within the agreed budget with complete evidence`,
    async () => {
      // The performance fixture: passing app, 4 actions, video and trace as configured,
      // DOM snapshots on action boundaries, response bodies off.
      h = await createHarness({
        fixtures: ["passing"],
        video: "off",
        tracePolicy: "withhold",
        domSnapshotOn: ["action"],
        screenshotOn: ["failure"],
      });

      const startBytes = dirSize(h.workspace.root);
      const startedAt = Date.now();
      const results = await runExperiment(h, searchExperiment("passing"), REQUESTED);
      const wallClockMs = Date.now() - startedAt;
      const grewBytes = dirSize(h.workspace.root) - startBytes;

      // 1 and 2. Every repetition produced a valid observation, on its FIRST attempt.
      const { perRepetition, noValidObservation } = await h.queue.repetitionOutcomes(
        h.investigationId
      );
      expect(noValidObservation, "repetitions with no valid observation").toEqual([]);
      expect(perRepetition.size).toBe(REQUESTED);
      for (const [rep, entry] of perRepetition) {
        expect(entry.outcome, `repetition ${rep}`).toBe("VALID_COMPLETED");
      }

      const jobs = await h.queue.listJobs(h.investigationId);
      const manifests = await readManifests(h);

      // Diagnosis FIRST, so a failure names its cause and not only its count. Reasons come from
      // the sealed manifests' outcomeDetail, which is already redacted before persistence.
      const detailByRunId = new Map(
        manifests.map((m) => [m["runId"] as string, String(m["outcomeDetail"] ?? "")])
      );
      const diagnosis = jobs
        .filter((j) => j.runOutcome !== "VALID_COMPLETED" || j.attemptIndex > 0)
        .map(
          (j) =>
            `  rep ${j.repetitionIndex} attempt ${j.attemptIndex}: ${j.runOutcome} :: ` +
            `${detailByRunId.get(j.runId ?? "") || "(no manifest detail)"}`
        )
        .join("\n");

      expect(jobs.every((j) => j.state === "TERMINAL")).toBe(true);

      // 8. Zero of every failure outcome. A deterministic local fixture driven by a seeded
      //    experiment has no legitimate source of infrastructure failure.
      const stats = await h.queue.stats(h.investigationId);
      const z = (k: string): number => stats.byOutcome[k] ?? 0;
      expect(z("PRODUCT_FAILED"), `PRODUCT_FAILED:\n${diagnosis}`).toBe(0);
      expect(z("AUTOMATION_FAILED"), `AUTOMATION_FAILED:\n${diagnosis}`).toBe(0);
      expect(
        z("INFRASTRUCTURE_FAILED"),
        `INFRASTRUCTURE_FAILED on a deterministic fixture:\n${diagnosis}`
      ).toBe(0);
      expect(z("INTERRUPTED"), `INTERRUPTED:\n${diagnosis}`).toBe(0);
      expect(z("INCONCLUSIVE"), `INCONCLUSIVE:\n${diagnosis}`).toBe(0);
      expect(stats.byOutcome["VALID_COMPLETED"]).toBe(REQUESTED);

      // 0 retry attempts, hence exactly one job and one manifest per repetition.
      const retries = jobs.filter((j) => j.attemptIndex > 0);
      expect(retries.length, `zero retries required, got ${retries.length}:\n${diagnosis}`).toBe(0);
      expect(jobs.length, "one job per repetition when no retry occurred").toBe(REQUESTED);

      // 3. Exactly one sealed manifest per run.
      expect(manifests.length).toBe(REQUESTED);

      // 4. Required categories complete on every run.
      const required = ["actions", "navigation", "console", "exceptions", "networkMetadata"];
      const validRunIds = new Set(
        results.filter((r) => r.outcome === "VALID_COMPLETED").map((r) => r.runId)
      );
      for (const m of manifests.filter((x) => validRunIds.has(x["runId"] as string))) {
        const cs = m["captureStatus"] as { categories: Record<string, { status: string }> };
        for (const cat of required) {
          expect(cs.categories[cat]?.status, `run ${String(m["runId"])} category ${cat}`).toBe(
            "complete"
          );
        }
      }

      // 5, 6. Wall clock and per-run distribution. Scaled when the batch is shortened locally.
      const scaledWallBudget = WALL_CLOCK_BUDGET_MS;
      expect(
        wallClockMs,
        `total wall clock ${Math.round(wallClockMs / 1000)}s exceeded the ${Math.round(scaledWallBudget / 1000)}s budget`
      ).toBeLessThan(scaledWallBudget);

      const durations = results
        .filter((r) => r.outcome === "VALID_COMPLETED")
        .map((r) => r.durationMs)
        .sort((a, b) => a - b);
      const p95 = percentile(durations, 95);
      const max = durations[durations.length - 1]!;
      expect(p95, `p95 per-run ${Math.round(p95)}ms exceeded ${P95_BUDGET_MS}ms`).toBeLessThan(
        P95_BUDGET_MS
      );
      expect(max, `slowest run ${Math.round(max)}ms exceeded ${MAX_RUN_BUDGET_MS}ms`).toBeLessThan(
        MAX_RUN_BUDGET_MS
      );

      // 7. Disk growth. Video plus trace at scale is a real operational failure mode (R12).
      const scaledDiskBudget = DISK_BUDGET_BYTES;
      expect(
        grewBytes,
        `workspace grew ${Math.round(grewBytes / 1024 / 1024)}MB, over the ${Math.round(scaledDiskBudget / 1024 / 1024)}MB budget`
      ).toBeLessThan(scaledDiskBudget);

      // Reported so a budget renegotiation has real numbers to argue with.
      console.log(
        `[perf] runs=${REQUESTED} wall=${Math.round(wallClockMs / 1000)}s ` +
          `median=${Math.round(percentile(durations, 50))}ms p95=${Math.round(p95)}ms ` +
          `max=${Math.round(max)}ms disk=${Math.round(grewBytes / 1024 / 1024)}MB`
      );
    },
    // Generous ceiling: the assertion above is what enforces the budget, not the test timeout.
    REQUESTED * 20_000
  );
});
