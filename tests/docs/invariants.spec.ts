import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  CAPTURE_STATUS_VALUES,
  ERROR_CODES,
  EVIDENCE_CATEGORIES,
  EXIT,
  FINDING_LEVELS,
  GOVERNING_PRINCIPLE,
  LEGAL_TERMINAL_OUTCOMES,
  RUN_OUTCOMES,
  ERROR_SPEC,
} from "@investigator/core";
import { MIGRATIONS } from "@investigator/storage";

/**
 * The M0 documentation and schema invariants (docs/acceptance-tests/M0-doc-checks.md),
 * enforced in CI from M1 onward.
 *
 * The bidirectional checks matter most: a one-way check lets the code grow a value the docs do
 * not mention, which is how vocabularies rot.
 */

const ROOT = process.cwd();

function mdFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...mdFiles(p));
    else if (entry.endsWith(".md")) out.push(p);
  }
  return out;
}

function read(p: string): string {
  return readFileSync(join(ROOT, p), "utf8");
}

describe("M0-AT-1 governing principle", () => {
  const required = ["CLAUDE.md", "docs/architecture/overview.md"];

  it.each(required)("%s contains the principle verbatim", (f) => {
    // Character-for-character. A paraphrase is exactly the drift this check exists to catch.
    expect(read(f)).toContain(GOVERNING_PRINCIPLE);
  });

  it("every ADR touching execution, evidence, or AI contains it verbatim", () => {
    const adrs = readdirSync(join(ROOT, "docs/adrs")).filter((f) => f.startsWith("ADR-"));
    expect(adrs.length).toBeGreaterThanOrEqual(20);

    const missing: string[] = [];
    for (const a of adrs) {
      const text = read(join("docs/adrs", a));
      const m = /^touches:\s*\[(.*?)\]/m.exec(text);
      const touches = m?.[1]?.split(",").map((s) => s.trim()) ?? [];
      const needs = touches.some((t) => ["execution", "evidence", "ai"].includes(t));
      if (needs && !text.includes(GOVERNING_PRINCIPLE)) missing.push(a);
    }
    expect(missing, `ADRs missing the governing principle: ${missing.join(", ")}`).toHaveLength(0);
  });

  it("the constant in code matches the documented sentence exactly", () => {
    expect(GOVERNING_PRINCIPLE).toBe(
      "Playwright produces evidence. Deterministic software normalizes and measures evidence. " +
        "DeepSeek interprets and prioritizes evidence. Humans authorize consequential transitions."
    );
  });
});

describe("M0-AT-2 and M0-AT-3 schemas", () => {
  const schemaFiles = readdirSync(join(ROOT, "schemas")).filter((f) => f.endsWith(".json"));

  it("every schema parses and declares $id and $schema", () => {
    expect(schemaFiles.length).toBeGreaterThanOrEqual(20);
    for (const f of schemaFiles) {
      const parsed = JSON.parse(read(join("schemas", f))) as Record<string, unknown>;
      expect(parsed["$schema"], `${f} has no $schema`).toBeTruthy();
      expect(parsed["$id"], `${f} has no $id`).toBeTruthy();
    }
  });

  it("M0-AT-3a: exactly the five declared schemas are exempt from schemaVersion", () => {
    const EXEMPT = new Set([
      "common.v1.json",
      "action.v1.json",
      "config.v1.json",
      "flow-artifact.v1.json",
      "redaction-policy.v1.json",
    ]);
    const actualExempt = new Set<string>();
    for (const f of schemaFiles) {
      const parsed = JSON.parse(read(join("schemas", f))) as {
        properties?: Record<string, unknown>;
      };
      if (!parsed.properties?.["schemaVersion"]) actualExempt.add(f);
    }
    // Bidirectional: no new exemption may appear, and none may silently disappear.
    expect([...actualExempt].sort()).toEqual([...EXEMPT].sort());
  });

  it("object subschemas close additional properties", () => {
    for (const f of schemaFiles) {
      const parsed = JSON.parse(read(join("schemas", f))) as Record<string, unknown>;
      const offenders: string[] = [];
      const walk = (node: unknown, path: string): void => {
        if (!node || typeof node !== "object" || Array.isArray(node)) return;
        const obj = node as Record<string, unknown>;
        if (obj["type"] === "object" && obj["properties"]) {
          const closed =
            obj["additionalProperties"] === false ||
            obj["unevaluatedProperties"] === false ||
            // A map-shaped object legitimately uses a schema for additionalProperties.
            (obj["additionalProperties"] !== undefined && typeof obj["additionalProperties"] === "object");
          if (!closed) offenders.push(path);
        }
        for (const [k, v] of Object.entries(obj)) walk(v, `${path}/${k}`);
      };
      walk(parsed, f);
      expect(offenders, `${f} has open object subschemas at: ${offenders.join(", ")}`).toHaveLength(0);
    }
  });
});

