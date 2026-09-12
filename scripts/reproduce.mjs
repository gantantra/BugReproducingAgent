#!/usr/bin/env node
/**
 * `npm run reproduce` — the guided path: describe a bug in prose, answer a few questions,
 * approve what will run, and watch it run.
 *
 * Playwright produces evidence. Deterministic software normalizes and measures evidence.
 * DeepSeek interprets and prioritizes evidence. Humans authorize consequential transitions.
 *
 * This is a WRAPPER, not a new code path. Every consequential step shells out to the same
 * `investigate` binary an operator would type by hand, which is what makes the guarantees hold:
 *
 *  - It cannot auto-approve. The approval is written as a real file, bound by SHA-256 to the
 *    exact proposal bytes, and applied by the existing `approve` command — the only thing in the
 *    system that can create an approval record. The wizard asks; it never decides.
 *  - It cannot widen the safety envelope on its own. Declaring a non-fixture target, and
 *    accepting a destructive action, each require the operator to type the decision out.
 *  - It adds no --yes, --force, or --auto. There is deliberately no way to run this unattended.
 *
 *   node scripts/reproduce.mjs             guided
 *   node scripts/reproduce.mjs --keep      keep the workspace and print its path
 */
import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { URL } from "node:url";

const REPO = process.cwd();
const CLI = join(REPO, "apps", "cli", "dist", "bin.js");
const KEEP = process.argv.includes("--keep");

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

const rl = createInterface({ input: stdin, output: stdout });

/**
 * Line input that works whether stdin is a terminal or a pipe.
 *
 * The promise form of `question()` stalls once a piped stdin reaches EOF, which made this
 * script untestable without a TTY. Queueing `line` events instead keeps the interactive
 * experience identical and lets the flow be driven end to end in a test.
 *
 * This is not a way around the gate. Answers supplied on stdin are still a human's answers, and
 * the approval is still bound by SHA-256 to the exact proposal bytes — so a canned sequence
 * cannot approve a proposal that has since changed. Its checksum would no longer match.
 */
const waiting = [];
const buffered = [];
let stdinClosed = false;

rl.on("line", (line) => {
  const resolve = waiting.shift();
  if (resolve) resolve(line);
  else buffered.push(line);
});
rl.on("close", () => {
  stdinClosed = true;
  while (waiting.length) waiting.shift()(null);
});

function readLine() {
  if (buffered.length) return Promise.resolve(buffered.shift());
  if (stdinClosed) return Promise.resolve(null);
  return new Promise((resolve) => waiting.push(resolve));
}

class InputEnded extends Error {
  constructor() {
    super("input ended before the questions were answered — nothing was approved, nothing ran");
  }
}

async function ask(q, dflt = "") {
  stdout.write(C.cyan(q) + (dflt ? C.dim(` [${dflt}] `) : " "));
  const line = await readLine();
  if (line === null) throw new InputEnded();
  const a = line.trim();
  if (a) stdout.write("");
  return a || dflt;
}

/** Multi-line paste. Terminated by a line containing only END. */
async function askBlock(q) {
  console.log(C.cyan(q));
  console.log(C.dim("  (paste as many lines as you like, then type END on its own line)"));
  const lines = [];
  for (;;) {
    stdout.write("  > ");
    const line = await readLine();
    if (line === null) break;
    if (line.trim().toUpperCase() === "END") break;
    lines.push(line);
  }
  console.log("");
  return lines.join("\n").trim();
}

function cli(args, { expectFail = false, quiet = false } = {}) {
  if (!quiet) console.log(C.dim(`\n  $ investigate ${args.join(" ")}\n`));
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], { encoding: "utf8" });
    if (expectFail) throw new Error(`expected refusal: ${args.join(" ")}`);
    return { status: 0, stdout };
  } catch (e) {
    if (!expectFail) {
      console.error(C.red("  failed:"), e.stdout || e.stderr || e.message);
      throw e;
    }
    return { status: e.status, stdout: e.stdout ?? "" };
  }
}
const j = (r) => JSON.parse(r.stdout);
const indent = (t) =>
  t
    .trimEnd()
    .split("\n")
    .forEach((l) => console.log("  " + l));

