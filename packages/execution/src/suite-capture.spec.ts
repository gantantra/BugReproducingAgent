import { describe, it, expect } from "vitest";
import {
  buildConfirmationSchedule,
  suiteCaptureArmName,
  suiteCaptureLogName,
  withinMs,
} from "./suite-capture.js";

describe("bounding the end-of-run storage read", () => {
  it("passes a prompt answer through", async () => {
    await expect(withinMs(1_000, Promise.resolve(42))).resolves.toBe(42);
  });

  it("gives up on a page that never answers, instead of waiting out another test timeout", async () => {
    const never = new Promise<number>(() => {});
    const started = performance.now();
    await expect(withinMs(50, never)).rejects.toThrow(/timed out after 50ms/);
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});

describe("staging file names", () => {
  it("sort by repeat, and pair each raw log with its arm record", () => {
    expect(suiteCaptureLogName(7)).toBe("run-0007.jsonl");
    expect(suiteCaptureArmName(7)).toBe("run-0007.arm.json");
    expect([suiteCaptureLogName(10), suiteCaptureLogName(9)].sort()).toEqual([
      "run-0009.jsonl",
      "run-0010.jsonl",
    ]);
  });
});

describe("the confirmation schedule", () => {
  it("refuses a run count that is not a positive whole number", () => {
    expect(() => buildConfirmationSchedule(0, 1)).toThrow(RangeError);
    expect(() => buildConfirmationSchedule(2.5, 1)).toThrow(RangeError);
  });
});
