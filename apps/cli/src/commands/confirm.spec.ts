import { describe, it, expect } from "vitest";
import { buildConfirmationSchedule } from "@investigator/execution";
import {
  buildConfirmationConfig,
  configBytes,
  configChecksum,
  countConfirmation,
  type ProposedConfirmation,
} from "./confirm.js";

const proposal: ProposedConfirmation = {
  condition: "The filter empties the list when its response is slow.",
  factor: { kind: "network", profile: "slow-3g" },
  rationale: "The page gives up after a fixed time.",
  falsifier: "It empties as often on a fast network.",
};

const config = () =>
  buildConfirmationConfig({
    investigationId: "INV-001",
    sourceBatchId: "BATCH-001",
    analysisArtifactId: "RPTOUT-1234abcd",
    conditionIndex: 1,
    proposal,
    perArm: 12,
    suiteChecksum: `sha256:${"a".repeat(64)}`,
    targetSignature: {
      schemaVersion: "1.0.0",
      atCheck: true,
      consoleFingerprints: ["cf_1"],
      exceptionFingerprints: [],
    },
  });

describe("the frozen experiment config", () => {
  it("is canonical bytes: sorted keys, one trailing newline, the same every time", () => {
    const bytes = configBytes(config());
    expect(bytes).toBe(configBytes(config()));
    expect(bytes.endsWith("}\n")).toBe(true);
    const keys = Object.keys(JSON.parse(bytes) as object);
    expect(keys).toEqual([...keys].sort());
  });

  it("changes its checksum when any byte of what would run changes", () => {
    const base = configChecksum(config());
    expect(configChecksum({ ...config(), perArm: 13 })).not.toBe(base);
    expect(configChecksum({ ...config(), factor: { kind: "cpu", rate: 4 } })).not.toBe(base);
    expect(configChecksum({ ...config(), suiteChecksum: `sha256:${"b".repeat(64)}` })).not.toBe(
      base
    );
  });

  it("freezes the internal statistics with it", () => {
    expect(config().statistics).toEqual({ confidence: 0.95, alpha: 0.05, minReachedPerArm: 10 });
  });
});

describe("the interleaving", () => {
  it("is the same for the same seed, and holds both arms in every block", () => {
    const a = buildConfirmationSchedule(12, config().seed);
    expect(a).toEqual(buildConfirmationSchedule(12, config().seed));
    expect(a).toHaveLength(24);
    for (let i = 0; i < a.length; i += 2) {
      expect(new Set(a.slice(i, i + 2))).toEqual(new Set(["variant", "control"]));
    }
  });

  it("is not simply alternating", () => {
    const a = buildConfirmationSchedule(12, config().seed);
    const firsts = new Set(a.filter((_, i) => i % 2 === 0));
    expect(firsts.size).toBe(2);
  });
});

describe("counting a confirmation", () => {
  const sig = config().targetSignature;
  const features = (fps: string[]) => ({
    consoleCounts: { byLevel: {}, byFingerprint: Object.fromEntries(fps.map((f) => [f, 1])) },
    exceptionFingerprints: [],
  });
  const run = (outcome: string, arm: string, fps: string[] = [], factorApplied = true) => ({
    outcome,
    features: features(fps),
    arm: { arm, factorApplied },
  });

  it("counts only matching failures, and keeps other failures and non-runs apart", () => {
    const counted = countConfirmation(sig, [
      run("PRODUCT_FAILED", "variant", ["cf_1"]),
      run("PRODUCT_FAILED", "variant", ["cf_other"]),
      run("VALID_COMPLETED", "variant"),
      run("INFRASTRUCTURE_FAILED", "variant"),
      run("PRODUCT_FAILED", "variant", ["cf_1"], false),
      run("VALID_COMPLETED", "control", [], false),
      run("AUTOMATION_FAILED", "control", [], false),
    ]);
    expect(counted.variant).toEqual({ matched: 1, reached: 3, otherFailures: 1, excluded: 1 });
    expect(counted.control).toEqual({ matched: 0, reached: 1, otherFailures: 0, excluded: 1 });
    // The variant run whose factor did not take reached the check but is not a variant run.
    expect(counted.factorNotApplied).toBe(1);
  });

  it("ignores a run with no arm", () => {
    const counted = countConfirmation(sig, [
      { outcome: "PRODUCT_FAILED", features: features(["cf_1"]) },
    ]);
    expect(counted.variant.reached + counted.control.reached).toBe(0);
  });
});
