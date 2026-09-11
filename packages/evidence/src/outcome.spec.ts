import { describe, it, expect } from "vitest";
import { decideOutcome, type OutcomeInputs } from "./outcome.js";
import { CaptureStatusBuilder } from "./capture-status.js";
import type { CaptureStatus, EvidenceCategory } from "@investigator/core";

/**
 * The six ordered RunOutcome rules (ADR-0005).
 *
 * The ORDER is the design, so these tests assert precedence explicitly rather than only
 * asserting each rule in isolation.
 */

const REQUIRED: EvidenceCategory[] = ["actions", "console"];

function completeStatus(): CaptureStatus {
  const b = new CaptureStatusBuilder(REQUIRED);
  for (const c of REQUIRED) {
    b.collected(c, 1);
    b.expected(c, 1);
  }
  return b.seal({
    runId: "RUN-001",
    versions: { collectorVersion: "1", normalizerVersion: "1", extractorVersion: "1" },
    redaction: {
      policyId: "t",
      policyVersion: "1.0.0",
      policyHash: "sha256:" + "0".repeat(64),
      mode: "strict",
      appliedRules: [],
    },
  });
}

function statusMissing(cat: EvidenceCategory): CaptureStatus {
  const b = new CaptureStatusBuilder(REQUIRED);
  for (const c of REQUIRED) {
    if (c === cat) {
      b.expected(c, 3);
      b.reason(c, "TARGET_DETACHED", { count: 3 });
    } else {
      b.collected(c, 1);
      b.expected(c, 1);
    }
  }
  return b.seal({
    runId: "RUN-001",
    versions: { collectorVersion: "1", normalizerVersion: "1", extractorVersion: "1" },
    redaction: {
      policyId: "t",
      policyVersion: "1.0.0",
      policyHash: "sha256:" + "0".repeat(64),
      mode: "strict",
      appliedRules: [],
    },
  });
}

function inputs(over: Partial<OutcomeInputs> = {}): OutcomeInputs {
  return {
    interrupted: false,
    infrastructureFailure: null,
    automationFailure: null,
    assertionOutcomes: [
      {
        assertionId: "AS1",
        actionId: "A1",
        result: "pass",
        isFailurePredicate: false,
        detail: null,
      },
    ],
    consoleErrorCount: 0,
    exceptionCount: 0,
    captureStatus: completeStatus(),
    requiredCategories: REQUIRED,
    ...over,
  };
}

describe("RunOutcome decision rules", () => {
  it("rule 1: interruption wins over everything else", () => {
    const d = decideOutcome(
      inputs({
        interrupted: true,
        infrastructureFailure: { reason: "also broken" },
        automationFailure: { reason: "also broken" },
        assertionOutcomes: [
          {
            assertionId: "AS1",
            actionId: null,
            result: "fail",
            isFailurePredicate: false,
            detail: null,
          },
        ],
      })
    );
    expect(d.outcome).toBe("INTERRUPTED");
    expect(d.ruleId).toBe(1);
  });

  it("rule 2: infrastructure beats automation and product", () => {
    const d = decideOutcome(
      inputs({
        infrastructureFailure: { reason: "browser launch failed" },
        automationFailure: { reason: "selector missing" },
        assertionOutcomes: [
          {
            assertionId: "AS1",
            actionId: null,
            result: "fail",
            isFailurePredicate: false,
            detail: null,
          },
        ],
      })
    );
    expect(d.outcome).toBe("INFRASTRUCTURE_FAILED");
    expect(d.ruleId).toBe(2);
  });

  it("rule 3 precedes rule 4: a broken script is never reported as a defect", () => {
    const d = decideOutcome(
      inputs({
        automationFailure: { reason: "selector did not exist", actionId: "A2" },
        // Assertions also failed, but only because the run never got that far.
        assertionOutcomes: [
          {
            assertionId: "AS1",
            actionId: null,
            result: "fail",
            isFailurePredicate: false,
            detail: null,
          },
        ],
      })
    );
    expect(d.outcome).toBe("AUTOMATION_FAILED");
    expect(d.ruleId).toBe(3);
    expect(d.outcome).not.toBe("PRODUCT_FAILED");
  });

  it("rule 4: a failed assertion is a product failure", () => {
    const d = decideOutcome(
      inputs({
        assertionOutcomes: [
          {
            assertionId: "AS1",
            actionId: "A1",
            result: "fail",
            isFailurePredicate: false,
            detail: "count=0",
          },
        ],
      })
    );
    expect(d.outcome).toBe("PRODUCT_FAILED");
    expect(d.ruleId).toBe(4);
    expect(d.detail).toContain("AS1");
  });

  it("rule 4: a matched failure predicate is a product failure", () => {
    const d = decideOutcome(
      inputs({
        assertionOutcomes: [
          {
            assertionId: "AS9",
            actionId: "A1",
            result: "pass",
            isFailurePredicate: true,
            detail: null,
          },
        ],
      })
    );
    expect(d.outcome).toBe("PRODUCT_FAILED");
    expect(d.ruleId).toBe(4);
  });

  it("rule 5: everything passed and required evidence is usable", () => {
    const d = decideOutcome(inputs());
    expect(d.outcome).toBe("VALID_COMPLETED");
    expect(d.ruleId).toBe(5);
  });

  it("rule 6 follows rule 5: green with missing required evidence is not proof of correctness", () => {
    const d = decideOutcome(inputs({ captureStatus: statusMissing("console") }));
    expect(d.outcome).toBe("INCONCLUSIVE");
    expect(d.ruleId).toBe(6);
    expect(d.detail).toContain("console");
  });

  it("rule 6: a run where nothing was asserted is inconclusive, not valid", () => {
    const d = decideOutcome(
      inputs({
        assertionOutcomes: [
          {
            assertionId: "AS1",
            actionId: null,
            result: "not-evaluated",
            isFailurePredicate: false,
            detail: null,
          },
        ],
      })
    );
    expect(d.outcome).toBe("INCONCLUSIVE");
    expect(d.ruleId).toBe(6);
  });

  it("a non-required category being incomplete does not block rule 5", () => {
    const b = new CaptureStatusBuilder(REQUIRED);
    for (const c of REQUIRED) {
      b.collected(c, 1);
      b.expected(c, 1);
    }
    // responseBodies is degraded but is not in requiredCategories.
    b.reason("responseBodies", "CONTENT_TYPE_NOT_CAPTURED", { count: 4 });
    const status = b.seal({
      runId: "RUN-001",
      versions: { collectorVersion: "1", normalizerVersion: "1", extractorVersion: "1" },
      redaction: {
        policyId: "t",
        policyVersion: "1.0.0",
        policyHash: "sha256:" + "0".repeat(64),
        mode: "strict",
        appliedRules: [],
      },
    });

    const d = decideOutcome(inputs({ captureStatus: status }));
    expect(d.outcome).toBe("VALID_COMPLETED");
    expect(status.categories.responseBodies.status).toBe("missing");
  });
});

