import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ACTION_TYPES, ASSERTION_KINDS, SIDE_EFFECT_CLASSES } from "@investigator/core";

/**
 * The closed vocabularies exist twice: as TypeScript constants the CLI hands to a model, and as
 * JSON Schema enums the validator enforces. If the two drift, a flow is told one vocabulary and
 * judged against another — and the failure surfaces as a discarded interpretation with an error
 * about a value the model was never warned about.
 *
 * That is not hypothetical. A live call invented an assertion kind, was rejected, and the reason
 * it could was that nothing had ever listed the alternatives. Telling the model the vocabulary
 * only helps while the list stays true.
 */

const ROOT = resolve(__dirname, "..", "..");

function schema(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(resolve(ROOT, "schemas", name), "utf8")) as Record<string, unknown>;
}

describe("closed vocabularies match the schemas that enforce them", () => {
  it("ACTION_TYPES equals action.v1.json's type enum", () => {
    const doc = schema("action.v1.json");
    const props = doc["properties"] as Record<string, Record<string, unknown>>;
    expect(props["type"]!["enum"]).toEqual([...ACTION_TYPES]);
  });

  it("ASSERTION_KINDS equals the assertion $def's kind enum", () => {
    const doc = schema("action.v1.json");
    const defs = doc["$defs"] as Record<string, Record<string, unknown>>;
    const props = defs["assertion"]!["properties"] as Record<string, Record<string, unknown>>;
    expect(props["kind"]!["enum"]).toEqual([...ASSERTION_KINDS]);
  });

  it("SIDE_EFFECT_CLASSES equals common.v1.json's sideEffectClass enum", () => {
    const doc = schema("common.v1.json");
    const defs = doc["$defs"] as Record<string, Record<string, unknown>>;
    expect(defs["sideEffectClass"]!["enum"]).toEqual([...SIDE_EFFECT_CLASSES]);
  });
});
