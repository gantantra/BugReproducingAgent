import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  SLOW_FAIL_AFTER_MS,
  SLOW_RESPONSE_MS,
  startFixture,
  type FixtureHandle,
} from "@investigator/test-fixtures";
import { authoredSuiteWorkspace, cli, filesUnder } from "./authored-suite.js";

/**
 * Request durations are measured, not stamped as zero.
 *
 * The collector used to write each request's finish time as its start as well, so every duration
 * was 0 ms and the analysis read "request timings are identical" on a bug that was nothing but
 * timing. On this fixture some filter responses (seeded) take SLOW_RESPONSE_MS: the failing runs'
 * filter request must measure at least that, and the passing runs' well under the page's patience.
 */

let ws: string;
let fixture: FixtureHandle;

beforeAll(async () => {
  fixture = await startFixture("product-failing-slow-intermittent");
  ({ ws } = authoredSuiteWorkspace(`${fixture.baseUrl}search`));
}, 120_000);

afterAll(async () => {
  await fixture?.close();
  try {
    rmSync(ws, { recursive: true, force: true });
  } catch {
    // A browser that has not quite let go of a video on Windows; the OS temp dir is disposable.
  }
});

describe("request timing in captured evidence", () => {
  it("shows the slow filter response in exactly the runs that failed", async () => {
    const r = await cli([
      "rerun",
      "--investigation",
      "INV-001",
      "--repeat",
      "12",
      "--workspace",
      ws,
      "--json",
    ]);
    expect(r.status, r.stdout.slice(-1500)).toBe(0);

    const artifacts = join(ws, ".investigator", "investigations", "INV-001", "artifacts");
    const [batchFile] = filesUnder(join(artifacts, "rerun-batch"));
    const batch = JSON.parse(readFileSync(batchFile!, "utf8")) as {
      runs: Array<{ runId: string; outcome: string }>;
    };
    const outcomes = new Map(batch.runs.map((x) => [x.runId, x.outcome]));
    let slowFailures = 0;
    for (const f of filesUnder(join(artifacts, "normalized-evidence"))) {
      const doc = JSON.parse(readFileSync(f, "utf8")) as {
        runId: string;
        features: { requestDurations: Array<{ requestKey: string; maxMs: number }> };
      };
      const filter = doc.features.requestDurations.find((d) =>
        d.requestKey.includes("/api/filter")
      );
      const outcome = outcomes.get(doc.runId);
      // A run whose browser never started made no request, and says nothing either way.
      if (!filter) {
        expect(outcome, `${doc.runId} has no filter request`).toBe("INFRASTRUCTURE_FAILED");
        continue;
      }
      const slow = filter.maxMs >= SLOW_RESPONSE_MS - 50;
      const context = `${doc.runId}: ${outcome}, filter ${filter.maxMs} ms`;
      // Failed at the check exactly when the filter response was slow -- the timing is the bug.
      expect(outcome === "PRODUCT_FAILED", context).toBe(slow);
      if (!slow) expect(filter.maxMs, context).toBeLessThan(SLOW_FAIL_AFTER_MS);
      if (slow) slowFailures++;
    }
    expect(slowFailures).toBeGreaterThanOrEqual(1);
  }, 300_000);
});
