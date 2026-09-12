import { describe, it, expect } from "vitest";
import { failureDetail, schemaRegistry, SchemaRegistry, type ValidationFailure } from "./schema.js";
import { isInvestigatorError } from "./errors.js";

/**
 * Schema failure diagnostics.
 *
 * A schema rejection that does not say WHICH property was rejected forces the operator to re-run
 * a paid, non-deterministic provider call just to learn the field name. That happened on a live
 * `intake --ai` run: the only diagnostic was "/flow must NOT have additional properties", which
 * names neither the property nor anything actionable.
 *
 * These assert the detail is present AND that only schema-side identifiers leak into it — never
 * an instance value, which may hold evidence that has not been through redaction.
 */

function failure(keyword: string, params: Record<string, unknown>): ValidationFailure {
  return { instancePath: "/flow", schemaPath: "#/x", keyword, message: "m", params };
}

describe("failureDetail", () => {
  it("names the offending property for additionalProperties", () => {
    expect(failureDetail(failure("additionalProperties", { additionalProperty: "severity" }))).toBe(
      " [offending property: severity]"
    );
  });

  it("names the missing property for required", () => {
    expect(failureDetail(failure("required", { missingProperty: "unknowns" }))).toBe(
      " [missing property: unknowns]"
    );
  });

  it("lists the schema's allowed values for enum, truncating a long set", () => {
    expect(failureDetail(failure("enum", { allowedValues: ["low", "high"] }))).toBe(
      " [allowed: low, high]"
    );

    const many = Array.from({ length: 11 }, (_, i) => `v${i}`);
    const rendered = failureDetail(failure("enum", { allowedValues: many }));
    expect(rendered).toContain("v0, v1, v2, v3, v4, v5, v6, v7");
    expect(rendered).toContain("+3 more");
    expect(rendered).not.toContain("v8");
  });

  it("adds nothing for keywords that carry no identifying param", () => {
    expect(failureDetail(failure("minItems", { limit: 1 }))).toBe("");
    expect(failureDetail(failure("type", { type: "string" }))).toBe("");
  });

  it("ignores a non-string property name rather than rendering an object", () => {
    expect(failureDetail(failure("additionalProperties", { additionalProperty: { a: 1 } }))).toBe(
      ""
    );
  });
});

describe("schema failures name the field, end to end", () => {
  const valid = {
    schemaVersion: "1.0.0",
    flowId: "FLOW-001",
    investigationId: "INV-001",
    title: "t",
    steps: [
      {
        stepId: "S1",
        description: "d",
        sourceQuote: "q",
        actions: [{ actionId: "A1", type: "goto", url: "/x" }],
      },
    ],
    assumptions: [],
    unknowns: [],
  };

  it("formatErrors names an unexpected property", () => {
    const result = schemaRegistry().check("flow.v1.json", { ...valid, severity: "high" });
    expect(result.ok).toBe(false);
    expect(SchemaRegistry.formatErrors(result.errors)).toContain("[offending property: severity]");
  });

  it("assert carries the detail in subReason and firstMessage", () => {
    try {
      schemaRegistry().assert("flow.v1.json", { ...valid, severity: "high" }, "AI output");
      expect.unreachable("assert should have thrown");
    } catch (e) {
      expect(isInvestigatorError(e)).toBe(true);
      const err = e as { subReason?: string; context?: Record<string, unknown> };
      expect(err.subReason).toContain("[offending property: severity]");
      expect(String(err.context?.["firstMessage"])).toContain("[offending property: severity]");
      // The gateway classifies unknown_field by substring; appending must not break that.
      expect(String(err.context?.["firstMessage"])).toContain("additional propert");
    }
  });

  it("a valid flow still validates", () => {
    expect(schemaRegistry().check("flow.v1.json", valid).ok).toBe(true);
  });
});
