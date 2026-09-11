import { describe, it, expect } from "vitest";
import { CaptureStatusBuilder } from "./capture-status.js";
import type { RedactionStamp, VersionStamps } from "@investigator/core";

const VERSIONS: VersionStamps = {
  collectorVersion: "test",
  normalizerVersion: "test",
  extractorVersion: "test",
};
const REDACTION: RedactionStamp = {
  policyId: "default",
  policyVersion: "1.0.0",
  policyHash: "sha256:test",
  mode: "strict",
  appliedRules: [],
};
const sealArgs = { runId: "RUN-001", versions: VERSIONS, redaction: REDACTION };

/**
 * M1 exit criterion 10 requires every `CaptureStatus` reason code to be covered by at least one
 * test. The completion audit found `DROPPED_BACKPRESSURE` and `RUN_INTERRUPTED` had none, so a
 * change to either derivation could not fail a test. Both are covered here, alongside the
 * derivation rule that makes them meaningfully different from each other.
 */

describe("CaptureStatus reason codes", () => {
  it("RUN_INTERRUPTED is partial when some evidence arrived, missing when none did", () => {
    // The distinction matters downstream: a run that captured half a timeline before being
    // killed still has usable evidence, and one that captured nothing does not.
    const withSome = new CaptureStatusBuilder(["actions"]);
    withSome.collected("actions", 3);
    withSome.reason("actions", "RUN_INTERRUPTED", { count: 1 });
    expect(withSome.seal(sealArgs).categories["actions"]?.status).toBe("partial");

    const withNone = new CaptureStatusBuilder(["actions"]);
    withNone.reason("actions", "RUN_INTERRUPTED", { count: 1 });
    expect(withNone.seal(sealArgs).categories["actions"]?.status).toBe("missing");
  });

  it("DROPPED_BACKPRESSURE degrades the category and retains the dropped count", () => {
    const b = new CaptureStatusBuilder(["console"]);
    b.collected("console", 500);
    b.reason("console", "DROPPED_BACKPRESSURE", { count: 42 });

    const sealed = b.seal(sealArgs);
    const console_ = sealed.categories["console"];
    // Never "complete": evidence was observed and deliberately discarded, and a reader must be
    // able to see that rather than infer the events never happened.
    expect(console_?.status).not.toBe("complete");
    const reason = console_?.reasons?.find((r) => r.code === "DROPPED_BACKPRESSURE");
    expect(reason, "the dropped-backpressure reason must be retained").toBeDefined();
    expect(reason?.count).toBe(42);
  });

  it("a reason code is recorded once with an accumulated count, not duplicated", () => {
    const b = new CaptureStatusBuilder(["console"]);
    b.collected("console", 10);
    b.reason("console", "DROPPED_BACKPRESSURE", { count: 5 });
    b.reason("console", "DROPPED_BACKPRESSURE", { count: 7 });

    const reasons = b.seal(sealArgs).categories["console"]?.reasons ?? [];
    const dropped = reasons.filter((r) => r.code === "DROPPED_BACKPRESSURE");
    expect(dropped).toHaveLength(1);
    expect(dropped[0]?.count).toBe(12);
  });

  it("an uninvolved category stays complete", () => {
    const b = new CaptureStatusBuilder(["actions", "console"]);
    b.collected("actions", 4);
    b.collected("console", 1);
    b.reason("console", "DROPPED_BACKPRESSURE", { count: 1 });

    const sealed = b.seal(sealArgs);
    expect(sealed.categories["actions"]?.status).toBe("complete");
    expect(sealed.categories["console"]?.status).not.toBe("complete");
  });
});
