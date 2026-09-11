#!/usr/bin/env node
/**
 * ReproAgent demo — the whole working story, end to end, in one command.
 *
 * Playwright produces evidence. Deterministic software normalizes and measures evidence.
 * DeepSeek interprets and prioritizes evidence. Humans authorize consequential transitions.
 *
 * Needs NO DeepSeek credential: every step here is deterministic, and the script clears the
 * DEEPSEEK_* variables so that is demonstrated rather than asserted.
 *
 *   node scripts/demo.mjs              run it
 *   node scripts/demo.mjs --keep       keep the workspace afterwards, and print its path
 *   node scripts/demo.mjs --pause      wait for Enter between chapters, for a live audience
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

const REPO = process.cwd();
const CLI = join(REPO, "apps", "cli", "dist", "bin.js");
const KEEP = process.argv.includes("--keep");
const PAUSE = process.argv.includes("--pause");

if (!existsSync(CLI)) {
  console.error("Build first:  npm run build");
  process.exit(1);
}

const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
};

// Cleared deliberately: the deterministic path must not need them, and this proves it.
const env = { ...process.env };
for (const k of [
  "DEEPSEEK_API_KEY",
  "DEEPSEEK_BASE_URL",
  "DEEPSEEK_FAST_MODEL",
  "DEEPSEEK_REASONING_MODEL",
  "DEEPSEEK_FALLBACK_MODEL",
]) {
  delete env[k];
}
// Without this a local .env would restore them and the demo would stop demonstrating anything.
env["REPROAGENT_NO_ENV_FILE"] = "1";

const root = mkdtempSync(join(tmpdir(), "reproagent-demo-"));
const ws = join(root, "ws");
let chapter = 0;

function say(title, why) {
  chapter++;
  console.log("");
  console.log(C.bold(`${"─".repeat(74)}`));
  console.log(C.bold(`  ${chapter}. ${title}`));
  if (why) console.log(C.dim(`     ${why}`));
  console.log(C.bold(`${"─".repeat(74)}`));
}

function show(args) {
  console.log(C.cyan(`\n  $ investigate ${args.join(" ")}\n`));
}

function cli(args, { expectFail = false, quiet = false } = {}) {
  if (!quiet) show(args);
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], { encoding: "utf8", env });
    if (expectFail) throw new Error(`expected this to be refused: ${args.join(" ")}`);
    return { status: 0, stdout };
  } catch (e) {
    if (!expectFail) {
      console.error(C.red("  unexpected failure:"), e.stdout || e.message);
      throw e;
    }
    return { status: e.status, stdout: e.stdout ?? "" };
  }
}

const j = (r) => JSON.parse(r.stdout);
const out = (text) =>
  text
    .trimEnd()
    .split("\n")
    .forEach((l) => console.log("  " + l));

async function pause() {
  if (!PAUSE) return;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  await new Promise((r) =>
    rl.question(C.dim("\n     [Enter to continue] "), () => (rl.close(), r()))
  );
}

// ---------------------------------------------------------------------------------------------

console.log(C.bold("\n  ReproAgent"));
console.log("  A local CLI agent that investigates intermittent Chrome issues.\n");
console.log(
  C.dim("  Playwright produces evidence. Deterministic software normalizes and measures")
);
console.log(C.dim("  evidence. DeepSeek interprets and prioritizes evidence. Humans authorize"));
console.log(C.dim("  consequential transitions."));
console.log(
  C.dim(`\n  No DEEPSEEK_* variable is set for this demo. Everything below is deterministic.`)
);

try {
  say("Create a workspace", "SQLite (WAL), redaction policy, investigation directories.");
  out(cli(["init", "--workspace", ws]).stdout);
  await pause();

  say("Take in a human's bug report", "Stored verbatim as an artifact — after redaction.");
  const intake = j(
    cli([
      "intake",
      "--workspace",
      ws,
      "--from",
      join(REPO, "docs/examples/intake/blank-results.md"),
      "--json",
    ])
  );
  console.log(`  investigation  ${C.bold(intake.investigationId)}`);
  console.log(`  report stored  ${intake.reportArtifactId}  (${intake.bytes} bytes)`);
  console.log(
    C.dim(`  A bug report is often where a secret first enters the system, so it crosses`)
  );
  console.log(C.dim(`  the redaction boundary like any collected evidence.`));
  await pause();

  say("Render the gate-1 proposal", "What a human will actually decide on.");
  const plan = j(
    cli([
      "plan",
      "--workspace",
      ws,
      "--investigation",
      "INV-001",
      "--from",
      join(REPO, "docs/examples/proposals/gate-1.input.json"),
      "--json",
    ])
  );
  console.log(`  items      ${plan.items.join(", ")}`);
  console.log(`  checksum   ${C.bold(plan.proposalChecksum)}`);
  console.log("");
  const md = readFileSync(plan.files.markdown, "utf8");
  const falsifier = md.split("\n").filter((l) => l.startsWith("**What would disprove it.**"))[0];
  console.log(C.dim("  The rendering leads with what would DISPROVE each hypothesis:"));
  console.log("  " + C.yellow(falsifier ?? ""));
  await pause();

  say("Try to run it now", "This is the point of the whole design.");
  const refused = cli(
    [
      "run",
      "--workspace",
      ws,
      "--investigation",
      "INV-001",
      "--fixture-app",
      "product-failing-intermittent",
      "--json",
    ],
    { expectFail: true }
  );
  const refusedJson = JSON.parse(refused.stdout);
  console.log(`  ${C.red("REFUSED")}  ${refusedJson.code}  (exit ${refused.status})`);
  console.log(`  ${refusedJson.message}`);
  console.log("");
  console.log(C.dim("  And nothing was scheduled. Refusing is not enough on its own:"));
  const jobsBefore = j(
    cli(["status", "--workspace", ws, "--investigation", "INV-001", "--json"], { quiet: true })
  );
  console.log(
    `  jobs enqueued: ${C.bold(String(jobsBefore.queue.pending + jobsBefore.queue.claimed + jobsBefore.queue.terminal))}`
  );
  await pause();

  say("A human approves — a subset, with an edit", "File-based, bound by SHA-256 to exact bytes.");
  const scaffold = j(
    cli([
      "approve",
      "experiment_selection",
      "--workspace",
      ws,
      "--investigation",
      "INV-001",
      "--scaffold",
      "--approver",
      "Demo Operator",
      "--json",
    ])
  );
  console.log(`  scaffolded ${scaffold.path}`);
  console.log(C.dim("  Scaffolding approves nothing. The operator now edits it:"));

  const edited = readFileSync(scaffold.path, "utf8")
    .replace("approvedItemIds:\n  - EXP-001\n  - EXP-002", "approvedItemIds:\n  - EXP-001")
    .replace(
      "edits: []",
      [
        "edits:",
        "  - itemId: EXP-001",
        "    path: /repetitions",
        "    from: 6",
        "    to: 4",
        '    rationale: "Four repetitions is enough to see the seeded failure."',
      ].join("\n")
    );
  writeFileSync(scaffold.path, edited, "utf8");
  console.log(C.yellow("    approve EXP-001 only  (EXP-002 rejected by omission)"));
  console.log(C.yellow("    edit /repetitions: 6 -> 4"));

  console.log(C.dim("\n  A wrong checksum is refused outright:"));
  const bad = cli(
    [
      "approve",
      "experiment_selection",
      "--workspace",
      ws,
      "--investigation",
      "INV-001",
      "--from",
      scaffold.path,
      "--checksum",
      "sha256:" + "0".repeat(64),
      "--json",
    ],
    { expectFail: true, quiet: true }
  );
  console.log(`  ${C.red(JSON.parse(bad.stdout).code)}  (exit ${bad.status})`);

  const approved = j(
    cli([
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
    ])
  );
  console.log(`  ${C.green("APPROVED")}  ${approved.approvalId} by ${"Demo Operator"}`);
  console.log(`  proposal   ${approved.proposalChecksum.slice(0, 26)}...`);
  console.log(`  effective  ${approved.effectiveProposalChecksum.slice(0, 26)}...`);
  console.log(C.dim("  Different documents. Execution reads the EFFECTIVE one — the edited one."));
  await pause();

  say("Now it runs", "Real Chromium, against a local fixture app.");
  const run = j(
    cli([
      "run",
      "--workspace",
      ws,
      "--investigation",
      "INV-001",
      "--fixture-app",
      "product-failing-intermittent",
      "--json",
    ])
  );
  console.log(`  authorised by  ${run.approvalId}`);
  console.log(
    `  experiments    ${run.experiments.join(", ")}   ${C.dim("(EXP-002 was not approved, so it did not run)")}`
  );
  console.log(`  repetitions    ${run.requested}   ${C.dim("(the EDITED 4, not the proposed 6)")}`);
  console.log(`  outcomes       ${JSON.stringify(run.byOutcome)}`);
  console.log("");
  console.log(C.dim("  PRODUCT_FAILED by outcome rule 4 is a SUCCESSFUL investigation step:"));
  console.log(C.dim("  the agent correctly observed a product defect. Exit code 0."));
  await pause();

  say("Ask what authorised any of it", "Answered offline: no browser, no provider.");
  out(cli(["lineage", "--workspace", ws, "--investigation", "INV-001", run.runs[0].runId]).stdout);
  await pause();

  say("Hand a developer a standalone reproduction", "Ordinary Playwright. No ReproAgent needed.");
  const suiteDir = join(root, "suite");
  const suite = j(
    cli([
      "suite",
      "generate",
      "--workspace",
      ws,
      "--investigation",
      "INV-001",
      "--out",
      suiteDir,
      "--json",
    ])
  );
  console.log(`  ${suite.files.join(", ")}`);
  const spec = readFileSync(join(suiteDir, "exp-001.spec.ts"), "utf8");
  console.log("");
  out(
    spec
      .split("\n")
      .filter(
        (l) => l.includes("import") || l.includes("repetition <=") || l.includes("getByTestId")
      )
      .slice(0, 4)
      .join("\n")
  );
  console.log(C.dim("\n  It reproduces the approved-and-edited sequence, and names the approval."));
  await pause();

  say("Health and integrity", "Every artifact content-hashed; lineage chain verified.");
  out(
    cli(["doctor", "--workspace", ws, "--verify-lineage"])
      .stdout.split("\n")
      .slice(0, 16)
      .join("\n")
  );

  console.log("");
  console.log(C.bold(`${"─".repeat(74)}`));
  console.log(C.green(C.bold("  Demo complete.")));
  console.log("");
  console.log("  What you just saw, in one sentence each:");
  console.log(`    • ${C.bold("Nothing reaches a browser without a recorded human decision.")}`);
  console.log("    • An approval is bound by SHA-256 to the exact bytes a human read.");
  console.log("    • What executes is the EDITED proposal, never the one merely proposed.");
  console.log(
    "    • A product failure is an observation, not an error — and is never retried away."
  );
  console.log("    • Provenance answers 'what authorised this?' offline, and is tamper-evident.");
  console.log("");
  console.log(C.dim("  Not built yet: DeepSeek-backed classification, frequency statistics,"));
  console.log(C.dim("  minimization, and report export. See docs/milestones/."));
  console.log(C.bold(`${"─".repeat(74)}\n`));

  if (KEEP) console.log(`  workspace kept at: ${ws}\n`);
} finally {
  if (!KEEP) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      /* disposable */
    }
  }
}
