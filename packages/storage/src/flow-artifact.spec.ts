import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalJson } from "@investigator/core";
import type { RedactionStamp } from "@investigator/core";
import { LocalArtifactStore } from "./local-artifact-store.js";
import { SqliteMetadataStore } from "./sqlite-metadata-store.js";

/**
 * The `flow` artifact kind: the durable home of what `intake_to_flow` read out of a human report.
 *
 * Playwright produces evidence. Deterministic software normalizes and measures evidence. DeepSeek interprets and prioritizes evidence. Humans authorize consequential transitions.
 *
 * This exists because the interpretation used to survive only as a count in `intake --ai` output,
 * which meant `propose_experiments` planned experiments without ever seeing the report it was
 * investigating. Storing it is what makes the model's reading inspectable, citable, and the same
 * bytes for the human and for the next flow.
 */

const REDACTION: RedactionStamp = {
  policyId: "default",
  policyVersion: "1.0.0",
  policyHash: "sha256:test",
  mode: "strict",
  appliedRules: [],
};

const INV = "INV-001";

const FLOW = {
  schemaVersion: "1.0.0",
  flowId: "FLOW-001",
  investigationId: INV,
  title: "Account deletion does not confirm every time",
  steps: [{ stepId: "S1", description: "Open the profile editor", actions: [] }],
  assumptions: [],
  unknowns: [{ unknownId: "U1", field: "confirmation control", why: "not named in the report" }],
};

describe("the flow artifact round-trips", () => {
  let dir: string;
  let artifacts: LocalArtifactStore;
  let metadata: SqliteMetadataStore;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "flow-artifact-"));
    metadata = new SqliteMetadataStore({ path: join(dir, "metadata.sqlite") });
    await metadata.migrate();
    await metadata.tx(async (t) => {
      await t.insertInvestigation({
        investigationId: INV,
        title: "t",
        targetName: null,
        createdAt: new Date(0).toISOString(),
        status: "open",
      });
    });
    artifacts = new LocalArtifactStore({ root: join(dir, "artifacts"), metadata });
  });

  afterEach(async () => {
    await metadata.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("stores the interpretation and reads back the identical bytes", async () => {
    const bytes = canonicalJson(FLOW);
    const ref = await artifacts.put({
      investigationId: INV,
      kind: "flow",
      filename: "FLOW-001.json",
      bytes,
      contentType: "application/json",
      redactionApplied: REDACTION,
    });

    // Byte-identical, not merely equivalent: a proposal cites this document, so a re-serialization
    // that reordered keys would break the citation without changing the meaning.
    expect(await artifacts.getText(ref)).toBe(bytes);
    expect((await artifacts.verify(ref)).ok).toBe(true);
  });

  it("is addressable by kind, so a later flow can find it without being told the id", async () => {
    await artifacts.put({
      investigationId: INV,
      kind: "intake-report",
      filename: "report.md",
      bytes: "a human wrote this",
      contentType: "text/markdown",
      redactionApplied: REDACTION,
    });
    await artifacts.put({
      investigationId: INV,
      kind: "flow",
      filename: "FLOW-001.json",
      bytes: canonicalJson(FLOW),
      contentType: "application/json",
      redactionApplied: REDACTION,
    });

    const found = await artifacts.list(INV, { kind: "flow" });
    expect(found).toHaveLength(1);
    expect(JSON.parse(await artifacts.getText(found[0]!)).flowId).toBe("FLOW-001");
  });

  it("takes an artifact id that cannot be confused with the flow's own id", async () => {
    // A lineage dump names both the flow node (FLOW-001) and the artifact holding it. If the
    // artifact id were also FLOW-001, provenance would be ambiguous exactly where it must not be.
    const ref = await artifacts.put({
      investigationId: INV,
      kind: "flow",
      filename: "FLOW-001.json",
      bytes: canonicalJson(FLOW),
      contentType: "application/json",
      redactionApplied: REDACTION,
    });
    expect(ref.artifactId).toMatch(/^FLOWDOC-/);
    expect(ref.artifactId).not.toBe(FLOW.flowId);
  });

  it("carries a redaction stamp like every other durable byte", async () => {
    const ref = await artifacts.put({
      investigationId: INV,
      kind: "flow",
      filename: "FLOW-001.json",
      bytes: canonicalJson(FLOW),
      contentType: "application/json",
      redactionApplied: REDACTION,
    });
    // The interpretation is derived from a report that may have contained PII, so it crosses the
    // same boundary rather than inheriting trust from being machine-written.
    expect(ref.redactionApplied?.policyId).toBe("default");
  });
});
