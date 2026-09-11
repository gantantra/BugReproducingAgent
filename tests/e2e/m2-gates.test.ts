import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { EXIT } from "@investigator/core";

/**
 * M2 acceptance tests: the three human gates, end to end, against the BUILT binary.
 *
 * Playwright produces evidence. Deterministic software normalizes and measures evidence. DeepSeek interprets and prioritizes evidence. Humans authorize consequential transitions.
 *
 * Every test here describes a way the approval mechanism could be circumvented or misled, and
 * asserts that it is not. The single most important one is the first: with a proposal rendered
 * and no approval recorded, `run` must enqueue NOTHING.
 *
 * The suite runs with every DEEPSEEK_* variable cleared, so it also proves the M2 workflow needs
 * no AI configuration.
 */

const REPO = process.cwd();
const CLI = join(REPO, "apps", "cli", "dist", "bin.js");
const INTAKE = join(REPO, "docs", "examples", "intake", "blank-results.md");
const PROPOSAL_INPUT = join(REPO, "docs", "examples", "proposals", "gate-1.input.json");

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
  // A developer's local .env would otherwise restore exactly what this suite just cleared,
  // turning "needs no credential" from a proof into a claim.
  e["REPROAGENT_NO_ENV_FILE"] = "1";
  return e;
})();

interface Run {
  status: number;
  stdout: string;
  stderr: string;
}

let dir: string;
let ws: string;

function cli(args: string[]): Run {
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], {
      encoding: "utf8",
      env: ENV,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, stdout, stderr: "" };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { status: err.status ?? -1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

const json = <T>(r: Run): T => JSON.parse(r.stdout) as T;

function db<T>(fn: (d: DatabaseSync) => T): T {
  const d = new DatabaseSync(join(ws, ".investigator", "investigator.db"));
  try {
    return fn(d);
  } finally {
    d.close();
  }
}

function counts(): { jobs: number; approvals: number; lineage: number } {
  return db((d) => ({
    jobs: (d.prepare("SELECT COUNT(*) c FROM jobs").get() as { c: number }).c,
    approvals: (d.prepare("SELECT COUNT(*) c FROM approvals").get() as { c: number }).c,
    lineage: (d.prepare("SELECT COUNT(*) c FROM lineage").get() as { c: number }).c,
  }));
}

let proposalChecksum = "";
let scaffoldPath = "";

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "reproagent-m2-"));
  ws = join(dir, "ws");
  expect(cli(["init", "--workspace", ws, "--json"]).status).toBe(EXIT.OK);
  expect(cli(["intake", "--workspace", ws, "--from", INTAKE, "--json"]).status).toBe(EXIT.OK);
  const plan = cli([
    "plan",
    "--workspace",
    ws,
    "--investigation",
    "INV-001",
    "--from",
    PROPOSAL_INPUT,
    "--json",
  ]);
  expect(plan.status).toBe(EXIT.OK);
  proposalChecksum = json<{ proposalChecksum: string }>(plan).proposalChecksum;
}, 120_000);

afterAll(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* disposable */
  }
});

describe("M2 gate 1 enforcement", () => {
  it("M2-AT-5: run without an approval exits GATE_REQUIRED and enqueues nothing", () => {
    const before = counts();
    const r = cli([
      "run",
      "--workspace",
      ws,
      "--investigation",
      "INV-001",
      "--fixture-app",
      "product-failing-intermittent",
      "--json",
    ]);
    expect(r.status).toBe(EXIT.GATE_REQUIRED);
    expect(json<{ code: string }>(r).code).toBe("GATE_REQUIRED");

    // The assertion that matters: refusing is not enough, nothing may be scheduled either.
    const after = counts();
    expect(after.jobs).toBe(before.jobs);
    expect(after.jobs).toBe(0);
    expect(after.approvals).toBe(0);
  });

  it("the M1 --fixture-experiment bypass no longer exists", () => {
    const help = cli(["run", "--help"]);
    expect(help.stdout).not.toContain("--fixture-experiment");

    // And passing it is rejected rather than quietly ignored.
    const r = cli([
      "run",
      "--workspace",
      ws,
      "--investigation",
      "INV-001",
      "--fixture-experiment",
      join(REPO, "packages/test-fixtures/experiments/passing.json"),
      "--json",
    ]);
    expect(r.status).not.toBe(EXIT.OK);
  });

  it("offers no flag anywhere that grants an approval", () => {
    for (const args of [["--help"], ["approve", "--help"], ["run", "--help"]]) {
      const out = cli(args).stdout;
      expect(out).not.toContain("--yes");
      expect(out).not.toContain("--force-approve");
      expect(out).not.toMatch(/--auto\b/);
    }
  });
});

