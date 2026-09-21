import { describe, it, expect } from "vitest";
import type { CaptureStatus, CaptureStatusValue, EvidenceCategory } from "@investigator/core";
import { EVIDENCE_CATEGORIES, schemaRegistry } from "@investigator/core";
import { buildEvidenceQuality, incompleteEvidenceFor } from "./evidence-quality.js";

function status(overrides: Partial<Record<EvidenceCategory, CaptureStatusValue>>): CaptureStatus {
  const categories = {} as CaptureStatus["categories"];
  for (const cat of EVIDENCE_CATEGORIES) {
    const s = overrides[cat] ?? "complete";
    categories[cat] = {
      status: s,
      collected: s === "complete" ? 3 : 0,
      ...(s === "unsupported" ? { reasons: [{ code: "COLLECTOR_UNSUPPORTED", count: 1 }] } : {}),
    };
  }
  return {
    schemaVersion: "1.0.0",
    runId: "x",
    versions: { collectorVersion: "0", normalizerVersion: "0", extractorVersion: "0" },
    redaction: {
      policyId: "p",
      policyVersion: "1",
      policyHash: "sha256:" + "a".repeat(64),
      mode: "strict",
      appliedRules: [],
    },
    categories,
    limitations: [],
  };
}

describe("evidence quality for a batch", () => {
  const runs = [
    { runId: "ARUN-001-001", captureStatus: status({}) },
    { runId: "ARUN-001-002", captureStatus: status({ console: "partial" }) },
    { runId: "ARUN-001-003", captureStatus: status({ actions: "unsupported" }) },
  ];

  it("counts every category's status across the runs", () => {
    const q = buildEvidenceQuality("BATCH-001", runs);
    expect(q.runCount).toBe(3);
    expect(q.categories.console.runs.complete).toBe(2);
    expect(q.categories.console.runs.partial).toBe(1);
    expect(q.categories.actions.runs.unsupported).toBe(1);
    expect(q.categories.actions.reasons.COLLECTOR_UNSUPPORTED).toBe(1);
  });

  it("is a pure function of its inputs", () => {
    expect(JSON.stringify(buildEvidenceQuality("BATCH-001", runs))).toBe(
      JSON.stringify(buildEvidenceQuality("BATCH-001", runs))
    );
  });

  it("matches its schema", () => {
    const registry = schemaRegistry();
    const r = registry.check("evidence-quality.v1.json", buildEvidenceQuality("BATCH-001", runs));
    expect(r.ok, JSON.stringify(r)).toBe(true);
  });

  it("withholds a claim only for the evidence that claim needs", () => {
    const q = buildEvidenceQuality("BATCH-001", runs);
    // Console was partial in run 2: a console claim citing it is not supported...
    expect(incompleteEvidenceFor(q, "console", ["ARUN-001-002"])).toEqual([
      { runId: "ARUN-001-002", category: "console", status: "partial" },
    ]);
    // ...but a network claim citing the same run is, because networkMetadata was complete.
    expect(incompleteEvidenceFor(q, "network", ["ARUN-001-002"])).toEqual([]);
    // And the unsupported action capture in run 3 does not touch an exception claim.
    expect(incompleteEvidenceFor(q, "exception", ["ARUN-001-003"])).toEqual([]);
  });

  it("does not vouch for a run it has no record of", () => {
    const q = buildEvidenceQuality("BATCH-001", runs);
    expect(incompleteEvidenceFor(q, "exception", ["ARUN-009-009"])).toEqual([
      { runId: "ARUN-009-009", category: "exceptions", status: "missing" },
    ]);
  });
});
