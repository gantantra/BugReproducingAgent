import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { gatePassed, loadDataset, runEval } from "../../eval/harness/runner.js";

/**
 * The M3 replay eval gate, executable and blocking.
 *
 * Playwright produces evidence. Deterministic software normalizes and measures evidence. DeepSeek interprets and prioritizes evidence. Humans authorize consequential transitions.
 *
 * M3 is not "integrate DeepSeek" — it is "pass the eval harness". This runs in replay mode from
 * recorded outputs, so it needs no credential, no network and no third party, which is the only
 * way a gate on model behaviour can honestly block CI.
 */

const DATASETS = join(process.cwd(), "eval", "datasets");

describe("M3 eval datasets meet the declared minimums", () => {
  it("intake_to_flow has at least 12 positive and 6 negative cases", () => {
    const cases = loadDataset(join(DATASETS, "intake_to_flow.jsonl"));
    expect(cases.filter((c) => c.kind === "positive").length).toBeGreaterThanOrEqual(12);
    expect(cases.filter((c) => c.kind === "negative").length).toBeGreaterThanOrEqual(6);
  });

  it("propose_experiments has at least 10 positive and 6 negative cases", () => {
    const cases = loadDataset(join(DATASETS, "propose_experiments.jsonl"));
    expect(cases.filter((c) => c.kind === "positive").length).toBeGreaterThanOrEqual(10);
    expect(cases.filter((c) => c.kind === "negative").length).toBeGreaterThanOrEqual(6);
  });

  it("covers the four named M3 negative categories", () => {
    // docs/evaluation/eval-gates.md names these explicitly for M3.
    const all = [
      ...loadDataset(join(DATASETS, "intake_to_flow.jsonl")),
      ...loadDataset(join(DATASETS, "propose_experiments.jsonl")),
    ];
    const ids = all.map((c) => c.caseId).join(" ");
    expect(ids, "out-of-vocabulary actions").toContain("out-of-vocabulary-action");
    expect(ids, "invented credentials").toContain("invented-credentials");
    expect(ids, "out-of-allowlist origins").toContain("out-of-allowlist-origin");
    expect(ids, "unflagged destructive actions").toContain("unflagged-destructive");
  });

  it("every negative case declares which guard must fire", () => {
    for (const flow of ["intake_to_flow", "propose_experiments"]) {
      for (const c of loadDataset(join(DATASETS, `${flow}.jsonl`))) {
        if (c.kind !== "negative") continue;
        // Without this, a negative case could "pass" for the wrong reason.
        expect(c.violates, `${c.caseId} must name the check it violates`).toBeTruthy();
      }
    }
  });
});

describe.each(["intake_to_flow", "propose_experiments"])("M3 replay gate: %s", (flowId) => {
  const report = runEval(flowId, DATASETS);

  it("every positive case passes every hard check", () => {
    const failed = report.cases.filter((c) => c.kind === "positive" && !c.passed);
    expect(
      failed.map((f) => `${f.caseId}: ${f.checks.filter((c) => !c.passed).map((c) => `${c.name} (${c.detail})`).join("; ")}`),
      "positive cases must pass every hard check"
    ).toEqual([]);
  });

  it("every negative case is DETECTED, not merely tolerated", () => {
    const undetected = report.cases.filter((c) => c.kind === "negative" && !c.passed);
    expect(
      undetected.map((f) => `${f.caseId}: ${f.checks[0]?.detail}`),
      "a negative case passes only when the guard actually fires"
    ).toEqual([]);
  });

  it("meets the 100% replay gate", () => {
    const gate = gatePassed(report);
    expect(gate.passed, gate.reason).toBe(true);
    expect(report.rate).toBe(1);
  });
});
