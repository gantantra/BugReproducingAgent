import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { SchemaRegistry, schemaRegistry } from "@investigator/core";

/**
 * Every flow's few-shot examples must satisfy the schema that flow's output is validated against.
 *
 * Playwright produces evidence. Deterministic software normalizes and measures evidence. DeepSeek interprets and prioritizes evidence. Humans authorize consequential transitions.
 *
 * This exists because the two had silently diverged. `intake_to_flow` shipped examples of a bare
 * Flow (`{flowId, steps, unknowns}`) while `intake.output.v1.json` required an envelope
 * (`{schemaVersion, flow, groundingNotes}`) with unknown fields rejected. Every live call would
 * have produced AI_INVALID_OUTPUT, and nothing caught it because the flow had never run against a
 * real provider.
 *
 * Few-shot examples are not documentation. They are the strongest instruction the model receives
 * about output shape, so an example that contradicts the schema is a prompt that actively teaches
 * the model to fail validation.
 */

const FLOWS_ROOT = join(process.cwd(), "ai", "flows");

interface FlowDef {
  id: string;
  outputSchema: string;
  inputSchema?: string;
}

const flowIds = existsSync(FLOWS_ROOT)
  ? readdirSync(FLOWS_ROOT, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
  : [];

describe("flow few-shot examples match their declared output schema", () => {
  it("there is at least one flow to check", () => {
    expect(flowIds.length).toBeGreaterThan(0);
  });

  describe.each(flowIds)("%s", (flowId) => {
    const dir = join(FLOWS_ROOT, flowId);
    const def = parseYaml(readFileSync(join(dir, "flow.yaml"), "utf8")) as FlowDef;
    const schemaName = def.outputSchema.replace(/^schemas\//, "");
    const examplesPath = join(dir, "examples.jsonl");

    const examples = existsSync(examplesPath)
      ? readFileSync(examplesPath, "utf8")
          .split("\n")
          .filter((l) => l.trim().length > 0)
          .map((l, i) => ({ line: i + 1, parsed: JSON.parse(l) as { output?: unknown } }))
      : [];

    it("declares an output schema the registry knows", () => {
      expect(schemaRegistry().has(schemaName)).toBe(true);
    });

    it("has examples to learn from", () => {
      expect(examples.length).toBeGreaterThan(0);
    });

    it.each(examples)("example on line $line validates", ({ parsed }) => {
      const result = schemaRegistry().check(schemaName, parsed.output);
      // The failure message carries the actual errors: a bare "expected true" would send the
      // next person back to re-derive what this test already knows.
      expect(
        result.ok,
        result.ok ? "" : `${schemaName}: ${SchemaRegistry.formatErrors(result.errors)}`
      ).toBe(true);
    });
  });
});
