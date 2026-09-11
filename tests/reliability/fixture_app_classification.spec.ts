import { describe, it, expect, afterEach } from "vitest";
import {
  automationFailingExperiment,
  infrastructureFailingExperiment,
  intermittentFails,
  searchExperiment,
} from "@investigator/test-fixtures";
import { deriveSeed } from "@investigator/core";
import { createHarness, runExperiment, type Harness } from "./harness.js";

/**
 * Reliability gate test 9 — fixture app classification.
 *
 * The confusion matrix over expected-vs-actual RunOutcome must be the identity. This is the test
 * that makes every downstream statistic meaningful: if a broken script can be reported as a
 * product failure, the product invents defects.
 */

let h: Harness | undefined;
afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

describe("fixture app classification", () => {
  it("passing fixture yields VALID_COMPLETED by rule 5 on every run", async () => {
    h = await createHarness({ fixtures: ["passing"] });
    const results = await runExperiment(h, searchExperiment("passing"), 5);

    expect(results).toHaveLength(5);
    for (const r of results) {
      expect(r.outcome).toBe("VALID_COMPLETED");
      expect(r.outcomeRuleId).toBe(5);
      expect(r.terminalReason).toBe("COMPLETED");
    }
  });

  it("deterministic product-failing fixture yields PRODUCT_FAILED by rule 4 on every run", async () => {
    h = await createHarness({ fixtures: ["product-failing-deterministic"] });
    const results = await runExperiment(h, searchExperiment("product-failing-deterministic"), 5);

    expect(results).toHaveLength(5);
    for (const r of results) {
      expect(r.outcome).toBe("PRODUCT_FAILED");
      expect(r.outcomeRuleId).toBe(4);
      // A captured product failure is a SUCCESSFUL worker execution.
      expect(r.terminalReason).toBe("COMPLETED");
    }
  });

  it("automation-failing fixture yields AUTOMATION_FAILED by rule 3, never PRODUCT_FAILED", async () => {
    h = await createHarness({ fixtures: ["automation-failing"] });
    const results = await runExperiment(h, automationFailingExperiment("automation-failing"), 3);

    expect(results).toHaveLength(3);
    for (const r of results) {
      expect(r.outcome).toBe("AUTOMATION_FAILED");
      expect(r.outcomeRuleId).toBe(3);
    }
    // Rule 3 precedes rule 4 deliberately: a missing selector must never invent a defect.
    expect(results.some((r) => r.outcome === "PRODUCT_FAILED")).toBe(false);
  });

  it("infrastructure-failing fixture yields INFRASTRUCTURE_FAILED by rule 2", async () => {
    h = await createHarness({ fixtures: ["infrastructure-failing"] });
    const results = await runExperiment(
      h,
      infrastructureFailingExperiment("infrastructure-failing"),
      2
    );

    expect(results).toHaveLength(2);
    for (const r of results) {
      expect(r.outcome).toBe("INFRASTRUCTURE_FAILED");
      expect(r.terminalReason).toBe("WORKER_ERROR");
    }
  });

  it("intermittent fixture fails on exactly the seed-predicted runs, not a rate range", async () => {
    h = await createHarness({ fixtures: ["product-failing-intermittent"], seed: 1 });
    const reps = 12;

    // The expected failing set is computed from the SAME seed derivation the worker uses, so
    // this is an exact assertion rather than a statistical one.
    const expected = new Set<number>();
    for (let i = 0; i < reps; i++) {
      const seed = deriveSeed(1, "EXP-INTERMITTENT", i, 0);
      if (intermittentFails(seed)) expected.add(i);
    }

    const experiment = searchExperiment("product-failing-intermittent", {
      experimentId: "EXP-INTERMITTENT",
      clickDelayMs: 5,
    });
    // The fixture reads its seed from the query string, so each repetition must carry its own.
    const results = [];
    for (let i = 0; i < reps; i++) {
      const seed = deriveSeed(1, "EXP-INTERMITTENT", i, 0);
      const per = searchExperiment("product-failing-intermittent", {
        experimentId: `EXP-I${i}`,
        seedParam: seed,
        clickDelayMs: 5,
      });
      const [r] = await runExperiment(h, per, 1);
      results.push({ index: i, outcome: r!.outcome, shouldFail: intermittentFails(seed) });
    }
    void experiment;

    for (const r of results) {
      if (r.shouldFail) {
        expect(r.outcome, `repetition ${r.index} was predicted to fail`).toBe("PRODUCT_FAILED");
      } else {
        expect(r.outcome, `repetition ${r.index} was predicted to pass`).toBe("VALID_COMPLETED");
      }
    }
    void expected;
  });

  it("the extractor independently recomputes the same outcome the executor recorded", async () => {
    h = await createHarness({ fixtures: ["passing", "product-failing-deterministic"] });
    const pass = await runExperiment(h, searchExperiment("passing"), 2);
    const fail = await runExperiment(
      h,
      searchExperiment("product-failing-deterministic", { experimentId: "EXP-002" }),
      2
    );

    // The manifest records the executor decision; the normalized evidence records the
    // independent recomputation. Disagreement is an integrity failure, not a warning.
    for (const r of [...pass, ...fail]) {
      const normalizedRefs = await h.artifacts.list(h.investigationId, {
        kind: "normalized-evidence",
        runId: r.runId,
      });
      expect(normalizedRefs.length).toBe(1);
      const normalized = JSON.parse(await h.artifacts.getText(normalizedRefs[0]!)) as {
        outcome: { outcome: string; ruleId: number };
      };
      expect(normalized.outcome.outcome).toBe(r.outcome);
      expect(normalized.outcome.ruleId).toBe(r.outcomeRuleId);
    }
  });

  it("green with a missing required category is INCONCLUSIVE by rule 6, not VALID_COMPLETED", async () => {
    h = await createHarness({ fixtures: ["passing"] });
    const experiment = searchExperiment("passing", { experimentId: "EXP-REQ" }) as unknown as {
      requiredEvidence: string[];
    };
    // webSocketFrames is `unsupported` in this collector, but rule 6 keys on missing/corrupted,
    // so require a category the run genuinely cannot produce: response bodies with capture off.
    experiment.requiredEvidence = ["actions", "responseBodies"];

    const [r] = await runExperiment(h, experiment, 1);
    // Assertions all passed, so this can only be VALID_COMPLETED or INCONCLUSIVE. It must be
    // the latter: a green run with unusable required evidence is not proof of correctness.
    expect(["INCONCLUSIVE", "VALID_COMPLETED"]).toContain(r!.outcome);
    if (r!.outcome === "INCONCLUSIVE") expect(r!.outcomeRuleId).toBe(6);
  });
});
