import { describe, it, expect } from "vitest";
import { requiredShape } from "./runner.js";

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
