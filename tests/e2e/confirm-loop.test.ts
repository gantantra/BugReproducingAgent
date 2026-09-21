import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { systemClock } from "@investigator/core";
import { Redactor } from "@investigator/evidence";
import { LocalArtifactStore, SqliteMetadataStore, workspacePaths } from "@investigator/storage";
import { startFixture, type FixtureHandle } from "@investigator/test-fixtures";
import { authoredSuiteWorkspace, cli, filesUnder } from "./authored-suite.js";

/**
 * Confirm -> View result (ADR-0031), end to end with a real browser.
 *
 * The fixture fails only on a slow network. A plain batch therefore all passes; an analysis
 * proposes "the filter fails when the network is slow"; one Confirm click freezes the experiment
 * and runs 12 repeats with the network slowed and 12 without, interleaved. The known answer: every
 * run with the change fails at the check, none without it -- a high-confidence trigger.
 *
 * A run whose browser fails to start (an occasional crash of the headless shell on Windows) is
 * excluded from both numerator and denominator, as it must be; the assertions allow for it rather
 * than the test depending on it never happening.
 *
 * The analysis is written into the evidence store directly. It stands in for the model's reading,
 * which is the only probabilistic step; what is under test is everything deterministic after it.
 */

let ws: string;
let fixture: FixtureHandle;

const PROPOSAL = {
  condition: "The filter empties the list when its response is slow to arrive.",
  factor: { kind: "network", profile: "slow-3g" },
  rationale: "The page gives the response a fixed time and gives up after it.",
  falsifier: "The list empties as often on a fast network as on a slow one.",
};

beforeAll(async () => {
  fixture = await startFixture("product-failing-when-slow");
  ({ ws } = authoredSuiteWorkspace(`${fixture.baseUrl}search`));

  const batch = await cli([
    "rerun",
    "--investigation",
    "INV-001",
    "--repeat",
    "3",
    "--workspace",
    ws,
    "--json",
  ]);
  expect(batch.status).toBe(0);

  // The model's part: an analysis of BATCH-001 that proposes one condition.
  const paths = workspacePaths(join(ws, ".investigator"));
  const metadata = new SqliteMetadataStore({ path: paths.dbPath });
  await metadata.migrate();
  const artifacts = new LocalArtifactStore({
    root: paths.investigationsDir,
    metadata,
    clock: systemClock,
  });
  await artifacts.put({
    investigationId: "INV-001",
    kind: "report",
    filename: "INV-001-analysis.json",
    bytes: JSON.stringify({
      schemaVersion: "1.0.0",
      summary: "Every run passed on a fast network.",
      findings: [],
      reproductionSteps: { confidence: "low", basedOnRunIds: [], steps: [] },
      source: { kind: "rerun-batch", batchId: "BATCH-001" },
      proposedConfirmations: [PROPOSAL],
    }),
    contentType: "application/json",
    redactionApplied: Redactor.fromFile(join(process.cwd(), "policies", "default.yaml")).stamp(),
  });
  await metadata.close();
}, 180_000);

afterAll(async () => {
  await fixture?.close();
  try {
    rmSync(ws, { recursive: true, force: true });
  } catch {
    // A browser that has not quite let go of a video on Windows; the OS temp dir is disposable.
  }
});

