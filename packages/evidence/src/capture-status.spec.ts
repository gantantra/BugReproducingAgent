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

/**
 * A persisted video is the one artifact redaction cannot clean.
 *
 * Playwright produces evidence. Deterministic software normalizes and measures evidence. DeepSeek interprets and prioritizes evidence. Humans authorize consequential transitions.
 *
 * The limitation string is the ONLY place a reader is told the recording may show a credential
 * that was on screen, so it is asserted on its wording, not merely on the code being present.
 */
describe("video is captured but unredactable", () => {
  it("states plainly that the recording was stored without redaction", () => {
    const b = new CaptureStatusBuilder(["video"]);
    b.collected("video", 1);
    b.reason("video", "PERSISTED_UNREDACTED", { count: 1 });

    const sealed = b.seal(sealArgs);
    expect(sealed.categories["video"]?.status).toBe("complete");
    const text = sealed.limitations.join(" ");
    expect(text).toMatch(/WITHOUT redaction/);
    expect(text).toMatch(/visible on screen/);
    expect(text).toMatch(/credentials or personal data/);
  });

  it("reads grammatically for one recording and for several", () => {
    // "Videos was stored" shipped once. A limitation a reader stumbles over is a limitation a
    // reader skims past.
    const one = new CaptureStatusBuilder(["video"]);
    one.reason("video", "PERSISTED_UNREDACTED", { count: 1 });
    expect(one.seal(sealArgs).limitations.join(" ")).toContain("A recording was stored");

    const many = new CaptureStatusBuilder(["video"]);
    many.reason("video", "PERSISTED_UNREDACTED", { count: 3 });
    expect(many.seal(sealArgs).limitations.join(" ")).toContain("3 recordings were stored");
  });

  it("distinguishes capture enabled-but-empty from capture that failed to store", () => {
    const none = new CaptureStatusBuilder(["video"]);
    none.reason("video", "NO_RECORDING_PRODUCED", { count: 1 });
    expect(none.seal(sealArgs).limitations.join(" ")).toMatch(/produced no recording/);

    const lost = new CaptureStatusBuilder(["video"]);
    lost.reason("video", "PERSIST_FAILED", { count: 1 });
    // Losing a recording must not read like never having made one: the first is a fault.
    expect(lost.seal(sealArgs).limitations.join(" ")).toMatch(/could not be stored, and is lost/);
  });
});
