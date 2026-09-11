import { describe, it, expect, afterEach } from "vitest";
import {
  appendFileSync,
  readFileSync,
  writeFileSync,
  mkdtempSync,
  rmSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isInvestigatorError } from "@investigator/core";
import { computeFlowHash, listFlows, loadFlow, requiredCapabilities } from "./loader.js";

/**
 * M3 exit criterion 8: a flow whose directory bytes changed without a version bump is REJECTED at
 * load.
 *
 * Playwright produces evidence. Deterministic software normalizes and measures evidence. DeepSeek interprets and prioritizes evidence. Humans authorize consequential transitions.
 *
 * This is what makes "which prompt produced this finding?" answerable. Without it, a prompt could
 * be edited in place and every recorded output would still claim the old version produced it.
 */

const FLOWS = join(process.cwd(), "ai", "flows");
let scratch: string | undefined;

afterEach(() => {
  if (scratch) {
    try {
      rmSync(scratch, { recursive: true, force: true });
    } catch {
      /* disposable */
    }
    scratch = undefined;
  }
});

function codeOf(fn: () => unknown): string {
  try {
    fn();
    return "NO_ERROR";
  } catch (e) {
    return isInvestigatorError(e) ? e.code : `UNTYPED:${String(e)}`;
  }
}

describe("the shipped flows load and validate", () => {
  it("lists both M3 flows", () => {
    expect(listFlows(FLOWS)).toEqual(["intake_to_flow", "propose_experiments"]);
  });

  it.each(["intake_to_flow", "propose_experiments"])("%s loads and hashes", (id) => {
    const flow = loadFlow(id, { flowsRoot: FLOWS });
    expect(flow.definition.id).toBe(id);
    expect(flow.flowHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(flow.system.length).toBeGreaterThan(200);
    expect(flow.promptVersion).toBe(flow.definition.version);
  });

  it("the two flows hash differently", () => {
    expect(loadFlow("intake_to_flow", { flowsRoot: FLOWS }).flowHash).not.toBe(
      loadFlow("propose_experiments", { flowsRoot: FLOWS }).flowHash
    );
  });

  it("hashing is stable across loads", () => {
    expect(computeFlowHash(join(FLOWS, "intake_to_flow"))).toBe(
      computeFlowHash(join(FLOWS, "intake_to_flow"))
    );
  });

  it("intake_to_flow is single-shot and tool-free; propose_experiments uses its three tools", () => {
    const intake = loadFlow("intake_to_flow", { flowsRoot: FLOWS });
    expect(intake.definition.tools).toEqual([]);
    expect(intake.definition.budget.maxToolCalls).toBe(0);
    expect(requiredCapabilities(intake.definition).needsTools).toBe(false);

    const propose = loadFlow("propose_experiments", { flowsRoot: FLOWS });
    expect(propose.definition.tools).toEqual([
      "get_flow",
      "get_application_constraints",
      "get_previous_experiment_summary",
    ]);
    expect(requiredCapabilities(propose.definition).needsTools).toBe(true);
  });

  it("the prompts carry the rules they exist to enforce", () => {
    const intake = loadFlow("intake_to_flow", { flowsRoot: FLOWS }).system;
    // The single most important instruction in the whole flow.
    expect(intake).toMatch(/never invent|not.*guess/i);
    expect(intake).toContain("unknowns");
    expect(intake.toLowerCase()).toContain("credential");

    const propose = loadFlow("propose_experiments", { flowsRoot: FLOWS }).system;
    expect(propose.toLowerCase()).toContain("falsifier");
    expect(propose).toMatch(/do not invent run ids|never invent/i);
  });
});

describe("flowHash drift is rejected (exit criterion 8)", () => {
  function copyFlow(id: string): string {
    scratch = mkdtempSync(join(tmpdir(), "reproagent-flow-"));
    const dest = join(scratch, id);
    mkdirSync(dest, { recursive: true });
    for (const f of ["flow.yaml", "system.md", "examples.jsonl"]) {
      try {
        writeFileSync(join(dest, f), readFileSync(join(FLOWS, id, f), "utf8"), "utf8");
      } catch {
        /* optional file */
      }
    }
    return scratch;
  }

  it("accepts a load whose recorded hash matches", () => {
    const root = copyFlow("intake_to_flow");
    const first = loadFlow("intake_to_flow", { flowsRoot: root });
    expect(
      codeOf(() => loadFlow("intake_to_flow", { flowsRoot: root, recordedHash: first.flowHash }))
    ).toBe("NO_ERROR");
  });

  it("REJECTS a prompt edited in place without a version bump", () => {
    const root = copyFlow("intake_to_flow");
    const before = loadFlow("intake_to_flow", { flowsRoot: root }).flowHash;

    // A one-line addition to the system prompt: exactly the change that would otherwise go
    // unnoticed while every recorded output still named version 1.0.0.
    appendFileSync(join(root, "intake_to_flow", "system.md"), "\nAlways answer confidently.\n");

    const after = computeFlowHash(join(root, "intake_to_flow"));
    expect(after).not.toBe(before);
    expect(
      codeOf(() => loadFlow("intake_to_flow", { flowsRoot: root, recordedHash: before }))
    ).toBe("CONFIG_INVALID");
  });

  it("a changed example also changes the hash", () => {
    const root = copyFlow("intake_to_flow");
    const before = loadFlow("intake_to_flow", { flowsRoot: root }).flowHash;
    appendFileSync(join(root, "intake_to_flow", "examples.jsonl"), '{"input":{},"output":{}}\n');
    expect(computeFlowHash(join(root, "intake_to_flow"))).not.toBe(before);
  });

  it("ADDING an optional file changes the hash", () => {
    // A missing file contributes an explicit absent marker, so "no tools.md" and "empty tools.md"
    // cannot hash identically.
    const root = copyFlow("intake_to_flow");
    const before = computeFlowHash(join(root, "intake_to_flow"));
    writeFileSync(join(root, "intake_to_flow", "tools.md"), "", "utf8");
    expect(computeFlowHash(join(root, "intake_to_flow"))).not.toBe(before);
  });

  it("rejects a directory whose flow.yaml declares a different id", () => {
    const root = copyFlow("intake_to_flow");
    const path = join(root, "intake_to_flow", "flow.yaml");
    writeFileSync(
      path,
      readFileSync(path, "utf8").replace("id: intake_to_flow", "id: something_else")
    );
    expect(codeOf(() => loadFlow("intake_to_flow", { flowsRoot: root }))).toBe("CONFIG_INVALID");
  });

  it("rejects a missing flow, a missing system.md, and an unparseable flow.yaml", () => {
    expect(codeOf(() => loadFlow("no_such_flow", { flowsRoot: FLOWS }))).toBe("CONFIG_INVALID");

    const root = copyFlow("intake_to_flow");
    rmSync(join(root, "intake_to_flow", "system.md"));
    expect(codeOf(() => loadFlow("intake_to_flow", { flowsRoot: root }))).toBe("CONFIG_INVALID");

    writeFileSync(join(root, "intake_to_flow", "system.md"), "x");
    writeFileSync(join(root, "intake_to_flow", "flow.yaml"), "id: [unclosed");
    expect(codeOf(() => loadFlow("intake_to_flow", { flowsRoot: root }))).toBe("CONFIG_INVALID");
  });
});