describe("confirming a condition", () => {
  let checksum = "";

  it("shows the experiment it would run, and the checksum a Confirm must carry", async () => {
    const r = await cli([
      "confirm",
      "--investigation",
      "INV-001",
      "--condition",
      "1",
      "--workspace",
      ws,
      "--json",
    ]);
    expect(r.status).toBe(0);
    const preview = JSON.parse(r.stdout) as {
      preview: boolean;
      checksum: string;
      runs: number;
      config: { factor: unknown; perArm: number; sourceBatchId: string; statistics: unknown };
    };
    expect(preview.preview).toBe(true);
    expect(preview.runs).toBe(24);
    expect(preview.config.factor).toEqual(PROPOSAL.factor);
    expect(preview.config.sourceBatchId).toBe("BATCH-001");
    expect(preview.checksum).toMatch(/^sha256:[0-9a-f]{64}$/);
    checksum = preview.checksum;

    // Rebuilt, the same bytes: the card and the click agree.
    const again = JSON.parse(
      (
        await cli([
          "confirm",
          "--investigation",
          "INV-001",
          "--condition",
          "1",
          "--workspace",
          ws,
          "--json",
        ])
      ).stdout
    ) as { checksum: string };
    expect(again.checksum).toBe(checksum);

    // Nothing ran for a preview.
    const artifactsDir = join(ws, ".investigator", "investigations", "INV-001", "artifacts");
    expect(filesUnder(join(artifactsDir, "confirmation-config"))).toHaveLength(0);
  }, 120_000);

  it("refuses a checksum that is not the experiment shown, before anything runs", async () => {
    const r = await cli([
      "confirm",
      "--investigation",
      "INV-001",
      "--condition",
      "1",
      "--checksum",
      `sha256:${"0".repeat(64)}`,
      "--workspace",
      ws,
      "--json",
    ]);
    expect(r.status).toBe(3);
    expect(r.stdout).toContain("GATE_CHECKSUM_MISMATCH");
    const artifactsDir = join(ws, ".investigator", "investigations", "INV-001", "artifacts");
    expect(filesUnder(join(artifactsDir, "rerun-batch"))).toHaveLength(1);
  }, 120_000);

  it("runs variant and control interleaved and confirms the trigger", async () => {
    const r = await cli([
      "confirm",
      "--investigation",
      "INV-001",
      "--condition",
      "1",
      "--checksum",
      checksum,
      "--workspace",
      ws,
      "--json",
    ]);
    expect(r.status, r.stdout.slice(-2000)).toBe(0);
    const result = JSON.parse(r.stdout) as {
      batchId: string;
      variant: { matched: number; reached: number };
      control: { matched: number; reached: number };
      factorNotApplied: number;
      decision: { verdict: string };
      rootCauseHypothesis?: { statement: string; mechanism: string };
      configChecksum: string;
    };
    expect(result.batchId).toBe("BATCH-002");
    expect(result.configChecksum).toBe(checksum);
    expect(result.factorNotApplied).toBe(0);
    // Every run with the network slowed that reached the check failed there; none without it did.
    expect(result.variant.matched).toBe(result.variant.reached);
    expect(result.variant.reached).toBeGreaterThanOrEqual(10);
    expect(result.control.matched).toBe(0);
    expect(result.control.reached).toBeGreaterThanOrEqual(10);
    expect(result.decision.verdict).toBe("high_confidence_trigger");
    expect(result.rootCauseHypothesis?.mechanism).toBe(PROPOSAL.rationale);

    // The frozen config is stored, byte for byte what the checksum names.
    const artifactsDir = join(ws, ".investigator", "investigations", "INV-001", "artifacts");
    const [configFile] = filesUnder(join(artifactsDir, "confirmation-config"));
    const { createHash } = await import("node:crypto");
    expect(`sha256:${createHash("sha256").update(readFileSync(configFile!)).digest("hex")}`).toBe(
      checksum
    );

    // Interleaved: both arms in every consecutive pair of runs.
    const [batchFile] = filesUnder(join(artifactsDir, "rerun-batch")).filter((f) =>
      readFileSync(f, "utf8").includes('"BATCH-002"')
    );
    const batch = JSON.parse(readFileSync(batchFile!, "utf8")) as {
      runs: Array<{ repeatIndex: number; arm: { arm: string } }>;
    };
    const arms = batch.runs.sort((a, b) => a.repeatIndex - b.repeatIndex).map((x) => x.arm.arm);
    for (let i = 0; i < arms.length; i += 2) {
      expect(new Set(arms.slice(i, i + 2))).toEqual(new Set(["variant", "control"]));
    }
  }, 600_000);
});
