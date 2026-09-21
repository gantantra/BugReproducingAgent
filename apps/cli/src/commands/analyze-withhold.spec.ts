import { describe, it, expect } from "vitest";
import type { CaptureStatus, CaptureStatusValue, EvidenceCategory } from "@investigator/core";
import { EVIDENCE_CATEGORIES } from "@investigator/core";
import { buildEvidenceQuality } from "@investigator/evidence";
import { withholdByEvidence } from "./analyze.js";

function status(overrides: Partial<Record<EvidenceCategory, CaptureStatusValue>>): CaptureStatus {
  const categories = {} as CaptureStatus["categories"];
  for (const cat of EVIDENCE_CATEGORIES) categories[cat] = { status: overrides[cat] ?? "complete" };
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

const finding = (claimCategory: string | undefined, runIds: string[]) => ({
  level: "correlated",
  statement: `a ${claimCategory ?? "general"} claim`,
  ...(claimCategory ? { claimCategory } : {}),
  supportingEvidence: runIds.map((runId) => ({ kind: "run", runId }) as never),
  confidence: 0.5,
});

describe("withholding a finding for incomplete evidence", () => {
  // Console was cut short in run 2; everything else was complete everywhere.
  const quality = buildEvidenceQuality("BATCH-001", [
    { runId: "ARUN-001-001", captureStatus: status({}) },
    { runId: "ARUN-001-002", captureStatus: status({ console: "partial" }) },
  ]);

  it("withholds only the finding whose own evidence was incomplete", () => {
    const { kept, withheld } = withholdByEvidence(
      [
        finding("console", ["ARUN-001-002"]),
        finding("network", ["ARUN-001-002"]),
        finding("console", ["ARUN-001-001"]),
        finding(undefined, ["ARUN-001-002"]),
      ],
      quality
    );
    expect(withheld).toHaveLength(1);
    expect(withheld[0]!.finding.statement).toBe("a console claim");
    expect(withheld[0]!.reason).toBe("EVIDENCE_INCOMPLETE_FOR_CLAIM");
    expect(withheld[0]!.incomplete).toEqual([
      { runId: "ARUN-001-002", category: "console", status: "partial" },
    ]);
    expect(kept.map((f) => f.statement)).toEqual([
      "a network claim",
      "a console claim",
      "a general claim",
    ]);
  });

  it("changes nothing for measured runs, which have no quality record", () => {
    const findings = [finding("console", ["RUN-001"])];
    expect(withholdByEvidence(findings, null)).toEqual({ kept: findings, withheld: [] });
  });
});
