import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { canonicalJson, isInvestigatorError } from "@investigator/core";
import type { RedactionStamp } from "@investigator/core";
import {
  assertToolResultSafe,
  capItems,
  type Tool,
  type ToolContext,
  type ToolResult,
} from "./index.js";
import {
  makeGetApplicationConstraints,
  makeGetFlow,
  makeGetPreviousExperimentSummary,
  PROPOSE_EXPERIMENTS_TOOLS,
} from "./read-tools.js";

/**
 * M3-AT-11: the shared tool contract, applied to every registered tool.
 *
 * Playwright produces evidence. Deterministic software normalizes and measures evidence. DeepSeek interprets and prioritizes evidence. Humans authorize consequential transitions.
 *
 * A tool is the only way a model sees evidence, so these invariants are a security boundary. The
 * network-stubbed test is not ceremony: it proves the read-only claim rather than asserting it.
 */

const REDACTION: RedactionStamp = {
  policyId: "default",
  policyVersion: "1.0.0",
  policyHash: "sha256:test",
  mode: "strict",
  appliedRules: [],
};

const INV = "INV-001";

function ctx(over: Partial<ToolContext> = {}): ToolContext {
  return {
    investigationId: INV,
    normalizerVersion: "1.0.0",
    extractorVersion: "1.0.0",
    redaction: REDACTION,
    captureStatus: { actions: "complete", console: "complete", networkMetadata: "complete" },
    ...over,
  };
}

const flowFacts = {
  flowId: "FLOW-001",
  flowVersion: "1.0.0",
  targetName: "staging",
  steps: [
    {
      stepId: "S1",
      description: "Open search and filter",
      actions: [{ actionId: "A1", type: "goto", url: "/search" }],
      assertions: [{ assertionId: "AS1", kind: "elementCountAtLeast" }],
    },
  ],
  unknowns: [
    { unknownId: "U1", field: "credentials", why: "the reporter did not supply an account" },
  ],
};

const constraints = {
  targetName: "staging",
  classification: "staging",
  allowedOrigins: ["https://staging.example.internal"],
  resetStrategy: "fresh-context",
  blockDestructiveActions: true,
  maxRunsPerInvestigation: 200,
  permittedActionTypes: ["goto", "click", "waitFor", "assert"],
  emulationProfiles: ["desktop-chrome-1440", "pixel-7-chrome-mobile"],
};

const previous = [
  {
    experimentId: "EXP-001",
    runs: [
      { runId: "RUN-001", outcome: "PRODUCT_FAILED", outcomeRuleId: 4 },
      { runId: "RUN-002", outcome: "VALID_COMPLETED", outcomeRuleId: 5 },
    ],
    counts: { PRODUCT_FAILED: 1, VALID_COMPLETED: 1 },
    hypothesis: "A race between two responses",
    variedFactor: "client timeout",
    distinctExceptionFingerprints: [{ fingerprint: "abc123", count: 1 }],
    consoleErrorCount: 1,
  },
];

const TOOLS: Array<{ tool: Tool<never, unknown>; input: unknown }> = [
  { tool: makeGetFlow(() => flowFacts) as never, input: { investigationId: INV } },
  {
    tool: makeGetApplicationConstraints(() => constraints) as never,
    input: { investigationId: INV },
  },
  {
    tool: makeGetPreviousExperimentSummary(() => previous) as never,
    input: { investigationId: INV },
  },
];

describe("the three propose_experiments tools are registered", () => {
  it("matches the M3 allowlist exactly", () => {
    expect(TOOLS.map((t) => t.tool.id).sort()).toEqual([...PROPOSE_EXPERIMENTS_TOOLS].sort());
  });
});

describe.each(TOOLS)("tool contract: $tool.id", ({ tool, input }) => {
  it("invariant 1: returns a well-formed result with provenance", async () => {
    const r = (await tool.run(input as never, ctx())) as ToolResult<unknown>;
    expect(r.toolId).toBe(tool.id);
    expect(r.toolVersion).toBeTruthy();
    expect(r.ok).toBe(true);
    expect(r.provenance.investigationId).toBe(INV);
    expect(r.provenance.normalizerVersion).toBeTruthy();
    expect(r.provenance.extractorVersion).toBeTruthy();
  });

  it("invariant 2: no raw bytes, no base64 blob, within the size ceiling", async () => {
    const r = (await tool.run(input as never, ctx())) as ToolResult<unknown>;
    expect(() => assertToolResultSafe(r)).not.toThrow();
    const serialized = canonicalJson(r);
    expect(serialized).not.toMatch(/data:[a-z]+\/[a-z0-9.+-]+;base64,/i);
  });

  it("invariant 4: carries a non-empty redaction stamp", async () => {
    const r = (await tool.run(input as never, ctx())) as ToolResult<unknown>;
    expect(r.provenance.redaction.policyId).toBeTruthy();
    expect(r.provenance.redaction.mode).toBe("strict");
  });

  it("invariant 5: the capture-status slice covers what was read", async () => {
    const r = (await tool.run(input as never, ctx())) as ToolResult<unknown>;
    expect(Object.keys(r.provenance.captureStatusSlice).length).toBeGreaterThan(0);
  });

  it("invariant 8: determinism — same input and unchanged store, byte-identical output", async () => {
    const a = (await tool.run(input as never, ctx())) as ToolResult<unknown>;
    const b = (await tool.run(input as never, ctx())) as ToolResult<unknown>;
    expect(canonicalJson(a)).toBe(canonicalJson(b));
  });

  it("refuses to read outside the investigation it was invoked for", async () => {
    // Otherwise one investigation's evidence could support another's finding.
    const r = (await tool.run(
      { ...(input as object), investigationId: "INV-999" } as never,
      ctx()
    )) as ToolResult<unknown>;
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("OUT_OF_SCOPE");
  });
});