describe("M0-AT-8 through M0-AT-12 vocabulary agreement", () => {
  it("CaptureStatus categories agree between code, schema, and docs", () => {
    const schema = JSON.parse(read("schemas/capture-status.v1.json")) as {
      properties: { categories: { required: string[] } };
    };
    expect([...schema.properties.categories.required].sort()).toEqual(
      [...EVIDENCE_CATEGORIES].sort()
    );

    const doc = read("docs/architecture/capture-completeness.md");
    for (const cat of EVIDENCE_CATEGORIES) {
      expect(doc, `capture-completeness.md never mentions ${cat}`).toContain(cat);
    }
  });

  it("CaptureStatus values agree between code, schema, and docs", () => {
    const common = JSON.parse(read("schemas/common.v1.json")) as {
      $defs: { captureStatusValue: { enum: string[] } };
    };
    expect([...common.$defs.captureStatusValue.enum].sort()).toEqual([...CAPTURE_STATUS_VALUES].sort());
  });

  it("finding levels agree between code, schema, and docs", () => {
    const schema = JSON.parse(read("schemas/common.v1.json")) as {
      $defs: { findingLevel: { enum: string[] } };
    };
    expect([...schema.$defs.findingLevel.enum].sort()).toEqual([...FINDING_LEVELS].sort());

    const doc = read("docs/architecture/evidence-reference-model.md");
    for (const level of FINDING_LEVELS) {
      expect(doc, `evidence-reference-model.md never mentions ${level}`).toContain(level);
    }
    // The display label must NOT be an accepted enum value.
    expect(schema.$defs.findingLevel.enum).not.toContain("correlated_difference");
  });

  it("RunOutcome values agree between code and schema", () => {
    const schema = JSON.parse(read("schemas/common.v1.json")) as {
      $defs: { runOutcome: { enum: string[] } };
    };
    expect([...schema.$defs.runOutcome.enum].sort()).toEqual([...RUN_OUTCOMES].sort());
  });

  it("M0-AT-11: every error code has a unique name and an in-range exit code", () => {
    expect(new Set(ERROR_CODES).size).toBe(ERROR_CODES.length);
    const valid = new Set(Object.values(EXIT));
    for (const code of ERROR_CODES) {
      const spec = ERROR_SPEC[code];
      expect(spec, `${code} has no spec`).toBeTruthy();
      expect(valid.has(spec.exitCode), `${code} has out-of-range exit ${spec.exitCode}`).toBe(true);
    }
  });

  it("the error taxonomy doc lists every code in the implementation", () => {
    const doc = read("docs/architecture/error-taxonomy.md");
    const missing = ERROR_CODES.filter((c) => !doc.includes(c));
    expect(missing, `error-taxonomy.md is missing: ${missing.join(", ")}`).toHaveLength(0);
  });

  it("M0-AT-12: the legal outcome matrix matches the SQLite CHECK constraints", () => {
    const sql = MIGRATIONS.map((m) => m.sql).join("\n");

    // Every legal combination appears in the constraint text, and no illegal one does.
    for (const [reason, outcomes] of Object.entries(LEGAL_TERMINAL_OUTCOMES)) {
      const constraint = new RegExp(
        `terminal_reason IS NOT '${reason}' OR run_outcome (?:=|IN)`,
        "m"
      );
      expect(constraint.test(sql), `no CHECK constraint for ${reason}`).toBe(true);
      for (const o of outcomes) {
        expect(sql, `${reason} constraint omits ${o}`).toContain(o);
      }
    }

    // The two structural constraints that make the matrix meaningful.
    expect(sql).toContain("(state = 'TERMINAL') = (terminal_reason IS NOT NULL)");
    expect(sql).toContain("(terminal_reason IS NULL) OR (run_outcome IS NOT NULL)");
  });

  it("append-only tables have both update and delete triggers", () => {
    const sql = MIGRATIONS.map((m) => m.sql).join("\n");
    for (const table of ["lineage", "approvals"]) {
      expect(sql).toContain(`BEFORE UPDATE ON ${table}`);
      expect(sql).toContain(`BEFORE DELETE ON ${table}`);
    }
    expect(sql).toContain("BEFORE DELETE ON ai_calls");
    expect(sql).toContain("BEFORE DELETE ON runs");
    expect(sql).toContain("MANIFEST_IMMUTABLE");
    expect(sql).toContain("STORE_APPEND_ONLY_VIOLATION");
  });
});

describe("M0-AT-7 milestones", () => {
  const REQUIRED_SECTIONS = [
    "Entry criteria",
    "Scope",
    "Out of scope",
    "Interfaces touched",
    "Exit criteria",
    "Acceptance tests",
    "Eval gates",
    "Demo command",
    "Risks",
  ];

  const milestones = readdirSync(join(ROOT, "docs/milestones")).filter((f) => /^M\d\.md$/.test(f));

  it("all nine milestone documents exist", () => {
    expect(milestones.sort()).toEqual([
      "M0.md", "M1.md", "M2.md", "M3.md", "M4.md", "M5.md", "M6.md", "M7.md", "M8.md",
    ]);
  });

  it.each(milestones)("%s has all nine required sections", (f) => {
    const headings = read(join("docs/milestones", f))
      .split(/\r?\n/)
      .filter((l) => /^#{1,6}\s+/.test(l))
      .map((l) => l.replace(/^#{1,6}\s+/, "").trim().toLowerCase());
    const missing = REQUIRED_SECTIONS.filter((s) => !headings.includes(s.toLowerCase()));
    expect(missing, `${f} missing: ${missing.join(", ")}`).toHaveLength(0);
  });
});

describe("M0-AT-4 documentation cross-references", () => {
  it("every docs/ and schemas/ reference resolves", () => {
    const files = ["CLAUDE.md", ...mdFiles(join(ROOT, "docs")), ...mdFiles(join(ROOT, "schemas"))];
    const missing: string[] = [];

    for (const f of files) {
      for (const m of readFileSync(f, "utf8").matchAll(/`([^`\n]+)`/g)) {
        const ref = (m[1] ?? "").replace(/[.,;:]$/, "");
        if (!ref.startsWith("docs/") && !ref.startsWith("schemas/")) continue;
        const base = ref.split("#")[0]!.replace(/\*+.*$/, "").replace(/\/$/, "");
        if (base.includes("*") || base.includes("<") || base.includes("..")) continue;
        if (!existsSync(join(ROOT, base))) missing.push(`${f} -> ${base}`);
      }
    }
    expect([...new Set(missing)], "unresolved references").toHaveLength(0);
  });
});