describe("CaptureStatusBuilder", () => {
  it("emits every category, with no absent keys", () => {
    const status = completeStatus();
    const keys = Object.keys(status.categories).sort();
    expect(keys).toEqual(
      [
        "actions",
        "console",
        "domSnapshots",
        "exceptions",
        "navigation",
        "networkMetadata",
        "responseBodies",
        "screenshots",
        "storage",
        "trace",
        "video",
        "webSocketFrames",
      ].sort()
    );
  });

  it("derives disabled, unsupported, and redacted distinctly", () => {
    const b = new CaptureStatusBuilder([]);
    b.reason("video", "CONFIG_OFF");
    b.reason("webSocketFrames", "COLLECTOR_UNSUPPORTED");
    b.reason("trace", "POLICY_REDACTED");
    b.reason("domSnapshots", "PARSE_FAILED", { count: 2 });
    const s = b.seal({
      runId: "RUN-001",
      versions: { collectorVersion: "1", normalizerVersion: "1", extractorVersion: "1" },
      redaction: {
        policyId: "t",
        policyVersion: "1.0.0",
        policyHash: "sha256:" + "0".repeat(64),
        mode: "strict",
        appliedRules: [],
      },
    });

    // `disabled` is the distinction ADR-0016 added: an operator choice reads differently from a
    // collector limitation.
    expect(s.categories.video.status).toBe("disabled");
    expect(s.categories.webSocketFrames.status).toBe("unsupported");
    expect(s.categories.trace.status).toBe("redacted");
    expect(s.categories.domSnapshots.status).toBe("corrupted");
  });

  it("generates limitations from reasons so prose and data cannot drift", () => {
    const b = new CaptureStatusBuilder([]);
    b.reason("responseBodies", "SIZE_LIMIT", { count: 3, limitBytes: 262144 });
    b.reason("webSocketFrames", "COLLECTOR_UNSUPPORTED");
    const s = b.seal({
      runId: "RUN-001",
      versions: { collectorVersion: "1", normalizerVersion: "1", extractorVersion: "1" },
      redaction: {
        policyId: "t",
        policyVersion: "1.0.0",
        policyHash: "sha256:" + "0".repeat(64),
        mode: "strict",
        appliedRules: [],
      },
    });

    expect(s.limitations).toContain(
      "Three response bodies exceeded the configured size limit of 262144 bytes."
    );
    expect(s.limitations.some((l) => l.includes("WebSocket frames"))).toBe(true);
    // Every non-complete category explains itself.
    for (const [cat, entry] of Object.entries(s.categories)) {
      if (entry.status !== "complete") {
        expect(entry.reasons?.length, `${cat} has no reason`).toBeGreaterThan(0);
      }
    }
  });
});
