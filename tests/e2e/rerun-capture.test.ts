import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startFixture, COUNTER_FAILS_EVERY, type FixtureHandle } from "@investigator/test-fixtures";
import { CLI, authoredSuiteWorkspace, filesUnder } from "./authored-suite.js";

/**
 * `investigate rerun` records every run's evidence (ADR-0029).
 *
 * A real authored-shape suite, a real browser, and a fixture that fails on exactly every third
 * filter, so the answer is known before the run: 9 repeats, 3 failures at the final check, and
 * the page's console error in those three runs and no other.
 */

const run = promisify(execFile);

let ws: string;
let fixture: FixtureHandle;
let suiteDir: string;

beforeAll(async () => {
  fixture = await startFixture("product-failing-counter");
  ({ ws, suiteDir } = authoredSuiteWorkspace(`${fixture.baseUrl}search`));
}, 120_000);

afterAll(async () => {
  await fixture?.close();
  try {
    rmSync(ws, { recursive: true, force: true });
  } catch {
    // A browser that has not quite let go of a video on Windows; the OS temp dir is disposable.
  }
});

describe("rerun records every run's evidence", () => {
  it("stores nine runs, three failed at the check, with the console error in exactly those", async () => {
    const specBefore = readFileSync(join(suiteDir, "tests", "repro.spec.ts"), "utf8");
    const { stdout } = await run(
      process.execPath,
      [CLI, "rerun", "--investigation", "INV-001", "--repeat", "9", "--workspace", ws, "--json"],
      { env: { ...process.env, REPROAGENT_NO_ENV_FILE: "1" }, maxBuffer: 16 * 1024 * 1024 }
    );
    const r = JSON.parse(stdout) as {
      ok: boolean;
      repetitions: number;
      reachedCheck: number;
      failedAtCheck: number;
      stoppedEarly: number;
      capture: { supported: boolean };
      evidenceIngested: boolean;
      batchId: string;
      runIds: string[];
    };

    // The existing counts, unchanged in meaning.
    expect(r.ok).toBe(true);
    expect(r.repetitions).toBe(9);
    expect(r.reachedCheck).toBe(9);
    expect(r.failedAtCheck).toBe(9 / COUNTER_FAILS_EVERY);
    expect(r.stoppedEarly).toBe(0);

    // The new evidence.
    expect(r.capture).toEqual({ supported: true });
    expect(r.evidenceIngested).toBe(true);
    expect(r.batchId).toBe("BATCH-001");
    expect(r.runIds).toHaveLength(9);

    // The suite is exactly as it was, and the capture copy is gone.
    expect(readFileSync(join(suiteDir, "tests", "repro.spec.ts"), "utf8")).toBe(specBefore);
    expect(existsSync(join(suiteDir, ".reproagent"))).toBe(false);

    const artifacts = join(ws, ".investigator", "investigations", "INV-001", "artifacts");
    const batchFile = filesUnder(join(artifacts, "rerun-batch"))[0]!;
    const batch = JSON.parse(readFileSync(batchFile, "utf8")) as {
      runs: Array<{
        runId: string;
        repeatIndex: number;
        outcome: string;
        captured: boolean;
        normalizedArtifactId: string;
      }>;
    };
    const failing = batch.runs.filter((x) => x.outcome === "PRODUCT_FAILED");
    expect(failing.map((x) => x.repeatIndex)).toEqual([2, 5, 8]);
    expect(batch.runs.filter((x) => x.outcome === "VALID_COMPLETED")).toHaveLength(6);
    expect(batch.runs.every((x) => x.captured)).toBe(true);

    // The console error is in the normalized evidence of the failing runs and no other.
    const normalized = filesUnder(join(artifacts, "normalized-evidence"));
    const byRun = new Map(
      normalized.map((f) => {
        const text = readFileSync(f, "utf8");
        return [(JSON.parse(text) as { runId: string }).runId, text] as const;
      })
    );
    for (const x of batch.runs) {
      const text = byRun.get(x.runId);
      expect(text, `${x.runId} has no normalized evidence`).toBeDefined();
      expect(text!.includes("applyFilters: results undefined"), x.runId).toBe(
        x.outcome === "PRODUCT_FAILED"
      );
    }

    // And the batch's evidence-quality record exists beside it.
    expect(filesUnder(join(artifacts, "evidence-quality"))).toHaveLength(1);
  }, 300_000);

  it("analyses the batch, and fixes the target signature from the failures themselves", async () => {
    const { stdout } = await run(
      process.execPath,
      [
        CLI,
        "analyze",
        "--investigation",
        "INV-001",
        "--batch",
        "BATCH-001",
        "--workspace",
        ws,
        "--json",
      ],
      { env: { ...process.env, REPROAGENT_NO_ENV_FILE: "1" }, maxBuffer: 16 * 1024 * 1024 }
    );
    const r = JSON.parse(stdout) as {
      ok: boolean;
      runsAnalysed: number;
      source: { kind: string; batchId: string };
      targetSignature: { atCheck: boolean; consoleFingerprints: string[] };
      contrast: {
        failingRunIds: string[];
        passingRunIds: string[];
        perfectDiscriminators: string[];
      };
    };
    expect(r.ok).toBe(true);
    expect(r.runsAnalysed).toBe(9);
    expect(r.source).toEqual({ kind: "rerun-batch", batchId: "BATCH-001" });
    expect(r.contrast.failingRunIds).toHaveLength(3);
    expect(r.contrast.passingRunIds).toHaveLength(6);
    // The page's error -- a fingerprint present in every failure and in no pass -- is what a
    // confirmation will count. Fingerprints are ids, not the message text.
    expect(r.targetSignature.atCheck).toBe(true);
    expect(r.targetSignature.consoleFingerprints).toHaveLength(1);
    expect(r.contrast.perfectDiscriminators).toContain(r.targetSignature.consoleFingerprints[0]);
  }, 120_000);

  it("runs a suite it cannot instrument exactly as before, and says capture was unsupported", async () => {
    // A spec that loads Playwright some other way: the import cannot be swapped, so no fixture.
    const specPath = join(suiteDir, "tests", "repro.spec.ts");
    const original = readFileSync(specPath, "utf8");
    writeFileSync(
      specPath,
      original.replace(
        `import { test } from "@playwright/test";`,
        `const { test } = require("@playwright/test");`
      )
    );
    try {
      const { stdout } = await run(
        process.execPath,
        [CLI, "rerun", "--investigation", "INV-001", "--repeat", "3", "--workspace", ws, "--json"],
        { env: { ...process.env, REPROAGENT_NO_ENV_FILE: "1" }, maxBuffer: 16 * 1024 * 1024 }
      );
      const r = JSON.parse(stdout) as {
        ok: boolean;
        reachedCheck: number;
        failedAtCheck: number;
        capture: { supported: boolean; reason?: string };
        evidenceIngested: boolean;
        batchId: string;
      };
      expect(r.ok).toBe(true);
      expect(r.reachedCheck).toBe(3);
      // The fixture's count carries on from the first test: filters 10, 11, 12 -- one failure.
      expect(r.failedAtCheck).toBe(1);
      expect(r.capture.supported).toBe(false);
      expect(r.capture.reason).toMatch(/does not import test from @playwright\/test/);
      // Still a batch, its runs recorded as not captured rather than left out.
      expect(r.evidenceIngested).toBe(true);
      expect(r.batchId).toBe("BATCH-002");
    } finally {
      writeFileSync(specPath, original);
    }
  }, 300_000);
});
