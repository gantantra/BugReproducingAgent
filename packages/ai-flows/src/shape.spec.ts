import { describe, it, expect } from "vitest";
import { fillSchemaConstants, requiredShape } from "./runner.js";

/**
 * The outline the model is actually shown.
 *
 * Every live prompt-shape failure in this project has had the same root cause: the describer met
 * a JSON Schema keyword it did not walk, said nothing about it, and the model's reasonable guess
 * was rejected by a validator whose error named something else entirely. It happened with
 * `allOf`/`if`/`then` (a dropped `url`, an `assertion` sent as a string) and again with `oneOf`
 * (a `secretRef` rejected for "must have required property 'literal'").
 *
 * So the outline is asserted here rather than read once and trusted. A schema change that the
 * describer cannot express should fail a test, not a production call.
 */

function outline(): string {
  return requiredShape("intake.output.v1.json").join("\n");
}

describe("the generated output shape", () => {
  it("names the top-level envelope, not just the flow inside it", () => {
    expect(outline()).toContain("intake.output.v1.json requires:");
  });

  it("describes the conditional branches of an action", () => {
    const text = outline();
    // A goto without `url` was a real rejection; the model was never told the field existed.
    expect(text).toMatch(/when type=.*goto.*also requires url/);
  });

  it("describes a nested object by its own required fields, enums included", () => {
    const text = outline();
    expect(text).toContain("assertion (an object requiring: assertionId, kind (one of:");
    // A closed set the model was never shown is one it can only guess at. It guessed, and the
    // whole interpretation was discarded for an assertion kind that does not exist.
    expect(text).toContain("noConsoleErrors");
    expect(text).toContain("elementVisible");
  });

  it("describes the four shapes a fill value may take", () => {
    const text = outline();
    // The failure this was written for: the model emitted a secretRef and was told to add
    // `literal`, the first alternative's field, for a branch it never chose.
    expect(text).toMatch(/when type=.*fill.*value \(exactly one of:/);
    for (const kind of ["literal", "generated", "secretRef", "unknown"]) {
      expect(text, kind).toContain(`kind: "${kind}"`);
    }
    // And the field each shape carries, so a repair has somewhere to go.
    expect(text).toContain("envVar");
    expect(text).toContain("generator");
    expect(text).toContain("unknownId");
  });

  it("says a nullable field may be null, so it is not simply dropped", () => {
    expect(outline()).toContain("(may be null)");
  });

  it("is an outline, not the whole document", () => {
    // Resolving every $ref would cost more input budget than the evidence being reasoned about.
    expect(outline().length).toBeLessThan(4000);
  });
});

describe("filling what the schema already decides", () => {
  it("fills a required const the model omitted, at every level", () => {
    // The live failure: a complete interpretation of a real bug report, discarded because
    // `schemaVersion` — a const, appearing twice — was not restated.
    const value: Record<string, unknown> = {
      flow: {
        flowId: "FLOW-001",
        investigationId: "INV-001",
        title: "t",
        steps: [],
        assumptions: [],
        unknowns: [],
      },
      groundingNotes: [{ stepId: "S1", sourceQuote: "q", interpretation: "i" }],
    };
    fillSchemaConstants("intake.output.v1.json", value);
    expect(value["schemaVersion"]).toBe("1.0.0");
    expect((value["flow"] as Record<string, unknown>)["schemaVersion"]).toBe("1.0.0");
  });

  it("leaves a value the model did supply exactly as it was", () => {
    const value: Record<string, unknown> = { schemaVersion: "9.9.9", groundingNotes: [] };
    fillSchemaConstants("intake.output.v1.json", value);
    // Wrong, and it stays wrong so validation can reject it. Filling is for ABSENT fields only.
    expect(value["schemaVersion"]).toBe("9.9.9");
  });

  it("never invents a missing object", () => {
    // `flow` is required and absent. Creating an empty one would turn "the model produced
    // nothing" into "the model produced an empty flow", which is a different and false claim.
    const value: Record<string, unknown> = { groundingNotes: [] };
    fillSchemaConstants("intake.output.v1.json", value);
    expect(value["flow"]).toBeUndefined();
  });

  it("never chooses from an enum or supplies a default", () => {
    // An action's `type` is a closed enum, not a const: picking one is a judgement the model was
    // supposed to make, and that is exactly what validation exists to catch.
    const value: Record<string, unknown> = {
      flow: {
        flowId: "FLOW-001",
        investigationId: "INV-001",
        title: "t",
        assumptions: [],
        unknowns: [],
        steps: [{ stepId: "S1", description: "d", actions: [{ actionId: "A1" }] }],
      },
      groundingNotes: [],
    };
    fillSchemaConstants("intake.output.v1.json", value);
    const action = (
      ((value["flow"] as Record<string, unknown>)["steps"] as Array<Record<string, unknown>>)[0]!
        .actions as Array<Record<string, unknown>>
    )[0]!;
    expect(action["type"]).toBeUndefined();
  });

  it("does not throw on a schema it does not know", () => {
    expect(() => fillSchemaConstants("not-a-real-schema.json", { a: 1 })).not.toThrow();
  });
});
