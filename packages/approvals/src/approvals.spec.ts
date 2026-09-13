import { describe, it, expect } from "vitest";
import { isInvestigatorError } from "@investigator/core";
import type { ApprovalRecordRow } from "@investigator/storage";
import {
  applyEdits,
  approvedRecordFor,
  assertGateReachable,
  canonicalProposalBytes,
  checksumOfBytes,
  deriveGateStates,
  isExpired,
  isPathEditable,
  proposalChecksumOf,
  renderProposalMarkdown,
  scaffoldApprovalYaml,
  validateApproval,
  type ProposalBundle,
} from "./index.js";

/**
 * The approval gates are the last clause of the governing principle made executable. These tests
 * are the M2 acceptance tests for it: every one of them describes a way a human could be led to
 * approve something other than what they read, and asserts that it is refused.
 */

const INV = "INV-001";

function bundle(overrides: Partial<ProposalBundle> = {}): ProposalBundle {
  return {
    schemaVersion: "1.0.0",
    gate: "experiment_selection",
    investigationId: INV,
    renderedAt: "2026-09-11T10:00:00.000Z",
    summary: "Two candidate experiments for the blank-results report.",
    items: [
      {
        itemId: "EXP-001",
        rank: 1,
        hypothesis: "The filter response loses a race with the initial response.",
        variedFactor: "client timeout",
        falsifier: "Results render on every repetition with the short timeout.",
        expectedDiscriminatingSignal: "result-card count of 0 with a console error.",
        rankRationale: "Cheapest experiment that can separate the two candidate causes.",
        targetName: "fixture",
        repetitions: 20,
        requiredEvidence: ["actions", "navigation", "console"],
        actions: [
          { actionId: "A1", type: "goto", url: "/search", waitUntil: "load" },
          {
            actionId: "A2",
            type: "click",
            selector: { strategy: "testid", value: "filter-verified" },
            timeoutMs: 30000,
          },
        ],
        assertions: [{ assertionId: "AS1", kind: "elementCountAtLeast", min: 1 }],
        safety: {
          maxSideEffectClass: "read",
          destructiveActionIds: [],
          resetStrategy: "fresh-context",
        },
      },
      {
        itemId: "EXP-002",
        rank: 2,
        hypothesis: "A stale cache entry is served after the filter.",
        variedFactor: "cache state",
        falsifier: "The failure persists with the cache disabled.",
        targetName: "fixture",
        repetitions: 20,
        requiredEvidence: ["actions", "networkMetadata"],
        actions: [{ actionId: "A1", type: "goto", url: "/search", waitUntil: "load" }],
        assertions: [{ assertionId: "AS1", kind: "elementCountAtLeast", min: 1 }],
        safety: {
          maxSideEffectClass: "read",
          destructiveActionIds: [],
          resetStrategy: "fresh-context",
        },
      },
    ],
    ...overrides,
  };
}

const noDestructive = (): string[] => [];

function approvalYaml(over: Record<string, string> = {}, extra = ""): string {
  const f = {
    checksum: over["checksum"] ?? "",
    decision: over["decision"] ?? "approve",
    decidedAt: over["decidedAt"] ?? "2026-09-11T10:05:00.000Z",
    items: over["items"] ?? "  - EXP-001",
    ...over,
  };
  return [
    'schemaVersion: "1.0.0"',
    `gate: ${over["gate"] ?? "experiment_selection"}`,
    `investigationId: ${over["investigationId"] ?? INV}`,
    `proposalChecksum: "${f.checksum}"`,
    `decision: ${f.decision}`,
    "approver:",
    '  name: "Operator"',
    "  method: local-file",
    `decidedAt: "${f.decidedAt}"`,
    "approvedItemIds:",
    f.items,
    extra,
  ].join("\n");
}

