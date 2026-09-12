import { describe, it, expect } from "vitest";
import { canonicalJson } from "@investigator/core";
import { contrastRuns, type RunEvidenceFacts } from "./analysis-tools.js";

/**
 * `contrastRuns` answers the question an intermittent bug turns on: what is different about the
 * runs that failed?
 *
 * Playwright produces evidence. Deterministic software normalizes and measures evidence. DeepSeek interprets and prioritizes evidence. Humans authorize consequential transitions.
 *
 * It is deliberately arithmetic rather than inference, because this is precisely the question a
 * model answers plausibly when it cannot answer it correctly. These tests therefore care as much
 * about what it REFUSES to claim — with one failing run, with no passing run, with evidence
 * missing — as about what it finds.
 */

function run(over: Partial<RunEvidenceFacts> & { runId: string }): RunEvidenceFacts {
  return {
    experimentId: "EXP-001",
    outcome: "VALID_COMPLETED",
    outcomeRuleId: 5,
    outcomeDetail: "",
    features: {},
    captureStatus: { console: "complete", networkMetadata: "complete" },
    limitations: [],
    actions: [],
    ...over,
  };
}

const withConsole = (runId: string, outcome: string, fps: string[]): RunEvidenceFacts =>
  run({
    runId,
    outcome,
    outcomeRuleId: outcome === "PRODUCT_FAILED" ? 4 : 5,
    features: {
      consoleCounts: { byFingerprint: Object.fromEntries(fps.map((f) => [f, 1])), byLevel: {} },
    },
  });

describe("contrastRuns finds what separates failing runs from passing ones", () => {
  it("marks a fingerprint seen only in failures as discriminating", () => {
    const c = contrastRuns([
      withConsole("RUN-001", "PRODUCT_FAILED", ["cf_race", "cf_common"]),
      withConsole("RUN-002", "PRODUCT_FAILED", ["cf_race", "cf_common"]),
      withConsole("RUN-003", "VALID_COMPLETED", ["cf_common"]),
      withConsole("RUN-004", "VALID_COMPLETED", ["cf_common"]),
    ]);

    const race = c.consoleFingerprints.find((g) => g.value === "cf_race");
    expect(race).toMatchObject({ failing: 2, passing: 0, discriminating: true });

    const common = c.consoleFingerprints.find((g) => g.value === "cf_common");
    expect(common).toMatchObject({ failing: 2, passing: 2, discriminating: false });

    // Present in EVERY failure and NO pass: the strongest signal the data can carry.
    expect(c.perfectDiscriminators).toContain("cf_race");
    expect(c.perfectDiscriminators).not.toContain("cf_common");
  });

  it("does not call a value a perfect discriminator when one failure lacks it", () => {
    const c = contrastRuns([
      withConsole("RUN-001", "PRODUCT_FAILED", ["cf_race"]),
      withConsole("RUN-002", "PRODUCT_FAILED", []),
      withConsole("RUN-003", "VALID_COMPLETED", []),
    ]);
    // Still discriminating — it never appears in a pass — but it does not explain every failure,
    // and conflating those two is how a partial signal becomes a confident wrong answer.
    expect(c.consoleFingerprints.find((g) => g.value === "cf_race")?.discriminating).toBe(true);
    expect(c.perfectDiscriminators).not.toContain("cf_race");
  });

  it("separates runs by request ordering, which is how a race shows up", () => {
    const ordered = (runId: string, outcome: string, fp: string) =>
      run({
        runId,
        outcome,
        outcomeRuleId: outcome === "PRODUCT_FAILED" ? 4 : 5,
        features: { requestOrdering: { fingerprint: fp, sequence: [] } },
      });

    const c = contrastRuns([
      ordered("RUN-001", "PRODUCT_FAILED", "filter -> initial"),
      ordered("RUN-002", "VALID_COMPLETED", "initial -> filter"),
      ordered("RUN-003", "VALID_COMPLETED", "initial -> filter"),
    ]);
    expect(c.requestOrderings.find((g) => g.value === "filter -> initial")).toMatchObject({
      failing: 1,
      passing: 0,
      discriminating: true,
    });
  });

  it("reports timing differences per request without interpreting them", () => {
    const timed = (runId: string, outcome: string, ms: number) =>
      run({
        runId,
        outcome,
        features: { requestDurations: [{ requestKey: "GET /api/filter", medianMs: ms }] },
      });

    const c = contrastRuns([
      timed("RUN-001", "PRODUCT_FAILED", 900),
      timed("RUN-002", "VALID_COMPLETED", 100),
    ]);
    expect(c.requestTimings[0]).toMatchObject({
      key: "GET /api/filter",
      failingMedianMs: 900,
      passingMedianMs: 100,
      deltaMs: 800,
    });
  });
});

