import { schemaRegistry } from "@investigator/core";
import { describe, expect, it } from "vitest";

import { translateAuthoredSteps } from "./authoring-actions.js";
import { buildAuthoredGateProposal } from "./authoring-proposal.js";

/**
 * The same real session as `authoring-actions.spec.ts`, with the closing check the measurability
 * gate requires. The statements are verbatim MCP output; only the final `waitFor` is added,
 * because the captured sessions are exactly the ones that ended without one — which is why
 * `whyStepsCannotMeasure` exists.
 */
const SESSION = [
  "await page.goto('https://www.99acres.com/createNewPassword');",
  "await page.getByRole('textbox').nth(2).fill('TestPass123');",
  "await page.getByRole('textbox').nth(3).fill('TestPass123');",
  "await page.getByRole('button', { name: 'Create New Password' }).click();",
  "await page.getByText('Password updated').waitFor({ state: 'visible' });",
];

const PLAN = [
  "# Plan",
  "",
  "1. Open the change-password page while signed in as the supplied account.",
  "2. Fill both password fields and submit.",
].join("\n");

function build(overrides: Partial<Parameters<typeof buildAuthoredGateProposal>[0]> = {}) {
  const t = translateAuthoredSteps(SESSION, {
    secretsByValue: new Map([["TestPass123", "ACCOUNT_PASSWORD"]]),
  });
  if (!t.ok) throw new Error(`translation refused: ${t.reason}`);
  return buildAuthoredGateProposal({
    investigationId: "INV-002",
    actions: t.actions,
    approvedPlan: PLAN,
    reportSummary: "Changing the password silently fails about one time in four.",
    repetitions: 30,
    authoredAt: "2026-09-13T00:00:00.000Z",
    briefVersion: "2.0.0",
    ...overrides,
  });
}

function ok(r: ReturnType<typeof buildAuthoredGateProposal>) {
  if (!r.ok) throw new Error(`expected a proposal, refused: ${r.reason}`);
  return r;
}

describe("the proposal an authoring session hands to the gate", () => {
  it("validates against the same schema `plan --from` asserts", () => {
    // The load-bearing test. `plan --from` runs exactly this assertion, so a proposal that fails
    // here is one the operator could never approve — and the failure would surface as a confusing
    // CLI error at the end of a long session rather than here.
    const r = ok(build());
    expect(() =>
      schemaRegistry().assert("gate-proposal.v1.json", r.proposal, "authoring-proposal.spec")
    ).not.toThrow();
  });

  it("targets the experiment_selection gate", () => {
    const r = ok(build());
    expect(r.proposal["gate"]).toBe("experiment_selection");
  });

  it("carries the repetition count the operator will edit before approving", () => {
    const r = ok(build({ repetitions: 50 }));
    const item = (r.proposal["items"] as Array<Record<string, unknown>>)[0]!;
    expect(item["repetitions"]).toBe(50);
  });

  it("declares repetitionOnly, because an intermittent fault is measured by repeating one flow", () => {
    const item = (ok(build()).proposal["items"] as Array<Record<string, unknown>>)[0]!;
    expect(String(item["variedFactor"])).toContain("repetitionOnly");
  });

  it("takes its hypothesis from the plan the operator already approved", () => {
    const item = (ok(build()).proposal["items"] as Array<Record<string, unknown>>)[0]!;
    expect(String(item["hypothesis"])).toContain("change-password page");
  });

  it("states a falsifier that names the number of runs", () => {
    const item = (
      ok(build({ repetitions: 30 })).proposal["items"] as Array<Record<string, unknown>>
    )[0]!;
    expect(String(item["falsifier"])).toContain("30");
  });

  it("mirrors the closing check as the assertion the run is classified by", () => {
    const item = (ok(build()).proposal["items"] as Array<Record<string, unknown>>)[0]!;
    const assertions = item["assertions"] as Array<Record<string, unknown>>;
    expect(assertions).toHaveLength(1);
    expect(assertions[0]!["kind"]).toBe("elementVisible");
    // False, not true: the watched text appears when the flow WORKS, so treating a match as the
    // failure would report every healthy run as a reproduction.
    expect(assertions[0]!["isFailurePredicate"]).toBe(false);
  });

  it("computes the safety class with the deterministic classifier rather than declaring one", () => {
    const item = (ok(build()).proposal["items"] as Array<Record<string, unknown>>)[0]!;
    const safety = item["safety"] as Record<string, unknown>;
    // A flow that fills two fields and submits is not a read.
    expect(safety["maxSideEffectClass"]).not.toBe("read");
    expect(["local-write", "remote-write", "destructive"]).toContain(safety["maxSideEffectClass"]);
  });

  it("requires the evidence categories the analysis needs to contrast runs", () => {
    const item = (ok(build()).proposal["items"] as Array<Record<string, unknown>>)[0]!;
    // `evidenceCategory` values, not Playwright's names for the same things: the network one is
    // `networkMetadata`, and asking for "request"/"response" fails schema validation.
    expect(item["requiredEvidence"]).toEqual(
      expect.arrayContaining(["console", "exceptions", "networkMetadata", "video"])
    );
  });

  it("never writes a supplied credential into the proposal", () => {
    // The proposal is persisted, content-hashed and read back at the gate. A password in it is a
    // password at rest.
    expect(JSON.stringify(ok(build()).proposal)).not.toContain("TestPass123");
  });

  it("keeps the originating statement on each action, redacted", () => {
    const item = (ok(build()).proposal["items"] as Array<Record<string, unknown>>)[0]!;
    const actions = item["actions"] as Array<Record<string, unknown>>;
    expect(actions).toHaveLength(5);
    const descriptions = actions.map((a) => String(a["description"]));
    expect(descriptions[0]).toContain("page.goto");
    expect(descriptions.join("\n")).toContain("<ACCOUNT_PASSWORD>");
  });
});

describe("refusing to propose something that cannot be measured", () => {
  it("refuses when no translated action can fail", () => {
    const t = translateAuthoredSteps([
      "await page.goto('https://x.test');",
      "await page.getByRole('button', { name: 'Save' }).click();",
    ]);
    if (!t.ok) throw new Error("fixture should translate");
    const r = buildAuthoredGateProposal({
      investigationId: "INV-002",
      actions: t.actions,
      approvedPlan: PLAN,
      repetitions: 30,
      authoredAt: "2026-09-13T00:00:00.000Z",
      briefVersion: "2.0.0",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/no check that can fail/);
  });

  it("refuses an empty action list", () => {
    const r = buildAuthoredGateProposal({
      investigationId: "INV-002",
      actions: [],
      approvedPlan: PLAN,
      repetitions: 30,
      authoredAt: "2026-09-13T00:00:00.000Z",
      briefVersion: "2.0.0",
    });
    expect(r.ok).toBe(false);
  });
});