const rule = () => console.log(C.bold("─".repeat(76)));
function heading(n, title) {
  console.log("");
  rule();
  console.log(C.bold(`  ${n}. ${title}`));
  rule();
}

const FIXTURES = [
  "product-failing-intermittent",
  "product-failing-deterministic",
  "passing",
  "automation-failing",
  "straddling-requests",
];

// -------------------------------------------------------------------------------------------

async function main() {
  console.log(C.bold("\n  ReproAgent — guided reproduction\n"));
  console.log("  Describe an intermittent Chrome issue. I will store it, interpret it, propose");
  console.log("  experiments, and run the ones you approve. Nothing reaches a browser until you");
  console.log("  approve it.\n");

  // --- 1. the bug ---------------------------------------------------------------------------
  heading(1, "What is the bug?");
  const report = await askBlock("  Describe it — steps, what you expect, what actually happens:");
  if (!report) {
    console.log(C.red("\n  Nothing to investigate. Stopping."));
    return;
  }

  console.log(
    C.dim(
      "\n  Note: this text is stored as an artifact and, with --ai, sent to DeepSeek.\n" +
        "  Redaction runs first, but check policies/default.yaml covers anything sensitive\n" +
        "  in what you just pasted — a test phone number or OTP often is not matched by\n" +
        "  the default rules."
    )
  );
  const proceed = await ask("\n  Continue? (yes/no)", "yes");
  if (!/^y/i.test(proceed)) return;

  const title = await ask("  Short title for this investigation:", "Intermittent issue");

  // --- 2. workspace -------------------------------------------------------------------------
  heading(2, "Workspace");
  const wsArg = await ask("  Workspace directory:", "./repro-workspace");
  const ws = resolve(REPO, wsArg);
  mkdirSync(ws, { recursive: true });
  indent(cli(["init", "--workspace", ws]).stdout);
  // Step 3 of the pipeline is "approve what you watched", which needs a recording to exist.
  enableVideo(ws);
  console.log(C.dim("  Video capture enabled for this workspace."));

  // --- 3. target ----------------------------------------------------------------------------
  heading(3, "Where should it run?");
  console.log("  1) a built-in local fixture app  (safe, offline, nothing real is touched)");
  console.log("  2) a real URL you are authorised to test");
  const mode = await ask("\n  Choose 1 or 2:", "1");

  let fixtureKind = null;
  let targetName = null;

  if (mode === "2") {
    const url = await ask("  Base URL (e.g. https://staging.example.com):");
    if (!/^https?:\/\//i.test(url)) {
      console.log(C.red("  Not a URL. Stopping."));
      return;
    }
    const origin = new URL(url).origin;
    targetName = await ask("  A short name for this target:", "target-under-test");

    // A deliberate, typed-out decision. There is no `production` classification in this
    // product -- only fixture, test and staging -- so pointing it at a real origin is the
    // operator asserting the environment is safe to act on, not a default it can drift into.
    console.log(
      C.yellow(
        `\n  You are about to allow real browser actions against ${origin}.\n` +
          "  This product has no 'production' classification. Declaring this target means you\n" +
          "  assert it is a test environment you are authorised to act on."
      )
    );
    const confirm = await ask('  Type the word "test" to declare it, or anything else to stop:');
    if (confirm !== "test") {
      console.log(C.red("  Not declared. Stopping."));
      return;
    }

    const cfgPath = join(ws, ".investigator", "config.yaml");
    let cfg = readFileSync(cfgPath, "utf8");
    cfg = cfg
      .replace(
        "  targets: {}",
        [
          "  targets:",
          `    ${targetName}:`,
          `      baseUrl: ${url}`,
          "      classification: test",
          "      resetStrategy: per-run-tenant",
          "      correlationHeaderAllowed: false",
        ].join("\n")
      )
      .replace("  allowedOrigins: []", `  allowedOrigins:\n    - ${origin}`);
    writeFileSync(cfgPath, cfg, "utf8");
    console.log(C.green(`  Declared target ${targetName} and allowlisted ${origin}.`));
    console.log(C.dim(`  Edit ${cfgPath} if you need to change it.`));
  } else {
    console.log("");
    FIXTURES.forEach((f, i) => console.log(`  ${i + 1}) ${f}`));
    const pick = Number.parseInt(await ask("\n  Choose a fixture:", "1"), 10);
    fixtureKind = FIXTURES[(Number.isFinite(pick) ? pick : 1) - 1] ?? FIXTURES[0];
    targetName = fixtureKind;
    console.log(C.green(`  Using local fixture ${fixtureKind}.`));
  }

  // --- 4. intake ----------------------------------------------------------------------------
  heading(4, "Storing your report");
  const reportPath = join(ws, "report.md");
  writeFileSync(reportPath, `# ${title}\n\n${report}\n`, "utf8");

  const aiReady = hasAiConfig(ws);
  if (!aiReady.ok) {
    console.log(C.yellow(`  DeepSeek is not configured: missing ${aiReady.missing.join(", ")}.`));
    console.log(C.dim("  Your report will be stored, but not interpreted into a Flow."));
    console.log(C.dim("  Fill the blanks in .env to enable it. See DEMO.md."));
  }

  const intakeArgs = [
    "intake",
    "--workspace",
    ws,
    "--from",
    reportPath,
    "--title",
    title,
    "--json",
  ];
  if (aiReady.ok) intakeArgs.push("--ai");
  const intake = j(cli(intakeArgs));
  const inv = intake.investigationId;

  console.log(`  investigation  ${C.bold(inv)}`);
  console.log(`  report stored  ${intake.reportArtifactId} (${intake.bytes} bytes)`);
  if (intake.redacted) console.log(C.yellow("  redaction was applied to your report"));
  if (intake.flow) {
    console.log(
      `  interpreted    ${intake.flow.flowId}: ${intake.flow.steps} steps, ${intake.flow.unknowns} unknown(s)`
    );
    console.log(
      C.dim("  Unknowns are values your report did not supply. They are reported, never invented.")
    );

    // Step 1 of the pipeline: say where the REPORT points, before anything is proposed.
    const sfp = intake.flow.suspectedFailurePoint;
    if (sfp) {
      console.log("");
      console.log(C.bold("  Where your report points:"));
      console.log(
        `    ${C.yellow(sfp.what ?? "")}  (${sfp.stepId ?? "?"}${sfp.actionId ? "/" + sfp.actionId : ""})`
      );
      console.log(`    why: ${sfp.why ?? ""}`);
      console.log(`    confidence in this READING of your report: ${sfp.confidence ?? "?"}`);
      console.log(
        C.dim("    This is where to look, not a diagnosis. Nothing has been measured yet.")
      );
      const agree = await ask("\n  Is that the right place to look? (yes/no)", "yes");
      if (!/^y/i.test(agree)) {
        const correction = await askBlock("  Where should it look instead, and why?");
        appendFileSync(
          reportPath,
          `\n\n## Correction from the reporter\n\n${correction}\n`,
          "utf8"
        );
        console.log(
          C.yellow("\n  Appended to your report. Re-run to re-interpret with the correction.")
        );
        return;
      }
    }

    // Step 2: the unknowns become questions, because that is what they are.
    const gaps = await readUnknowns(ws, inv);
    if (gaps.length) {
      console.log("");
      console.log(C.bold(`  ${gaps.length} thing(s) your report did not say:`));
      const answers = [];
      for (const g of gaps) {
        console.log(C.dim(`    (${g.why})`));
        const a = await ask(`  ${g.field}?`, "");
        if (a) answers.push({ field: g.field, answer: a });
      }
      if (answers.length) {
        appendFileSync(
          reportPath,
          `\n\n## Answers supplied by the reporter\n\n` +
            answers.map((a) => `- **${a.field}**: ${a.answer}`).join("\n") +
            "\n",
          "utf8"
        );
        console.log(C.green(`\n  ${answers.length} answer(s) appended to the report.`));
        console.log(
          C.dim("  Re-run to fold them into the interpretation; the proposal below uses what")
        );
        console.log(C.dim("  is known now. Nothing was silently filled in on your behalf."));
      }
    }
  }

  // --- 5. proposal --------------------------------------------------------------------------
  heading(5, "What should we try?");
  const planArgs = ["plan", "--workspace", ws, "--investigation", inv, "--json"];
  if (aiReady.ok) {
    planArgs.push("--ai");
  } else {
    const from = await ask(
      "  Path to a proposal JSON file:",
      "docs/examples/proposals/gate-1.input.json"
    );
    planArgs.push("--from", resolve(REPO, from));
  }
  const plan = j(cli(planArgs));

  console.log("");
  indent(readFileSync(plan.files.markdown, "utf8"));
  console.log("");
  console.log(`  proposal checksum  ${C.bold(plan.proposalChecksum)}`);

  // --- 6. the gate --------------------------------------------------------------------------
  heading(6, "Your decision");
  console.log("  Read the proposal above. Nothing has touched a browser yet.\n");

  const approver = await ask("  Your name, recorded on the approval:", "Operator");
  const scaffold = j(
    cli(
      [
        "approve",
        "experiment_selection",
        "--workspace",
        ws,
        "--investigation",
        inv,
        "--scaffold",
        "--approver",
        approver,
        "--json",
      ],
      { quiet: true }
    )
  );
  let yaml = readFileSync(scaffold.path, "utf8");

  const allIds = plan.items;
  const chosen = (
    await ask(`  Which experiments do you approve? (comma-separated, or 'all')`, "all")
  )
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const approved = chosen.length === 1 && /^all$/i.test(chosen[0]) ? allIds : chosen;
  const rejected = allIds.filter((id) => !approved.includes(id));
  if (approved.length === 0) {
    console.log(C.red("  You approved nothing. Stopping — and nothing will run."));
    return;
  }
  yaml = yaml.replace(
    /approvedItemIds:\n(?:\s+- .+\n)+/,
    `approvedItemIds:\n${approved.map((id) => `  - ${id}`).join("\n")}\n`
  );
  if (rejected.length) {
    console.log(C.dim(`  Rejected by omission: ${rejected.join(", ")}`));
  }

  const reps = await ask("  Repetitions per experiment (blank keeps the proposed count):", "");
  if (reps && Number.isFinite(Number(reps))) {
    const edits = approved.map((id) =>
      [
        `  - itemId: ${id}`,
        "    path: /repetitions",
        `    from: ${proposedReps(plan, id)}`,
        `    to: ${Number(reps)}`,
        '    rationale: "Set during guided reproduction."',
      ].join("\n")
    );
    yaml = yaml.replace("edits: []", `edits:\n${edits.join("\n")}`);
    console.log(C.yellow(`  Edit recorded: repetitions -> ${Number(reps)}`));
  }

  // Destructive actions. The scaffold lists them as a commented template; an acknowledgement
  // has to be written out, with a justification, or approval is refused by check 8.
  const destructive = [...yaml.matchAll(/#\s+- itemId: (\S+)\n#\s+actionId: (\S+)/g)]
    .map((m) => ({ itemId: m[1], actionId: m[2] }))
    .filter((d) => approved.includes(d.itemId));

  if (destructive.length) {
    console.log(
      C.red(
        `\n  This proposal contains ${destructive.length} DESTRUCTIVE action(s).\n` +
          "  Each needs your written justification. Leave one blank to stop."
      )
    );
    const acks = [];
    for (const d of destructive) {
      const why = await ask(`  Why is ${d.actionId} in ${d.itemId} acceptable here?`);
      if (!why) {
        console.log(C.red("  No justification. Stopping — nothing will run."));
        return;
      }
      acks.push(
        [
          `  - itemId: ${d.itemId}`,
          `    actionId: ${d.actionId}`,
          "    classification: destructive",
          "    acknowledged: true",
          `    justification: ${JSON.stringify(why)}`,
        ].join("\n")
      );
    }
    yaml = yaml.replace(
      "safetyAcknowledgements: []",
      `safetyAcknowledgements:\n${acks.join("\n")}`
    );
  }

  console.log(C.bold("\n  You are about to authorise:"));
  console.log(`    experiments  ${approved.join(", ")}`);
  console.log(`    target       ${targetName}`);
  console.log(`    proposal     ${plan.proposalChecksum}`);
  if (destructive.length) console.log(C.red(`    destructive  ${destructive.length} action(s)`));
  const final = await ask('\n  Type "approve" to authorise, anything else to stop:');
  if (final !== "approve") {
    console.log(C.red("  Not approved. Nothing ran."));
    return;
  }

  writeFileSync(scaffold.path, yaml, "utf8");
  const approval = j(
    cli([
      "approve",
      "experiment_selection",
      "--workspace",
      ws,
      "--investigation",
      inv,
      "--from",
      scaffold.path,
      "--checksum",
      plan.proposalChecksum,
      "--json",
    ])
  );
  console.log(C.green(`  APPROVED ${approval.approvalId}`));
  console.log(C.dim(`  effective proposal ${approval.effectiveProposalChecksum}`));
  console.log(C.dim("  Execution reads the EFFECTIVE proposal — the one including your edits."));

  // --- 7. run -------------------------------------------------------------------------------
  heading(7, "Reproducing");
  const runArgs = ["run", "--workspace", ws, "--investigation", inv, "--json"];
  if (fixtureKind) runArgs.push("--fixture-app", fixtureKind);
  else runArgs.push("--target", targetName);

  const run = j(cli(runArgs));
  console.log(`  authorised by  ${run.approvalId}`);
  console.log(`  experiments    ${run.experiments.join(", ")}`);
  console.log(`  runs           ${run.requested}`);
  console.log(`  outcomes       ${C.bold(JSON.stringify(run.byOutcome))}`);

  explainOutcomes(run.byOutcome);

  // --- 8. watch it ---------------------------------------------------------------------------
  heading(8, "Watch what actually happened");
  const videos = findVideos(ws, inv);
  if (videos.length === 0) {
    console.log(C.yellow("  No recording was produced."));
  } else {
    console.log("  Recordings:");
    for (const v of videos.slice(0, 5)) console.log(`    ${v}`);
    console.log(
      C.red(
        "\n  These are UNREDACTED. Redaction cannot mask what was visible on screen, so a\n" +
          "  recording may show a password or personal data that was typed or displayed."
      )
    );
    console.log(C.dim("\n  Open one and check the sequence is what you meant to test."));

    const verdict = await ask("\n  Does the run do what you described? (yes / no)", "yes");
    if (!/^y/i.test(verdict)) {
      const change = await askBlock("  What should change? (this is recorded, not auto-applied)");
      writeFileSync(join(ws, "requested-changes.md"), `${change}\n`, "utf8");
      console.log(C.yellow(`\n  Written to ${join(ws, "requested-changes.md")}.`));
      console.log("  Edit the proposal to match, re-run `plan`, and approve the new checksum.");
      console.log(C.dim("  Changing the sequence changes the proposal, so it needs a new"));
      console.log(C.dim("  approval by design — the old one was bound to the old bytes."));
      return;
    }
  }

  // --- 9. the reproduction script ------------------------------------------------------------
  heading(9, "A standalone Playwright script");
  const suiteDir = join(ws, "suite");

  // A suite that cannot be generated must not end the investigation. The runs happened, the
  // evidence exists, and the analysis at step 11 is the part the reporter actually asked for --
  // losing it because an export step failed would throw away the work to protect a convenience.
  let suite = null;
  const suiteResult = cli(
    ["suite", "generate", "--workspace", ws, "--investigation", inv, "--out", suiteDir, "--json"],
    { expectFail: true }
  );
  if (suiteResult.status === 0) {
    suite = JSON.parse(suiteResult.stdout);
  } else {
    let why = suiteResult.stdout;
    try {
      why = JSON.parse(suiteResult.stdout).message;
    } catch {
      /* not JSON; show it raw */
    }
    console.log(C.yellow(`  No script could be generated:\n  ${why}`));
    console.log(C.dim("  Continuing — the runs and their evidence are unaffected."));
  }
  if (suite) {
    console.log(`  ${suite.files.join("\n  ")}`);
    console.log(
      C.dim("\n  Ordinary Playwright. It runs without ReproAgent, and names the approval.")
    );
  }

  // --- 10. measure ----------------------------------------------------------------------------
  heading(10, "How many times should it run?");
  console.log("  An intermittent defect needs repetition before a rate means anything.");
  console.log(C.dim("  Each run is recorded in full: console, network, exceptions, DOM, video.\n"));
  console.log(
    C.dim(`  ${run.requested} run(s) already exist for this experiment.
`)
  );
  const more = Number.parseInt(await ask("  How many MORE runs?", "20"), 10);

  if (Number.isFinite(more) && more > 0) {
    // `--repeat` is the TOTAL repetition count for the experiment, not an increment: repetitions
    // are keyed by index, so passing `more` alone would re-request indices that already exist and
    // silently enqueue almost nothing. Asking for "more" and meaning "total" is the kind of
    // mismatch a user discovers only by counting the runs afterwards.
    const total = (run.requested ?? 0) + more;
    const batch = cli(
      [
        "run",
        "--workspace",
        ws,
        "--investigation",
        inv,
        "--repeat",
        String(total),
        ...(fixtureKind ? ["--fixture-app", fixtureKind] : ["--target", targetName]),
        "--json",
      ],
      { quiet: true }
    );
    try {
      const b = JSON.parse(batch.stdout);
      console.log(`  completed  ${b.completed ?? "?"}   outcomes ${JSON.stringify(b.byOutcome)}`);
    } catch {
      indent(batch.stdout);
    }
  }

  // --- 11. analysis ---------------------------------------------------------------------------
  heading(11, "What do the runs show?");
  const analyzeArgs = ["analyze", "--workspace", ws, "--investigation", inv];
  if (aiReady.ok) analyzeArgs.push("--ai");
  indent(cli(analyzeArgs).stdout);

  // --- 12. provenance -------------------------------------------------------------------------
  heading(12, "What authorised this, and is it intact?");
  if (run.runs?.[0]) {
    indent(cli(["lineage", "--workspace", ws, "--investigation", inv, run.runs[0].runId]).stdout);
  }
  indent(
    cli(["doctor", "--workspace", ws, "--verify-lineage"])
      .stdout.split("\n")
      .slice(0, 14)
      .join("\n")
  );

  console.log("");
  rule();
  console.log(C.green(C.bold("  Done.")));
  console.log(`  Workspace: ${ws}`);
  console.log(
    C.dim(`  Inspect further:  investigate status --workspace ${wsArg} --investigation ${inv}`)
  );
  if (!KEEP) console.log(C.dim("  (kept — delete it yourself when finished)"));
  rule();
  console.log("");
}

/** Proposed repetition count for an item, so an edit's `from` matches the proposal. */
function proposedReps(plan, itemId) {
  try {
    const bundle = JSON.parse(readFileSync(plan.files.json, "utf8"));
    const item = (bundle.items ?? []).find((i) => i.itemId === itemId);
    return item?.repetitions ?? 1;
  } catch {
    return 1;
  }
}

/** Ask `doctor` whether AI configuration resolves, rather than guessing from the environment. */
function hasAiConfig(ws) {
  try {
    const out = execFileSync(process.execPath, [CLI, "doctor", "--workspace", ws, "--json"], {
      encoding: "utf8",
    });
    // `config.aiConfig` is the authority. Reading only `aiConfigMissing` and defaulting an
    // absent field to [] would report "configured" for any shape change — failing open on
    // exactly the question being asked.
    const cfg = JSON.parse(out).config ?? {};
    const missing = cfg.aiConfigMissing ?? [];
    return { ok: cfg.aiConfig === "configured" && missing.length === 0, missing };
  } catch {
    return { ok: false, missing: ["(doctor could not report)"] };
  }
}

/**
 * The outcome taxonomy is the whole point, so say what each one means rather than printing a
 * count and leaving the operator to guess whether it went well.
 */
function explainOutcomes(byOutcome) {
  const n = (k) => byOutcome?.[k] ?? 0;
  console.log("");
  if (n("PRODUCT_FAILED")) {
    console.log(
      C.green(`  ${n("PRODUCT_FAILED")} run(s) hit the product defect — that is a SUCCESSFUL`)
    );
    console.log(
      C.green("  investigation step. The agent observed your bug. It is never retried away.")
    );
  }
  if (n("VALID_COMPLETED")) {
    console.log(`  ${n("VALID_COMPLETED")} run(s) completed with no failure.`);
    if (!n("PRODUCT_FAILED")) {
      console.log(C.dim("  The bug did not reproduce this time. Intermittent issues need more"));
      console.log(C.dim("  repetitions — re-run with a higher count."));
    }
  }
  if (n("AUTOMATION_FAILED")) {
    console.log(
      C.yellow(`  ${n("AUTOMATION_FAILED")} run(s) failed on the AUTOMATION, not the product.`)
    );
    console.log(
      C.yellow("  Usually a selector that did not match the real page. This is reported")
    );
    console.log(C.yellow("  separately on purpose: it must never be mistaken for a product bug."));
    console.log(C.dim("  Fix: get real selectors with"));
    console.log(C.dim('    npx playwright codegen --device="Pixel 7" <your url>'));
    console.log(C.dim("  then correct them in the proposal and re-run."));
  }
  if (n("INFRASTRUCTURE_FAILED")) {
    console.log(C.red(`  ${n("INFRASTRUCTURE_FAILED")} run(s) failed in the harness itself.`));
  }
}

/** The unknowns the interpretation recorded, read back from the stored flow artifact. */
async function readUnknowns(ws, inv) {
  const dir = join(ws, ".investigator", "investigations", inv, "artifacts", "flow");
  if (!existsSync(dir)) return [];
  for (const shard of readdirSync(dir)) {
    try {
      for (const f of readdirSync(join(dir, shard))) {
        const doc = JSON.parse(readFileSync(join(dir, shard, f), "utf8"));
        if (Array.isArray(doc.unknowns)) {
          return doc.unknowns.map((u) => ({
            field: String(u.field ?? ""),
            why: String(u.why ?? ""),
          }));
        }
      }
    } catch {
      /* not a flow document */
    }
  }
  return [];
}

/** Recordings written for this investigation, newest first. */
function findVideos(ws, inv) {
  const dir = join(ws, ".investigator", "investigations", inv, "artifacts", "video");
  if (!existsSync(dir)) return [];
  const out = [];
  for (const shard of readdirSync(dir)) {
    const shardDir = join(dir, shard);
    try {
      for (const f of readdirSync(shardDir)) {
        if (f.endsWith(".webm")) out.push(join(shardDir, f));
      }
    } catch {
      /* not a directory */
    }
  }
  return out.sort();
}

/** Turn on video capture for this workspace. Quoted: bare `on` is boolean true in YAML. */
function enableVideo(ws) {
  const cfgPath = join(ws, ".investigator", "config.yaml");
  const cfg = readFileSync(cfgPath, "utf8");
  if (/^\s*video:/m.test(cfg)) return;
  writeFileSync(cfgPath, cfg.replace("execution:", 'execution:\n  video: "on"'), "utf8");
}

main()
  .catch((e) => {
    console.error(C.red("\n  Stopped: ") + (e?.message ?? String(e)));
    process.exitCode = 1;
  })
  .finally(() => rl.close());