function baseArgs(b: ProposalBundle, yamlText: string, checksum: string) {
  const bytes = canonicalProposalBytes(b);
  return {
    approvalText: yamlText,
    flagChecksum: checksum,
    gate: b.gate,
    investigationId: INV,
    proposalBytes: bytes,
    storedProposalHash: checksumOfBytes(bytes),
    approvals: [] as ApprovalRecordRow[],
    expiryHours: 72,
    classifyDestructive: noDestructive,
    clock: {
      nowMs: () => Date.parse("2026-09-11T10:30:00.000Z"),
      nowIso: () => "2026-09-11T10:30:00.000Z",
      monotonicMs: () => 0,
    },
  };
}

function codeOf(fn: () => unknown): string {
  try {
    fn();
    return "NO_ERROR";
  } catch (e) {
    return isInvestigatorError(e) ? e.code : `UNTYPED:${String(e)}`;
  }
}

describe("proposal canonicalisation", () => {
  it("is stable across key order, which is what makes a checksum meaningful", () => {
    const a = bundle();
    const reordered = JSON.parse(JSON.stringify(a)) as Record<string, unknown>;
    const rebuilt = {
      items: reordered["items"],
      gate: reordered["gate"],
      renderedAt: reordered["renderedAt"],
      schemaVersion: reordered["schemaVersion"],
      summary: reordered["summary"],
      investigationId: reordered["investigationId"],
    };
    expect(proposalChecksumOf(rebuilt)).toBe(proposalChecksumOf(a));
  });

  it("uses the frozen byte form: sorted keys, two-space indent, LF, one trailing newline", () => {
    const bytes = canonicalProposalBytes({ b: 1, a: 2 });
    expect(bytes).toBe('{\n  "a": 2,\n  "b": 1\n}\n');
    expect(bytes.endsWith("\n")).toBe(true);
    expect(bytes).not.toContain("\r");
  });

  it("changes when any byte of the proposal changes", () => {
    const a = bundle();
    const b = bundle();
    b.items[0]!["repetitions"] = 21;
    expect(proposalChecksumOf(b)).not.toBe(proposalChecksumOf(a));
  });
});

describe("edit surface", () => {
  it("permits the documented paths and refuses everything else", () => {
    expect(isPathEditable("experiment_selection", "/repetitions")).toBe(true);
    expect(isPathEditable("experiment_selection", "/actions/1/timeoutMs")).toBe(true);
    expect(isPathEditable("experiment_selection", "/safety/resetStrategy")).toBe(true);
    // Rejecting and re-planning is the path for these, not editing.
    expect(isPathEditable("experiment_selection", "/experimentId")).toBe(false);
    expect(isPathEditable("experiment_selection", "/hypothesis")).toBe(false);
  });

  it("lets gate 2 correct a judgement but never overwrite a measurement", () => {
    // Correcting which failure we are chasing is a judgement call.
    expect(isPathEditable("target_failure", "/signature/predicate")).toBe(true);
    expect(isPathEditable("target_failure", "/clusters/0/runIds")).toBe(true);
    // Rewriting what was observed is falsification.
    expect(isPathEditable("target_failure", "/signature/fingerprint")).toBe(false);
    expect(isPathEditable("target_failure", "/clusters/0/outcome")).toBe(false);
  });

  it("applies an in-surface edit and produces a different effective checksum", () => {
    const b = bundle();
    const effective = applyEdits(b, [
      {
        itemId: "EXP-001",
        path: "/actions/1/timeoutMs",
        from: 30000,
        to: 5000,
        rationale: "The reported failure only appears under a short client timeout.",
      },
    ]);
    const actions = effective.items[0]!["actions"] as Array<Record<string, unknown>>;
    expect(actions[1]!["timeoutMs"]).toBe(5000);
    expect(proposalChecksumOf(effective)).not.toBe(proposalChecksumOf(b));
    // The original is untouched: edits produce a new document, they do not mutate history.
    const originalActions = b.items[0]!["actions"] as Array<Record<string, unknown>>;
    expect(originalActions[1]!["timeoutMs"]).toBe(30000);
  });

  it("refuses an edit whose `from` does not match the current value (M2-AT-8)", () => {
    const b = bundle();
    const code = codeOf(() =>
      applyEdits(b, [
        {
          itemId: "EXP-001",
          path: "/repetitions",
          from: 999,
          to: 60,
          rationale: "written against an older revision",
        },
      ])
    );
    expect(code).toBe("GATE_EDIT_OUT_OF_SURFACE");
  });

  it("refuses an edit outside the surface (M2-AT-7)", () => {
    const b = bundle();
    expect(
      codeOf(() =>
        applyEdits(b, [
          {
            itemId: "EXP-001",
            path: "/hypothesis",
            from: "The filter response loses a race with the initial response.",
            to: "something else",
            rationale: "no",
          },
        ])
      )
    ).toBe("GATE_EDIT_OUT_OF_SURFACE");
  });

  it("refuses an edit naming an item outside the bundle (M2-AT-6)", () => {
    const b = bundle();
    expect(
      codeOf(() =>
        applyEdits(b, [
          { itemId: "EXP-999", path: "/repetitions", from: 20, to: 5, rationale: "x" },
        ])
      )
    ).toBe("GATE_REFERENCE_UNKNOWN");
  });
});

