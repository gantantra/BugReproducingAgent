import { describe, it, expect, afterEach } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { sensitiveExperiment } from "@investigator/test-fixtures";
import { Redactor, scanForResidue } from "@investigator/evidence";
import { createHarness, runExperiment, DUMMY_API_KEY, type Harness } from "./harness.js";

/**
 * Reliability gate test 7 — redaction before persistence.
 *
 * The seeded secrets must appear in NO persisted artifact, DB row, log line, or index entry, in
 * any encoding checked. `cartCount` must survive, proving redaction is targeted rather than
 * blanket destruction. And a store call without a RedactionStamp must fail closed.
 */

const SEEDED = {
  sessionCookieValue: "s3cr3tSESSIONvalue9876",
  jwt: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk",
  urlToken: "AKIAIOSFODNN7EXAMPLEKEY123",
  bearerToken: "AKIAIOSFODNN7EXAMPLEKEY123456789",
  email: "real.user@company-domain.example",
  phone: "9876543210",
  card: "4111111111111111",
  pan: "ABCDE1234F",
};

/** Every encoding the gate checks, per the spec in docs/acceptance-tests. */
function encodings(value: string): string[] {
  return [
    value,
    encodeURIComponent(value),
    Buffer.from(value, "utf8").toString("base64"),
    Buffer.from(value, "utf8").toString("base64url"),
    Buffer.from(value, "utf8").toString("hex"),
  ];
}

function walkFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...walkFiles(p));
    else out.push(p);
  }
  return out;
}

let h: Harness | undefined;
afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

describe("redaction before persistence", () => {
  it("no seeded secret or PII survives into any persisted byte, in any encoding", async () => {
    h = await createHarness({ fixtures: ["sensitive"], responseBodyMaxBytes: 262144 });
    const results = await runExperiment(h, sensitiveExperiment("sensitive"), 3);
    expect(results.length).toBe(3);

    // Every file under the workspace: artifacts, the SQLite database, WAL, everything.
    const files = walkFiles(h.workspace.root);
    expect(files.length).toBeGreaterThan(0);

    const haystacks: Array<{ label: string; text: string }> = [];
    for (const f of files) {
      // Read as latin1 so binary content is still searchable for ASCII secrets.
      haystacks.push({ label: f, text: readFileSync(f).toString("latin1") });
    }

    for (const [name, value] of Object.entries(SEEDED)) {
      for (const encoded of encodings(value)) {
        if (encoded.length < 8) continue;
        for (const hay of haystacks) {
          expect(
            hay.text.includes(encoded),
            `secret ${name} leaked into ${hay.label}`
          ).toBe(false);
        }
      }
    }

    // The API key must never appear either, even though the execution path never reads it.
    for (const hay of haystacks) {
      expect(hay.text.includes(DUMMY_API_KEY), `API key leaked into ${hay.label}`).toBe(false);
    }
  });

  it("retains non-sensitive storage keys, proving redaction is targeted not blanket", async () => {
    h = await createHarness({ fixtures: ["sensitive"] });
    const [r] = await runExperiment(h, sensitiveExperiment("sensitive"), 1);

    const refs = await h.artifacts.list(h.investigationId, {
      kind: "normalized-evidence",
      runId: r!.runId,
    });
    const doc = await h.artifacts.getText(refs[0]!);

    // cartCount is not secret and must survive. authToken must not.
    expect(doc).toContain("cartCount");
    expect(doc).not.toContain(SEEDED.jwt);
  });

  it("every persisted artifact carries a non-empty RedactionStamp", async () => {
    h = await createHarness({ fixtures: ["sensitive"] });
    await runExperiment(h, sensitiveExperiment("sensitive"), 2);

    const refs = await h.artifacts.list(h.investigationId);
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) {
      const stamp = ref.redactionApplied;
      expect(stamp, `${ref.artifactId} has no redaction stamp`).toBeTruthy();
      expect(stamp.policyId).toBe("default");
      expect(stamp.policyVersion).toMatch(/^\d+\.\d+\.\d+$/);
      expect(stamp.policyHash).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(stamp.mode).toBe("strict");
      expect(Array.isArray(stamp.appliedRules)).toBe(true);
    }
  });

  it("a store call without a RedactionStamp fails closed with REDACTION_NOT_APPLIED", async () => {
    h = await createHarness({ fixtures: ["passing"] });

    await expect(
      h.artifacts.put({
        investigationId: h.investigationId,
        kind: "console-log",
        filename: "unstamped.jsonl",
        bytes: "should never reach disk",
        contentType: "application/x-ndjson",
        // Deliberately omitted. The type signature normally prevents this; the cast proves the
        // runtime guard is real and not merely a compile-time convention (ADR-0008).
        redactionApplied: undefined as never,
      })
    ).rejects.toThrowError(/REDACTION_NOT_APPLIED|RedactionStamp/);

    // And nothing was written.
    const refs = await h.artifacts.list(h.investigationId, { kind: "console-log" });
    expect(refs).toHaveLength(0);
  });

  it("redaction is deterministic: the same input and policy produce identical output", async () => {
    const redactor = Redactor.fromString(
      readFileSync(join(process.cwd(), "policies", "default.yaml"), "utf8")
    );
    const sample = `token=${SEEDED.jwt} email=${SEEDED.email} phone=${SEEDED.phone}`;

    const a = redactor.redactField("console.text", sample);
    const b = redactor.redactField("console.text", sample);
    expect(a.value).toBe(b.value);
    expect(a.ruleId).toBe(b.ruleId);

    // And the output genuinely removed the material.
    expect(a.value).not.toContain(SEEDED.jwt);
  });

  it("the residue scanner detects a deliberately unredacted payload", () => {
    const dirty = `Authorization: Bearer ${SEEDED.bearerToken}\nset-cookie: sid=${SEEDED.sessionCookieValue}`;
    const findings = scanForResidue(dirty, [SEEDED.sessionCookieValue]);
    expect(findings.length).toBeGreaterThan(0);

    // A clean payload produces nothing, so the scanner is not vacuously positive.
    expect(scanForResidue("nothing sensitive here", [])).toHaveLength(0);
  });
});
