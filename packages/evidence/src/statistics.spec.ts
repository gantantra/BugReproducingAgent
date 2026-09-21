import { describe, it, expect } from "vitest";
import {
  DEFAULT_STATISTICAL_SETTINGS,
  decideConfirmation,
  fisherExactTwoSided,
  wilsonInterval,
} from "./statistics.js";

describe("Wilson interval", () => {
  it("matches published values", () => {
    // 10/10 at 95%: [0.7225, 1]. 3/10: [0.1078, 0.6032].
    const all = wilsonInterval(10, 10);
    expect(all.low).toBeCloseTo(0.7225, 3);
    expect(all.high).toBeCloseTo(1, 9);
    const some = wilsonInterval(3, 10);
    expect(some.low).toBeCloseTo(0.1078, 3);
    expect(some.high).toBeCloseTo(0.6032, 3);
  });

  it("is uninformative with no runs, and refuses impossible counts", () => {
    expect(wilsonInterval(0, 0)).toEqual({ low: 0, high: 1 });
    expect(() => wilsonInterval(4, 3)).toThrow(RangeError);
    expect(() => wilsonInterval(1.5, 3)).toThrow(RangeError);
  });
});

describe("Fisher exact test", () => {
  it("matches published two-sided values", () => {
    // Lady tasting tea: [[3,1],[1,3]] -> 0.4857.
    expect(fisherExactTwoSided(3, 1, 1, 3)).toBeCloseTo(0.4857, 4);
    // [[10,0],[3,7]] -> 0.003096.
    expect(fisherExactTwoSided(10, 0, 3, 7)).toBeCloseTo(0.003096, 5);
  });

  it("is 1 for identical arms", () => {
    expect(fisherExactTwoSided(5, 5, 5, 5)).toBeCloseTo(1, 6);
  });
});

describe("deciding a confirmation", () => {
  const arm = (matched: number, reached: number) => ({
    matched,
    reached,
    otherFailures: 0,
    excluded: 0,
  });

  it("confirms 10/10 against 3/10", () => {
    const v = decideConfirmation(arm(10, 10), arm(3, 10));
    expect(v.verdict).toBe("high_confidence_trigger");
    expect(v.reason).toBeUndefined();
  });

  it("does not confirm overlapping rates", () => {
    const v = decideConfirmation(arm(6, 10), arm(4, 10));
    expect(v.verdict).toBe("not_confirmed");
    expect(v.reason).toMatch(/too close/);
  });

  it("does not confirm on too few runs, however stark", () => {
    const v = decideConfirmation(arm(5, 5), arm(0, 5));
    expect(v.verdict).toBe("not_confirmed");
    expect(v.reason).toMatch(/too few runs/);
  });

  it("does not confirm a change that made the bug rarer", () => {
    expect(decideConfirmation(arm(1, 20), arm(15, 20)).verdict).toBe("not_confirmed");
  });

  it("uses conservative defaults", () => {
    expect(DEFAULT_STATISTICAL_SETTINGS).toEqual({
      confidence: 0.95,
      alpha: 0.05,
      minReachedPerArm: 10,
    });
  });
});