describe("approval validation", () => {
  it("accepts a correct approval and computes the effective proposal (M2-AT-1)", () => {
    const b = bundle();
    const checksum = proposalChecksumOf(b);
    const yamlText = approvalYaml(
      { checksum },
      [
        "edits:",
        "  - itemId: EXP-001",
        "    path: /repetitions",
        "    from: 20",
        "    to: 60",
        '    rationale: "Reported incidence is roughly 1 in 30."',
      ].join("\n")
    );

    const result = validateApproval(baseArgs(b, yamlText, checksum));
    expect(result.approvedItemIds).toEqual(["EXP-001"]);
    expect(result.effective.items[0]!["repetitions"]).toBe(60);
    expect(result.effectiveChecksum).not.toBe(checksum);
    // Execution consumes the EFFECTIVE proposal, so the two checksums must be distinguishable.
    expect(result.effectiveChecksum).toBe(proposalChecksumOf(result.effective));
  });

  it("refuses when --checksum does not match the proposal on disk (M2-AT-2)", () => {
    const b = bundle();
    const checksum = proposalChecksumOf(b);
    const args = baseArgs(b, approvalYaml({ checksum }), "sha256:" + "0".repeat(64));
    expect(codeOf(() => validateApproval(args))).toBe("GATE_CHECKSUM_MISMATCH");
  });

  it("refuses when the file's proposalChecksum disagrees with --checksum (M2-AT-3)", () => {
    const b = bundle();
    const checksum = proposalChecksumOf(b);
    const yamlText = approvalYaml({ checksum: "sha256:" + "1".repeat(64) });
    expect(codeOf(() => validateApproval(baseArgs(b, yamlText, checksum)))).toBe(
      "GATE_CHECKSUM_MISMATCH"
    );
  });

  it("detects a proposal edited on disk after rendering (M2-AT-4)", () => {
    const b = bundle();
    const checksum = proposalChecksumOf(b);
    const args = {
      ...baseArgs(b, approvalYaml({ checksum }), checksum),
      // What was recorded when the proposal was rendered differs from what is on disk now.
      storedProposalHash: "sha256:" + "2".repeat(64),
    };
    expect(codeOf(() => validateApproval(args))).toBe("GATE_PROPOSAL_STALE");
  });

  it("refuses an approvedItemId from another investigation's bundle (M2-AT-6)", () => {
    const b = bundle();
    const checksum = proposalChecksumOf(b);
    const yamlText = approvalYaml({ checksum, items: "  - EXP-777" });
    expect(codeOf(() => validateApproval(baseArgs(b, yamlText, checksum)))).toBe(
      "GATE_REFERENCE_UNKNOWN"
    );
  });

  it("refuses an approval file written for a different investigation", () => {
    const b = bundle();
    const checksum = proposalChecksumOf(b);
    const yamlText = approvalYaml({ checksum, investigationId: "INV-999" });
    expect(codeOf(() => validateApproval(baseArgs(b, yamlText, checksum)))).toBe(
      "GATE_REFERENCE_UNKNOWN"
    );
  });

  it("blocks approval of a destructive action with no acknowledgement (M2-AT-9)", () => {
    const b = bundle();
    const checksum = proposalChecksumOf(b);
    const args = {
      ...baseArgs(b, approvalYaml({ checksum }), checksum),
      classifyDestructive: (item: Record<string, unknown>) =>
        item["itemId"] === "EXP-001" ? ["A2"] : [],
    };
    expect(codeOf(() => validateApproval(args))).toBe("GATE_EDIT_OUT_OF_SURFACE");
  });

  it("accepts a destructive action once acknowledged with a justification", () => {
    const b = bundle();
    const checksum = proposalChecksumOf(b);
    const yamlText = approvalYaml(
      { checksum },
      [
        "safetyAcknowledgements:",
        "  - itemId: EXP-001",
        "    actionId: A2",
        "    classification: destructive",
        "    acknowledged: true",
        '    justification: "Test tenant only; data is regenerated by the fixture."',
      ].join("\n")
    );
    const args = {
      ...baseArgs(b, yamlText, checksum),
      classifyDestructive: (item: Record<string, unknown>) =>
        item["itemId"] === "EXP-001" ? ["A2"] : [],
    };
    expect(validateApproval(args).approvedItemIds).toEqual(["EXP-001"]);
  });

  it("refuses an acknowledgement with an empty justification", () => {
    const b = bundle();
    const checksum = proposalChecksumOf(b);
    const yamlText = approvalYaml(
      { checksum },
      [
        "safetyAcknowledgements:",
        "  - itemId: EXP-001",
        "    actionId: A2",
        "    classification: destructive",
        "    acknowledged: true",
        '    justification: "   "',
      ].join("\n")
    );
    const args = {
      ...baseArgs(b, yamlText, checksum),
      classifyDestructive: (item: Record<string, unknown>) =>
        item["itemId"] === "EXP-001" ? ["A2"] : [],
    };
    expect(codeOf(() => validateApproval(args))).toBe("GATE_EDIT_OUT_OF_SURFACE");
  });

  it("refuses a decidedAt in the future", () => {
    const b = bundle();
    const checksum = proposalChecksumOf(b);
    const yamlText = approvalYaml({ checksum, decidedAt: "2026-09-12T10:00:00.000Z" });
    expect(codeOf(() => validateApproval(baseArgs(b, yamlText, checksum)))).toBe("INPUT_INVALID");
  });

  it("refuses a second decision on the same proposal", () => {
    const b = bundle();
    const checksum = proposalChecksumOf(b);
    const existing: ApprovalRecordRow = {
      approvalId: "APPR-001",
      investigationId: INV,
      gate: "experiment_selection",
      approvalType: "gate_decision",
      proposalChecksum: checksum,
      effectiveProposalChecksum: checksum,
      decision: "approve",
      approverName: "Operator",
      decidedAt: "2026-09-11T10:05:00.000Z",
      recordedAt: "2026-09-11T10:05:01.000Z",
      payloadJson: "{}",
    };
    const args = { ...baseArgs(b, approvalYaml({ checksum }), checksum), approvals: [existing] };
    expect(codeOf(() => validateApproval(args))).toBe("GATE_ALREADY_APPROVED");
  });

  it("refuses malformed YAML and a schema-invalid file before touching any checksum", () => {
    const b = bundle();
    const checksum = proposalChecksumOf(b);
    expect(codeOf(() => validateApproval(baseArgs(b, "gate: [unclosed", checksum)))).not.toBe(
      "NO_ERROR"
    );
    // Unknown key: additionalProperties false, so a typo cannot silently do nothing.
    const typo = approvalYaml({ checksum }) + "\napprovedItems: [EXP-001]\n";
    expect(codeOf(() => validateApproval(baseArgs(b, typo, checksum)))).toBe("INPUT_INVALID");
  });
});

