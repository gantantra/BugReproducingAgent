import { describe, it, expect } from "vitest";
import {
  countRun,
  deriveTargetSignature,
  matchesSignature,
  type SignatureRun,
} from "./signature.js";

const run = (outcome: string, console: string[] = [], exceptions: string[] = []): SignatureRun => ({
  outcome,
  features: {
    consoleCounts: { byLevel: {}, byFingerprint: Object.fromEntries(console.map((c) => [c, 1])) },
    exceptionFingerprints: exceptions.map((fingerprint) => ({
      fingerprint,
      count: 1,
      eventIds: [],
    })),
  },
});

describe("the target signature", () => {
  const runs = [
    run("PRODUCT_FAILED", ["error:applyFilters", "log:boot"]),
    run("PRODUCT_FAILED", ["error:applyFilters", "log:boot"], ["TypeError"]),
    run("VALID_COMPLETED", ["log:boot"]),
    run("AUTOMATION_FAILED", ["error:other"]),
  ];

  it("keeps what every failure at the check shares and no pass has", () => {
    expect(deriveTargetSignature(runs)).toEqual({
      schemaVersion: "1.0.0",
      atCheck: true,
      consoleFingerprints: ["error:applyFilters"],
      // In one failure only, so not part of the signature.
      exceptionFingerprints: [],
    });
  });

  it("is a pure function of its inputs", () => {
    expect(JSON.stringify(deriveTargetSignature(runs))).toBe(
      JSON.stringify(deriveTargetSignature(runs))
    );
  });

  it("matches only a failure at the check carrying the fingerprints", () => {
    const sig = deriveTargetSignature(runs);
    expect(matchesSignature(sig, run("PRODUCT_FAILED", ["error:applyFilters"]))).toBe(true);
    expect(matchesSignature(sig, run("PRODUCT_FAILED", ["error:network"]))).toBe(false);
    expect(matchesSignature(sig, run("AUTOMATION_FAILED", ["error:applyFilters"]))).toBe(false);
  });

  it("counts a different failure apart, and excludes runs that never reached the check", () => {
    const sig = deriveTargetSignature(runs);
    expect(countRun(sig, run("PRODUCT_FAILED", ["error:applyFilters"]))).toBe("matched");
    expect(countRun(sig, run("PRODUCT_FAILED", []))).toBe("other-failure");
    expect(countRun(sig, run("VALID_COMPLETED"))).toBe("passed");
    expect(countRun(sig, run("AUTOMATION_FAILED"))).toBe("excluded");
    expect(countRun(sig, run("INFRASTRUCTURE_FAILED"))).toBe("excluded");
  });

  it("with no failure to learn from, matches any failure at the check", () => {
    const sig = deriveTargetSignature([run("VALID_COMPLETED")]);
    expect(sig.consoleFingerprints).toEqual([]);
    expect(matchesSignature(sig, run("PRODUCT_FAILED"))).toBe(true);
  });
});