describe("invariant 7: tools perform no network egress", () => {
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    // Any attempt to reach the network fails loudly. This proves the read-only claim rather than
    // asserting it: a tool that quietly fetched would fail here.
    globalThis.fetch = (() => {
      throw new Error("network access is forbidden inside a tool");
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it.each(TOOLS)("$tool.id runs with the network stubbed to throw", async ({ tool, input }) => {
    const r = (await tool.run(input as never, ctx())) as ToolResult<unknown>;
    expect(r.ok).toBe(true);
  });
});

describe("invariant 3: every citable datum carries an id", () => {
  it("runs are cited by runId, exceptions by fingerprint, unknowns by unknownId", async () => {
    const r = await makeGetPreviousExperimentSummary(() => previous).run(
      { investigationId: INV },
      ctx()
    );
    for (const exp of r.data!.experiments) {
      for (const run of exp.runs) expect(run.runId).toMatch(/^RUN-/);
      for (const f of exp.distinctExceptionFingerprints) expect(f.fingerprint).toBeTruthy();
    }
    // And the runs are surfaced in provenance, so a citation is checkable against the tool call.
    expect(r.provenance.runIds).toContain("RUN-001");

    const flow = await makeGetFlow(() => flowFacts).run({ investigationId: INV }, ctx());
    for (const u of flow.data!.unknowns) expect(u.unknownId).toMatch(/^U/);
  });
});

describe("invariant 6: truncation is explicit", () => {
  it("reports what was omitted instead of quietly shortening the list", () => {
    const { items, truncation } = capItems([1, 2, 3, 4, 5], 2);
    expect(items).toEqual([1, 2]);
    expect(truncation).toEqual({ truncated: true, omittedCount: 3, reason: "MAX_ITEMS" });
  });

  it("sets no truncation marker when nothing was omitted", () => {
    expect(capItems([1, 2], 5).truncation).toBeUndefined();
  });

  it("a capped tool result carries the marker through to the model", async () => {
    const many = Array.from({ length: 10 }, (_, i) => ({
      ...previous[0]!,
      experimentId: `EXP-${i}`,
    }));
    const r = await makeGetPreviousExperimentSummary(() => many).run(
      { investigationId: INV },
      ctx({ maxItems: 3 })
    );
    expect(r.data!.experiments).toHaveLength(3);
    expect(r.truncation?.omittedCount).toBe(7);
  });
});

describe("assertToolResultSafe blocks an unsafe result before it reaches the provider", () => {
  const base = (data: unknown): ToolResult<unknown> => ({
    toolId: "t",
    toolVersion: "1",
    ok: true,
    data,
    provenance: {
      investigationId: INV,
      runIds: [],
      normalizerVersion: "1",
      extractorVersion: "1",
      redaction: REDACTION,
      captureStatusSlice: {},
    },
  });

  const codeOf = (fn: () => unknown): string => {
    try {
      fn();
      return "NO_ERROR";
    } catch (e) {
      return isInvestigatorError(e) ? e.code : "UNTYPED";
    }
  };

  it("M3-AT-15: blocks a deliberately unredacted result", () => {
    const noStamp = base({ x: 1 });
    (noStamp.provenance as { redaction: unknown }).redaction = { policyId: "" };
    expect(codeOf(() => assertToolResultSafe(noStamp))).toBe("TOOL_RESULT_UNSAFE");
  });

  it("blocks a data: URI and a base64 blob", () => {
    expect(codeOf(() => assertToolResultSafe(base({ img: "data:image/png;base64,AAAA" })))).toBe(
      "TOOL_RESULT_UNSAFE"
    );
    expect(codeOf(() => assertToolResultSafe(base({ blob: "A".repeat(600) })))).toBe(
      "TOOL_RESULT_UNSAFE"
    );
  });

  it("blocks a result over its size ceiling", () => {
    expect(codeOf(() => assertToolResultSafe(base({ text: "x".repeat(5000) }), 1000))).toBe(
      "TOOL_RESULT_TOO_LARGE"
    );
  });

  it("passes a well-formed result", () => {
    expect(codeOf(() => assertToolResultSafe(base({ count: 3 })))).toBe("NO_ERROR");
  });
});

describe("M3-AT-8: a tool never invents a value", () => {
  it("surfaces what the reporter did not supply as an explicit unknown", async () => {
    const r = await makeGetFlow(() => flowFacts).run({ investigationId: INV }, ctx());
    expect(r.data!.unknowns[0]).toMatchObject({ field: "credentials" });
    // The tool reports the absence rather than filling it. A plausible-looking invented
    // credential is worse than a gap, because a gap is visible.
    expect(canonicalJson(r)).not.toMatch(/password|secret|api[_-]?key/i);
  });
});