describe("gate ordering and state", () => {
  const approved = (gate: string, checksum = "sha256:aa"): ApprovalRecordRow => ({
    approvalId: `APPR-${gate}`,
    investigationId: INV,
    gate,
    approvalType: "gate_decision",
    proposalChecksum: checksum,
    effectiveProposalChecksum: checksum,
    decision: "approve",
    approverName: "Operator",
    decidedAt: "2026-09-11T10:05:00.000Z",
    recordedAt: "2026-09-11T10:05:01.000Z",
    payloadJson: "{}",
  });

  it("refuses gate 2 before gate 1 and gate 3 before gate 2 (M2-AT gate ordering)", () => {
    expect(codeOf(() => assertGateReachable("target_failure", []))).toBe("GATE_REQUIRED");
    expect(codeOf(() => assertGateReachable("final_reproduction", []))).toBe("GATE_REQUIRED");
    expect(codeOf(() => assertGateReachable("experiment_selection", []))).toBe("NO_ERROR");
    expect(
      codeOf(() => assertGateReachable("target_failure", [approved("experiment_selection")]))
    ).toBe("NO_ERROR");
    expect(
      codeOf(() => assertGateReachable("final_reproduction", [approved("experiment_selection")]))
    ).toBe("GATE_REQUIRED");
  });

  it("derives NOT_REACHED, AWAITING_APPROVAL, APPROVED and SUPERSEDED without mutating records", () => {
    expect(deriveGateStates([])["experiment_selection"].state).toBe("NOT_REACHED");
    expect(
      deriveGateStates([], { experiment_selection: "sha256:new" })["experiment_selection"].state
    ).toBe("AWAITING_APPROVAL");

    const records = [approved("experiment_selection", "sha256:old")];
    expect(deriveGateStates(records)["experiment_selection"].state).toBe("APPROVED");

    // A newly rendered proposal returns the GATE to AWAITING_APPROVAL bound to the new checksum,
    // and marks the earlier decision superseded in the derived view. The record itself is never
    // mutated, which is M2 exit criterion 9.
    const afterRerender = deriveGateStates(records, { experiment_selection: "sha256:new" });
    expect(afterRerender["experiment_selection"].state).toBe("AWAITING_APPROVAL");
    expect(afterRerender["experiment_selection"].proposalChecksum).toBe("sha256:new");
    expect(afterRerender["experiment_selection"].supersededApprovalIds).toEqual([
      "APPR-experiment_selection",
    ]);
    expect(records[0]!.decision).toBe("approve");
    expect(records[0]!.proposalChecksum).toBe("sha256:old");
  });

  it("treats an approval beyond the expiry window as expired but still present (M2-AT-10)", () => {
    const rec = approved("experiment_selection");
    const later = new Date(Date.parse(rec.decidedAt) + 100 * 3600_000);
    expect(isExpired(rec, 72, later)).toBe(true);
    expect(isExpired(rec, 72, new Date(Date.parse(rec.decidedAt) + 3600_000))).toBe(false);
    // Still discoverable: expiry blocks new transitions, it does not erase history.
    expect(approvedRecordFor([rec], "experiment_selection")?.approvalId).toBe(
      "APPR-experiment_selection"
    );
  });
});