describe("M2 approval binding", () => {
  it("--scaffold writes a file and approves nothing", () => {
    const r = cli([
      "approve",
      "experiment_selection",
      "--workspace",
      ws,
      "--investigation",
      "INV-001",
      "--scaffold",
      "--approver",
      "Operator",
      "--json",
    ]);
    expect(r.status).toBe(EXIT.OK);
    const out = json<{ path: string; approved: boolean; scaffolded: boolean }>(r);
    expect(out.scaffolded).toBe(true);
    expect(out.approved).toBe(false);
    expect(counts().approvals).toBe(0);
    scaffoldPath = out.path;

    // The scaffold is a real, schema-valid document, not a stub.
    const text = readFileSync(scaffoldPath, "utf8");
    expect(text).toContain(proposalChecksum);
    expect(text).toContain("decision: approve");
  });

  it("M2-AT-2: a mismatched --checksum exits 3 and changes no state", () => {
    const before = counts();
    const r = cli([
      "approve",
      "experiment_selection",
      "--workspace",
      ws,
      "--investigation",
      "INV-001",
      "--from",
      scaffoldPath,
      "--checksum",
      `sha256:${"0".repeat(64)}`,
      "--json",
    ]);
    expect(r.status).toBe(EXIT.GATE_CHECKSUM_MISMATCH);
    expect(json<{ code: string }>(r).code).toBe("GATE_CHECKSUM_MISMATCH");
    expect(counts()).toEqual(before);
  });

  it("M2-AT-3: the file's proposalChecksum disagreeing with --checksum exits 3", () => {
    const tampered = join(dir, "disagreeing.yaml");
    writeFileSync(
      tampered,
      readFileSync(scaffoldPath, "utf8").replace(proposalChecksum, `sha256:${"1".repeat(64)}`),
      "utf8"
    );
    const r = cli([
      "approve",
      "experiment_selection",
      "--workspace",
      ws,
      "--investigation",
      "INV-001",
      "--from",
      tampered,
      "--checksum",
      proposalChecksum,
      "--json",
    ]);
    expect(r.status).toBe(EXIT.GATE_CHECKSUM_MISMATCH);
    expect(counts().approvals).toBe(0);
  });

  it("M2-AT-7: an edit outside the gate's surface is refused", () => {
    const bad = join(dir, "out-of-surface.yaml");
    writeFileSync(
      bad,
      readFileSync(scaffoldPath, "utf8").replace(
        "edits: []",
        [
          "edits:",
          "  - itemId: EXP-001",
          "    path: /hypothesis",
          '    from: "The initial page response resolves AFTER the filter response and overwrites the rendered list with an empty one."',
          '    to: "something I prefer"',
          '    rationale: "not permitted"',
        ].join("\n")
      ),
      "utf8"
    );
    const r = cli([
      "approve",
      "experiment_selection",
      "--workspace",
      ws,
      "--investigation",
      "INV-001",
      "--from",
      bad,
      "--checksum",
      proposalChecksum,
      "--json",
    ]);
    expect(json<{ code: string }>(r).code).toBe("GATE_EDIT_OUT_OF_SURFACE");
    expect(counts().approvals).toBe(0);
  });

  it("M2-AT-8: an edit whose `from` does not match the current value is refused", () => {
    const bad = join(dir, "stale-from.yaml");
    writeFileSync(
      bad,
      readFileSync(scaffoldPath, "utf8").replace(
        "edits: []",
        [
          "edits:",
          "  - itemId: EXP-001",
          "    path: /repetitions",
          "    from: 999",
          "    to: 4",
          '    rationale: "written against a different revision"',
        ].join("\n")
      ),
      "utf8"
    );
    const r = cli([
      "approve",
      "experiment_selection",
      "--workspace",
      ws,
      "--investigation",
      "INV-001",
      "--from",
      bad,
      "--checksum",
      proposalChecksum,
      "--json",
    ]);
    expect(json<{ code: string }>(r).code).toBe("GATE_EDIT_OUT_OF_SURFACE");
    expect(counts().approvals).toBe(0);
  });

  it("M2-AT-6: approving an item id that is not in the bundle is refused", () => {
    const bad = join(dir, "unknown-item.yaml");
    writeFileSync(
      bad,
      readFileSync(scaffoldPath, "utf8").replace("  - EXP-001", "  - EXP-404"),
      "utf8"
    );
    const r = cli([
      "approve",
      "experiment_selection",
      "--workspace",
      ws,
      "--investigation",
      "INV-001",
      "--from",
      bad,
      "--checksum",
      proposalChecksum,
      "--json",
    ]);
    expect(json<{ code: string }>(r).code).toBe("GATE_REFERENCE_UNKNOWN");
    expect(counts().approvals).toBe(0);
  });

  it("M2-AT-4: editing the proposal on disk after rendering is detected as stale", () => {
    const proposalFile = join(
      ws,
      ".investigator",
      "investigations",
      "INV-001",
      "manifests",
      "gate-1.experiment_selection.proposal.json"
    );
    const original = readFileSync(proposalFile, "utf8");
    try {
      // A plausible tamper: quietly raise the repetition count after a human read the document.
      writeFileSync(
        proposalFile,
        original.replace('"repetitions": 6', '"repetitions": 600'),
        "utf8"
      );
      const r = cli([
        "approve",
        "experiment_selection",
        "--workspace",
        ws,
        "--investigation",
        "INV-001",
        "--from",
        scaffoldPath,
        "--checksum",
        proposalChecksum,
        "--json",
      ]);
      // The checksum no longer matches the bytes, which is caught before anything else.
      expect(["GATE_CHECKSUM_MISMATCH", "GATE_PROPOSAL_STALE"]).toContain(
        json<{ code: string }>(r).code
      );
      expect(counts().approvals).toBe(0);
    } finally {
      writeFileSync(proposalFile, original, "utf8");
    }
  });
});