describe("contrastRuns states the limits of the comparison", () => {
  it("says plainly that nothing discriminates when every run failed", () => {
    const c = contrastRuns([
      withConsole("RUN-001", "PRODUCT_FAILED", ["cf_x"]),
      withConsole("RUN-002", "PRODUCT_FAILED", ["cf_x"]),
    ]);
    expect(c.passingRunIds).toEqual([]);
    expect(c.caveats.join(" ")).toMatch(/nothing here discriminates/i);
    // With no control group, "appears in every failure" is not evidence of anything.
    expect(c.perfectDiscriminators).toContain("cf_x");
    expect(c.caveats.join(" ")).toMatch(/common to all runs/i);
  });

  it("warns when the failing sample is too small to mean much", () => {
    const c = contrastRuns([
      withConsole("RUN-001", "PRODUCT_FAILED", ["cf_x"]),
      withConsole("RUN-002", "VALID_COMPLETED", []),
    ]);
    expect(c.caveats.join(" ")).toMatch(/Only 1 failing run/);
  });

  it("excludes infrastructure failures from the contrast and says so", () => {
    const c = contrastRuns([
      withConsole("RUN-001", "PRODUCT_FAILED", ["cf_x"]),
      withConsole("RUN-002", "VALID_COMPLETED", []),
      run({ runId: "RUN-003", outcome: "INFRASTRUCTURE_FAILED", outcomeRuleId: 2 }),
    ]);
    // A harness crash is not a product observation; counting it would corrupt the comparison.
    expect(c.otherRunIds).toEqual(["RUN-003"]);
    expect(c.failingRunIds).not.toContain("RUN-003");
    expect(c.caveats.join(" ")).toMatch(/infrastructure or interrupted/);
  });

  it("warns that an absent signal may mean uncaptured, not absent", () => {
    const c = contrastRuns([
      run({ runId: "RUN-001", outcome: "PRODUCT_FAILED", captureStatus: { console: "missing" } }),
      withConsole("RUN-002", "VALID_COMPLETED", []),
    ]);
    expect(c.caveats.join(" ")).toMatch(/never "did not happen"/);
  });

  it("has no caveat to make when there is nothing to contrast", () => {
    const c = contrastRuns([withConsole("RUN-001", "VALID_COMPLETED", [])]);
    expect(c.failingRunIds).toEqual([]);
    expect(c.caveats.join(" ")).toMatch(/nothing to contrast/i);
  });
});

describe("contrastRuns is deterministic", () => {
  it("returns byte-identical output regardless of input order", () => {
    const runs = [
      withConsole("RUN-001", "PRODUCT_FAILED", ["cf_b", "cf_a"]),
      withConsole("RUN-002", "VALID_COMPLETED", ["cf_a"]),
      withConsole("RUN-003", "PRODUCT_FAILED", ["cf_b"]),
    ];
    // A finding cites this contrast, so re-deriving it later must produce the same bytes or the
    // citation cannot be re-checked.
    const a = canonicalJson(contrastRuns(runs));
    const b = canonicalJson(contrastRuns([runs[1]!, runs[2]!, runs[0]!]));
    expect(JSON.parse(a).consoleFingerprints).toEqual(JSON.parse(b).consoleFingerprints);
    expect(JSON.parse(a).perfectDiscriminators).toEqual(JSON.parse(b).perfectDiscriminators);
  });
});