describe("rendering and scaffolding", () => {
  it("leads with the falsifier, so approval is a judgement rather than a rubber stamp", () => {
    const b = bundle();
    const md = renderProposalMarkdown(b, proposalChecksumOf(b));
    expect(md).toContain("What would disprove it");
    expect(md).toContain("Results render on every repetition with the short timeout.");
    expect(md).toContain("If that observation would not change your mind");
    expect(md).toContain(proposalChecksumOf(b));
    expect(md).toContain("Humans authorize consequential transitions.");
  });

  it("renders every part of a selector that decides which element is picked", () => {
    /* An authored proposal carries the selectors Playwright's own codegen emits. Rendering only
     * `strategy=value` described this click as `css=div` — thirty matches narrowed to one by a
     * filter the reviewer never saw. Approving that is not consent, so each discriminating part
     * is rendered, `nth` last because it applies after the filter. */
    const b = bundle();
    b.items[0]!["actions"] = [
      {
        actionId: "A1",
        type: "click",
        selector: {
          strategy: "css",
          value: "div",
          filterHasText: "CONTACT US Toll Free",
          nth: 5,
        },
        description:
          "await page.locator('div').filter({ hasText: 'CONTACT US Toll Free' }).nth(5).click();",
      },
      {
        actionId: "A2",
        type: "fill",
        selector: { strategy: "role", role: "textbox", nth: 2 },
        value: { kind: "secretRef", envVar: "ACCOUNT_PASSWORD" },
      },
    ];
    const md = renderProposalMarkdown(b, proposalChecksumOf(b));
    expect(md).toContain('css="div"');
    expect(md).toContain('hasText="CONTACT US Toll Free"');
    expect(md).toContain("nth=5");
    // A role selector with no accessible name used to render as `role=` and nothing else.
    expect(md).toContain("role=textbox");
    // The statement the action was translated from, so the reviewer reads what will run.
    expect(md).toContain("from: await page.locator('div')");
  });

  it("names a secret variable in a rendered action but never its value", () => {
    const b = bundle();
    b.items[0]!["actions"] = [
      {
        actionId: "A1",
        type: "fill",
        selector: { strategy: "role", role: "textbox" },
        value: { kind: "secretRef", envVar: "ACCOUNT_PASSWORD" },
      },
    ];
    const md = renderProposalMarkdown(b, proposalChecksumOf(b));
    expect(md).toContain("value=<ACCOUNT_PASSWORD>");
  });

  it("renders the editable surface so a human knows what they may change", () => {
    const b = bundle();
    const md = renderProposalMarkdown(b, proposalChecksumOf(b));
    expect(md).toContain("/repetitions");
    expect(md).toContain("GATE_EDIT_OUT_OF_SURFACE");
  });

  it("scaffolds a file that validates, and that approves nothing until edited", () => {
    const b = bundle();
    const checksum = proposalChecksumOf(b);
    const yamlText = scaffoldApprovalYaml({
      gate: "experiment_selection",
      investigationId: INV,
      proposalChecksum: checksum,
      bundle: b,
      approverName: "Operator",
      decidedAt: "2026-09-11T10:05:00.000Z",
      classifyDestructive: noDestructive,
    });
    // It is a real, schema-valid approval: the scaffold is a starting point, not a stub.
    const result = validateApproval(baseArgs(b, yamlText, checksum));
    expect(result.approvedItemIds.sort()).toEqual(["EXP-001", "EXP-002"]);
  });

  it("scaffolds destructive actions as a commented template, so acknowledging is deliberate", () => {
    const b = bundle();
    const yamlText = scaffoldApprovalYaml({
      gate: "experiment_selection",
      investigationId: INV,
      proposalChecksum: proposalChecksumOf(b),
      bundle: b,
      approverName: "Operator",
      decidedAt: "2026-09-11T10:05:00.000Z",
      classifyDestructive: (item) => (item["itemId"] === "EXP-001" ? ["A2"] : []),
    });
    // The schema pins `acknowledged` to true, so there is no such thing as a provisional
    // acknowledgement: the scaffold ships an empty list plus a commented template, and the human
    // must write the entry themselves.
    expect(yamlText).toContain("safetyAcknowledgements: []");
    expect(yamlText).toContain("THIS PROPOSAL CONTAINS DESTRUCTIVE ACTIONS");
    expect(yamlText).toContain("#     actionId: A2");
    // No uncommented acknowledgement entry anywhere.
    expect(yamlText).not.toMatch(/^\s+- itemId:/m);
    // And in that state it must NOT validate.
    const checksum = proposalChecksumOf(b);
    const args = {
      ...baseArgs(b, yamlText, checksum),
      classifyDestructive: (item: Record<string, unknown>) =>
        item["itemId"] === "EXP-001" ? ["A2"] : [],
    };
    expect(codeOf(() => validateApproval(args))).toBe("GATE_EDIT_OUT_OF_SURFACE");
  });
});
