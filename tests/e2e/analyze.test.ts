import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * `investigate analyze`, end to end against the built binary.
 *
 * Playwright produces evidence. Deterministic software normalizes and measures evidence. DeepSeek interprets and prioritizes evidence. Humans authorize consequential transitions.
 *
 * The property under test is the one the whole feature rests on: the answer to "what is different
 * about the runs that failed" is computed by arithmetic and is available with NO provider
 * configured. If that were not true, the most load-bearing output in the product would depend on
 * a third party being reachable and correct.
 *
 * Runs with every DEEPSEEK_* variable cleared, and with the .env opt-out set so a developer's
 * local credentials cannot quietly turn this into a different test.
 */

const REPO = process.cwd();
const CLI = join(REPO, "apps", "cli", "dist", "bin.js");
const INTAKE = join(REPO, "docs", "examples", "intake", "blank-results.md");
const PROPOSAL = join(REPO, "docs", "examples", "proposals", "gate-1.input.json");

const ENV: NodeJS.ProcessEnv = (() => {
  const e = { ...process.env };
  for (const k of [
    "DEEPSEEK_API_KEY",
    "DEEPSEEK_BASE_URL",
    "DEEPSEEK_FAST_MODEL",
    "DEEPSEEK_REASONING_MODEL",
    "DEEPSEEK_FALLBACK_MODEL",
  ]) {
    delete e[k];
  }
  e["REPROAGENT_NO_ENV_FILE"] = "1";
  return e;
})();

function run(args: string[]): { status: number; stdout: string } {
  try {
    return {
      status: 0,
      stdout: execFileSync(process.execPath, [CLI, ...args], { encoding: "utf8", env: ENV }),
    };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { status: err.status ?? 1, stdout: (err.stdout ?? "") + (err.stderr ?? "") };
  }
}

let ws: string;

describe("investigate analyze", () => {
  beforeAll(() => {
    ws = mkdtempSync(join(tmpdir(), "reproagent-analyze-"));
    run(["init", "--workspace", ws]);

    const cfgPath = join(ws, ".investigator", "config.yaml");
    writeFileSync(
      cfgPath,
      readFileSync(cfgPath, "utf8").replace("execution:", 'execution:\n  video: "on"'),
      "utf8"
    );

    run(["intake", "--workspace", ws, "--from", INTAKE, "--json"]);
    const plan = JSON.parse(
      run(["plan", "--workspace", ws, "--investigation", "INV-001", "--from", PROPOSAL, "--json"])
        .stdout
    ) as { proposalChecksum: string };

    const scaffold = JSON.parse(
      run([
        "approve",
        "experiment_selection",
        "--workspace",
        ws,
        "--investigation",
        "INV-001",
        "--scaffold",
        "--approver",
        "Test",
        "--json",
      ]).stdout
    ) as { path: string };

    run([
      "approve",
      "experiment_selection",
      "--workspace",
      ws,
      "--investigation",
      "INV-001",
      "--from",
      scaffold.path,
      "--checksum",
      plan.proposalChecksum,
      "--json",
    ]);

    run([
      "run",
      "--workspace",
      ws,
      "--investigation",
      "INV-001",
      "--experiment",
      "EXP-001",
      "--fixture-app",
      "product-failing-intermittent",
      "--repeat",
      "3",
      "--json",
    ]);
  }, 180_000);

  afterAll(() => rmSync(ws, { recursive: true, force: true }));

  it("produces the contrast with no AI configuration at all", () => {
    const r = run(["analyze", "--workspace", ws, "--investigation", "INV-001"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Analysis of INV-001");
    expect(r.stdout).toMatch(/failing\s+3/);
    // Named explicitly, so a reader knows the deterministic half stands on its own.
    expect(r.stdout).toContain("deterministic and needed no provider");
  });

  it("emits a machine-readable contrast with the measured groups", () => {
    const r = run(["analyze", "--workspace", ws, "--investigation", "INV-001", "--json"]);
    const j = JSON.parse(r.stdout) as {
      runsAnalysed: number;
      contrast: { failingRunIds: string[]; passingRunIds: string[]; caveats: string[] };
      analysis: unknown;
    };
    expect(j.runsAnalysed).toBe(3);
    expect(j.contrast.failingRunIds).toHaveLength(3);
    // No --ai, so there is no interpretation. Null rather than an empty object: absent and
    // "present but found nothing" are different answers.
    expect(j.analysis).toBeNull();
  });

  it("refuses to over-read a comparison with no control group", () => {
    const r = run(["analyze", "--workspace", ws, "--investigation", "INV-001"]);
    // Every run failed. Anything common to all of them is a property of the experiment, and
    // presenting it as a discriminator would be the single most misleading thing this could do.
    expect(r.stdout).toContain("NOTHING below discriminates");
    expect(r.stdout).not.toContain("What separates the failing runs");
  });

  it("refuses an investigation with no runs rather than reporting an empty analysis", () => {
    // Asserted, not merely invoked. This line silently FAILED for a while — a second
    // investigation in one workspace collided on lineage ids — and the test still passed,
    // because the investigation row is committed before lineage is written and the assertion
    // below only needed the row to exist. An unchecked setup step is not setup, it is a guess.
    const second = run(["intake", "--workspace", ws, "--from", INTAKE, "--json"]);
    expect(second.status).toBe(0);
    expect((JSON.parse(second.stdout) as { investigationId: string }).investigationId).toBe(
      "INV-002"
    );

    const r = run(["analyze", "--workspace", ws, "--investigation", "INV-002"]);
    expect(r.status).not.toBe(0);
    expect(r.stdout).toMatch(/No runs with normalized evidence/);
  });

  it("refuses an unknown investigation", () => {
    const r = run(["analyze", "--workspace", ws, "--investigation", "INV-999"]);
    expect(r.status).not.toBe(0);
    expect(r.stdout).toMatch(/Unknown investigation/);
  });

  it("persists a video and says on the record that it was NOT redacted", () => {
    const videoDir = join(ws, ".investigator", "investigations", "INV-001", "artifacts", "video");
    const recordings = readdirSync(videoDir).flatMap((shard) =>
      readdirSync(join(videoDir, shard)).filter((f) => f.endsWith(".webm"))
    );
    expect(recordings.length).toBeGreaterThan(0);

    // The claim that matters is not that a file exists but that the evidence record admits the
    // file is raw. A recording stored under a stamp implying redaction would be a lie told in
    // exactly the place an auditor trusts.
    const normDir = join(
      ws,
      ".investigator",
      "investigations",
      "INV-001",
      "artifacts",
      "normalized-evidence"
    );
    const normFile = readdirSync(normDir).flatMap((shard) =>
      readdirSync(join(normDir, shard)).map((f) => join(normDir, shard, f))
    )[0]!;
    const doc = JSON.parse(readFileSync(normFile, "utf8")) as {
      captureStatus: {
        categories: Record<
          string,
          { status: string; collected?: number; reasons?: Array<{ code: string }> }
        >;
        limitations: string[];
      };
    };

    const video = doc.captureStatus.categories["video"]!;
    expect(video.reasons?.map((r) => r.code)).toContain("PERSISTED_UNREDACTED");
    expect(video.collected).toBeGreaterThan(0);
    expect(doc.captureStatus.limitations.join(" ")).toMatch(/WITHOUT redaction/);
    expect(doc.captureStatus.limitations.join(" ")).toMatch(/credentials or personal data/);
  });
});