describe("M2 approval, execution, and lineage", () => {
  it("M2-AT-1: approves a subset with an edit, and records one immutable approval", () => {
    const edited = readFileSync(scaffoldPath, "utf8")
      .replace("approvedItemIds:\n  - EXP-001\n  - EXP-002", "approvedItemIds:\n  - EXP-001")
      .replace(
        "edits: []",
        [
          "edits:",
          "  - itemId: EXP-001",
          "    path: /repetitions",
          "    from: 6",
          "    to: 4",
          '    rationale: "Four repetitions is enough to observe the seeded failure."',
        ].join("\n")
      );
    writeFileSync(scaffoldPath, edited, "utf8");

    const r = cli([
      "approve",
      "experiment_selection",
      "--workspace",
      ws,
      "--investigation",
      "INV-001",
      "--from",
      scaffoldPath,
      "--checksum",
      proposalChecksum,
      "--json",
    ]);
    expect(r.status).toBe(EXIT.OK);
    const out = json<{
      approvalId: string;
      approvedItemIds: string[];
      edits: number;
      proposalChecksum: string;
      effectiveProposalChecksum: string;
    }>(r);

    expect(out.approvedItemIds).toEqual(["EXP-001"]);
    expect(out.edits).toBe(1);
    // The effective proposal is a different document from the one that was proposed.
    expect(out.effectiveProposalChecksum).not.toBe(out.proposalChecksum);
    expect(counts().approvals).toBe(1);
  });

  it("refuses a second decision on the same proposal", () => {
    const r = cli([
      "approve",
      "experiment_selection",
      "--workspace",
      ws,
      "--investigation",
      "INV-001",
      "--from",
      scaffoldPath,
      "--checksum",
      proposalChecksum,
      "--json",
    ]);
    expect(json<{ code: string }>(r).code).toBe("GATE_ALREADY_APPROVED");
    expect(counts().approvals).toBe(1);
  });

  it("exit criterion 8: gate 2 is unreachable before gate 2's own proposal exists", () => {
    const r = cli([
      "approve",
      "target_failure",
      "--workspace",
      ws,
      "--investigation",
      "INV-001",
      "--scaffold",
      "--json",
    ]);
    expect(r.status).not.toBe(EXIT.OK);
    expect(json<{ code: string }>(r).code).toBe("GATE_REQUIRED");
  });

  it("runs only what was approved, with the human's edit applied", () => {
    const r = cli([
      "run",
      "--workspace",
      ws,
      "--investigation",
      "INV-001",
      "--fixture-app",
      "product-failing-intermittent",
      "--json",
    ]);
    expect(r.status).toBe(EXIT.OK);
    const out = json<{
      approvalId: string;
      experiments: string[];
      requested: number;
      completed: number;
      byOutcome: Record<string, number>;
    }>(r);

    // EXP-002 was not approved, so it must not run however available it is.
    expect(out.experiments).toEqual(["EXP-001"]);
    // The EFFECTIVE proposal said 4; the proposal a human read said 6.
    expect(out.requested).toBe(4);
    expect(out.completed).toBe(4);
    expect(out.byOutcome["PRODUCT_FAILED"]).toBe(4);

    const experiments = db((d) =>
      (d.prepare("SELECT DISTINCT experiment_id e FROM jobs").all() as Array<{ e: string }>).map(
        (x) => x.e
      )
    );
    expect(experiments).toEqual(["EXP-001"]);
  }, 180_000);

  it("exit criterion 6 and 7: lineage reaches a human decision and the chain verifies", () => {
    const r = cli([
      "lineage",
      "--workspace",
      ws,
      "--investigation",
      "INV-001",
      "RUN-001",
      "--json",
    ]);
    expect(r.status).toBe(EXIT.OK);
    const out = json<{
      chainOk: boolean;
      ancestors: Array<{ edge: string; actorKind: string; actor: string }>;
      unauthorisedRuns: string[];
    }>(r);

    expect(out.chainOk).toBe(true);
    // "What authorised this run?" must be answerable, and the answer must be a human.
    const human = out.ancestors.filter((h) => h.actorKind === "human");
    expect(human.length).toBeGreaterThan(0);
    expect(human[0]?.actor).toContain("APPR-001");
    expect(out.ancestors.map((h) => h.edge)).toContain("approved_as");
    // The invariant the whole gate exists to protect.
    expect(out.unauthorisedRuns).toEqual([]);
  });

  it("M2-AT-12: the append-only trigger rejects mutating an approval or a lineage row", () => {
    for (const sql of [
      "UPDATE approvals SET decision = 'approve' WHERE approval_id = 'APPR-001'",
      "DELETE FROM lineage WHERE seq = 1",
    ]) {
      let err: unknown;
      try {
        db((d) => d.exec(sql));
      } catch (e) {
        err = e;
      }
      expect(err, `must refuse: ${sql}`).toBeDefined();
      expect(String((err as Error).message)).toContain("APPEND_ONLY");
    }
  });

  it("exit criterion 10: suite generate emits ordinary Playwright reproducing the EDITED sequence", () => {
    const outDir = join(dir, "suite");
    const r = cli([
      "suite",
      "generate",
      "--workspace",
      ws,
      "--investigation",
      "INV-001",
      "--out",
      outDir,
      "--json",
    ]);
    expect(r.status).toBe(EXIT.OK);

    const files = readdirSync(outDir);
    expect(files).toContain("exp-001.spec.ts");
    expect(files).toContain("README.md");

    const spec = readFileSync(join(outDir, "exp-001.spec.ts"), "utf8");
    expect(spec).toContain('import { test, expect } from "@playwright/test"');
    // The approved edit, not the proposal a human read.
    expect(spec).toMatch(/repetition <= 4/);
    expect(spec).toContain("getByTestId");
    // It names what authorised it, so a developer receiving it can trace it back.
    expect(spec).toContain("APPR-001");
    // And it must not emit the unapproved experiment.
    expect(files).not.toContain("exp-002.spec.ts");
  });

  it("M2-AT-14: retention apply is a dry run unless --confirm is given", () => {
    const r = cli([
      "retention",
      "apply",
      "--workspace",
      ws,
      "--investigation",
      "INV-001",
      "--older-than-days",
      "0",
      "--json",
    ]);
    expect(r.status).toBe(EXIT.OK);
    const out = json<{ dryRun: boolean; applied: boolean; eligible: number }>(r);
    expect(out.dryRun).toBe(true);
    expect(out.applied).toBe(false);
    expect(out.eligible).toBeGreaterThan(0);

    // Nothing was tombstoned.
    const tombstoned = db(
      (d) =>
        (
          d.prepare("SELECT COUNT(*) c FROM artifact_refs WHERE tombstoned = 1").get() as {
            c: number;
          }
        ).c
    );
    expect(tombstoned).toBe(0);
  });

  it("status reports gate state and lineage health", () => {
    const r = cli(["status", "--workspace", ws, "--investigation", "INV-001", "--json"]);
    expect(r.status).toBe(EXIT.OK);
    const out = json<{
      gates: Array<{ gate: string; state: string }>;
      runs: number;
      lineage: { chainOk: boolean; records: number };
    }>(r);
    expect(out.gates.find((g) => g.gate === "experiment_selection")?.state).toBe("APPROVED");
    expect(out.gates.find((g) => g.gate === "target_failure")?.state).toBe("NOT_REACHED");
    expect(out.runs).toBe(4);
    expect(out.lineage.chainOk).toBe(true);
  });
});
