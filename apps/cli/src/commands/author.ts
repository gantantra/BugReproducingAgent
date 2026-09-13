import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fail, sha256Prefixed, systemClock } from "@investigator/core";
import { investigationDirs } from "@investigator/storage";
import { LineageWriter } from "@investigator/lineage";
import type { GlobalOptions, Runtime } from "../runtime.js";
import {
  ALLOWED_PLAYWRIGHT_TOOLS,
  AUTHORING_EFFORT,
  AUTHORING_MODEL,
  claudeCliArgs,
  claudeCliEnv,
  findClaudeCli,
  playwrightMcpConfig,
} from "../claude-cli.js";
import {
  extractAuthoredSteps,
  renderAuthoredSpec,
  renderPlaywrightConfig,
  renderSuitePackageJson,
  whyStepsCannotMeasure,
  type AuthoredStep,
} from "../authoring-script.js";
import { translateAuthoredSteps } from "../authoring-actions.js";
import { buildAuthoredGateProposal } from "../authoring-proposal.js";

/**
 * `investigate author` — drive a real browser until the reported behaviour is reached (ADR-0027).
 *
 * Playwright produces evidence. Deterministic software normalizes and measures evidence. DeepSeek interprets and prioritizes evidence. Humans authorize consequential transitions.
 *
 * This is the one place a model drives a browser, and it is deliberately not the measurement
 * path. It produces no evidence, no outcome and no statistic — only a candidate script, which a
 * human approves before anything is measured. The measured re-runs stay deterministic with no
 * model anywhere near them.
 *
 * The operator's own `claude` CLI runs the session, so there is no second credential to configure,
 * and Playwright MCP supplies the browser tools. The script falls out of the session record: MCP
 * writes the exact Playwright statement for every call it made, so the suite is the run that
 * worked rather than a reconstruction of it.
 */

/** Bumped whenever ai/authoring/brief.md changes in a way that changes behaviour. */
export const AUTHORING_BRIEF_VERSION = "2.0.0";

/**
 * Repetitions the emitted proposal starts at.
 *
 * Thirty rather than ten because the bugs this product exists for are intermittent: a fault that
 * appears one run in five shows up in ten runs about 89% of the time, which is not a rate anyone
 * should plan around. The operator edits this in the rendered proposal before approving, and the
 * approval binds to the number they approved.
 */
export const DEFAULT_REPETITIONS = 30;

/** How the session ended, read from the last line of the final message. */
export type AuthoringOutcome =
  | { kind: "done" }
  | { kind: "plan"; plan: string }
  | { kind: "question"; question: string }
  | { kind: "stuck"; reason: string }
  | { kind: "unknown"; tail: string };

/**
 * Read the sentinel the brief asks for.
 *
 * One line rather than a schema, on purpose. Sonnet driving a browser does not need a validator
 * adjudicating every step; it needs the harness to know which of three things just happened. The
 * sentinel is scanned from the END, because the model may legitimately mention the format while
 * explaining itself.
 *
 * The question or reason may sit ON the sentinel line or in the message above it, and both are
 * accepted. The brief used to ask for both at once -- "the question as the very last line" and
 * then "the sentinel line, alone, last" -- so a session reasonably left the sentinel bare, and
 * the page rendered a card asking nothing at all. The brief is fixed, but reading both forms is
 * what makes that class of mistake stop mattering.
 */
export function readAuthoringOutcome(finalMessage: string): AuthoringOutcome {
  const lines = finalMessage.trimEnd().split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim().replace(/^[*_`\s]+|[*_`\s]+$/g, "");
    const m = /^AUTHORING:\s*(DONE|PLAN|QUESTION|STUCK)\b\s*(.*)$/i.exec(line);
    if (!m) continue;
    const verb = m[1]!.toUpperCase();
    const rest = (m[2] ?? "").trim();
    if (verb === "DONE") return { kind: "done" };

    // The text may be on the sentinel line, or in the message above it. Both happen, and an
    // empty question is useless to the person being asked -- the page rendered a card with a
    // blank space in it and a button, which tells them nothing about what is wanted.
    const body = () => lines.slice(0, i).join("\n").trim();
    // A plan is always the message above the sentinel: it is a numbered list, never one line.
    if (verb === "PLAN") return { kind: "plan", plan: body() || rest };
    if (verb === "QUESTION") return { kind: "question", question: rest || body() };
    return { kind: "stuck", reason: rest || body() };
  }
  // No sentinel. Reported as unknown rather than assumed complete: treating an unrecognised
  // ending as success would emit a script from a session that may have stopped halfway.
  return { kind: "unknown", tail: lines.slice(-3).join("\n") };
}

export interface AuthorOptions {
  /** Target name from config. Defaults to the only configured one. */
  env?: string;
  /** Show the browser. Off by default so an unattended session cannot steal focus. */
  headed?: boolean;
  /** Ceiling on agent turns. A confused session should end, not circle. */
  maxTurns?: number;
  /** Resume a paused session after answering its question. */
  resume?: string;
  /** The answer to the question that paused it, or a correction to the plan. */
  answer?: string;
  /**
   * Approve the written plan and start the browser.
   *
   * Without this, `author` runs the planning phase and stops. The two are separate CLI
   * invocations rather than one paused session because the planning phase is spawned with no MCP
   * server at all — see `runPlanningPhase`.
   */
  approvePlan?: boolean;
}

export interface AuthorResult {
  json: unknown;
  human: () => string;
}

export async function authorCommand(
  rt: Runtime,
  opts: AuthorOptions,
  globals: GlobalOptions
): Promise<AuthorResult> {
  const investigationId = globals.investigation;
  if (!investigationId) {
    fail("INPUT_INVALID", "`investigate author` requires --investigation <id>", {
      context: { flag: "--investigation" },
    });
  }

  const cli = findClaudeCli();
  if (!cli) {
    fail(
      "CONFIG_INVALID",
      "The `claude` CLI was not found on PATH. Authoring uses the login you already have; " +
        "install it with `npm i -g @anthropic-ai/claude-code`.",
      { context: { command: "claude" } }
    );
  }

  const names = Object.keys(rt.config.execution.targets);
  const targetName = opts.env ?? names[0];
  const target = targetName ? rt.config.execution.targets[targetName] : undefined;
  if (!target) {
    fail("CONFIG_INVALID", "No target is configured to author against", {
      context: { configured: names.join(",") || "(none)" },
    });
  }

  // The report is the only statement of what to reproduce. Authoring without one would be
  // exploration, and exploration on a real application is not something to start by accident.
  const report = latestIntakeReport(rt, investigationId);
  if (!report) {
    fail("INPUT_INVALID", "No intake report found for this investigation. Run `intake` first.", {
      context: { investigationId },
    });
  }

  const dirs = investigationDirs(rt.workspace, investigationId);
  const sessionDir = join(dirs.root, "authoring");
  const outputDir = join(sessionDir, "mcp");
  mkdirSync(outputDir, { recursive: true });

  // Credentials reach the browser as a file the MCP server reads, never as prompt text and never
  // as argv. The model names a secret; it never learns the value.
  const secretsPath = writeSecretsFile(rt, sessionDir);

  const mcpConfigPath = join(sessionDir, "mcp-config.json");
  writeFileSync(
    mcpConfigPath,
    JSON.stringify(
      playwrightMcpConfig({
        outputDir,
        ...(secretsPath ? { secretsPath } : {}),
        allowedOrigins: rt.config.safety.allowedOrigins,
        headless: opts.headed !== true,
      }),
      null,
      2
    ),
    "utf8"
  );

  const brief = readBrief();
  const planPath = join(sessionDir, "plan.md");

  /* The planning phase, and why it is a separate spawn rather than a pause.
   *
   * A session used to go from "Reproduce it" straight to a live browser, and the operator's first
   * sight of its intentions was the finished script. One filled in a change-password form on a
   * production site while signed out, with a password it invented, and reported success. Every
   * one of those mistakes was legible before a single page load.
   *
   * So the first turn writes a plan with NO MCP CONFIG AND NO TOOLS. That is the enforcement: it
   * is not asked to wait before browsing, it has no browser to reach for. Instruction alone has
   * already failed once here — 1.5.0 told sessions to end with a check and one did not — so the
   * guarantee is structural or it is not a guarantee.
   *
   * The approved plan then seeds a FRESH session that does have the browser. Nothing is lost by
   * not resuming: the planning turn has no page, no cookies and no snapshot to carry over, only
   * text, and the text is passed forward explicitly. */
  if (!opts.resume && !opts.approvePlan) {
    return runPlanningPhase({
      rt,
      cli: cli!,
      brief,
      planPath,
      investigationId,
      targetName: targetName!,
      report,
      baseUrl: target.baseUrl,
    });
  }

  const approvedPlan =
    opts.approvePlan && existsSync(planPath) ? readFileSync(planPath, "utf8") : "";

  const prompt = opts.resume
    ? (opts.answer ?? "")
    : buildPrompt({
        report,
        targetName: targetName!,
        baseUrl: target.baseUrl,
        allowedOrigins: rt.config.safety.allowedOrigins,
        credentialNames: rt.credentials.names(),
        approvedPlan,
        ...(opts.answer ? { planAmendments: opts.answer } : {}),
      });

  const args = claudeCliArgs({
    mcpConfigPath,
    // Without this the session stops on its first navigation asking for permission, which is not
    // a question the operator can usefully answer -- they approve the SCRIPT, at a gate, after
    // watching it. The allowlist is where "what may this session do" is decided, once.
    allowedTools: ALLOWED_PLAYWRIGHT_TOOLS,
    appendSystemPrompt: brief,
    maxTurns: opts.maxTurns ?? 60,
    outputFormat: "json",
    ...(opts.resume ? { resume: opts.resume } : {}),
  });

  const session = await runClaude(cli!, args, prompt, rt);
  const outcome = readAuthoringOutcome(session.finalMessage);

  // A script is emitted only from a session that reached the behaviour. A partial one is worse
  // than none: it looks complete, and the next person runs it.
  let suite: { dir: string; steps: number } | null = null;
  if (outcome.kind === "done") {
    suite = emitSuite({
      rt,
      investigationId,
      sessionDir,
      outputDir,
      reportSummary: firstLines(report, 3),
      // The plan the operator approved before the browser opened. It is the authored prose the
      // proposal's hypothesis is taken from, and it has already been read and accepted by the
      // person who will read it again at the gate.
      approvedPlan,
      // A starting point, not the decision. The operator edits it in the rendered proposal and
      // the approval binds to the edited bytes.
      repetitions: DEFAULT_REPETITIONS,
    });
    await new LineageWriter(rt.metadata, systemClock).append({
      investigationId,
      edge: "interpreted_as",
      fromKind: "intake_report",
      fromId: "intake_report",
      toKind: "flow",
      toId: `AUTHORED-${investigationId}`,
      // The brief is a versioned prompt artifact like any flow, so it is hashed into the record:
      // "which prompt bytes produced this script" has to be answerable offline, and an authoring
      // session is exactly where a changed instruction would change the output.
      actor: {
        kind: "ai",
        aiCallId: session.sessionId ?? "claude-cli",
        flowId: "authoring",
        flowVersion: AUTHORING_BRIEF_VERSION,
        flowHash: sha256Prefixed(brief),
      },
      inputs: { model: AUTHORING_MODEL, effort: AUTHORING_EFFORT, steps: suite.steps },
    });
  }

  return {
    json: {
      ok: outcome.kind === "done",
      investigationId,
      target: targetName,
      outcome: outcome.kind,
      ...(outcome.kind === "question" ? { question: outcome.question } : {}),
      ...(outcome.kind === "stuck" ? { reason: outcome.reason } : {}),
      sessionId: session.sessionId,
      suite,
      message: session.finalMessage,
    },
    human: () => renderHuman(outcome, session, suite, investigationId),
  };
}

function renderHuman(
  outcome: AuthoringOutcome,
  session: { sessionId: string | null; finalMessage: string },
  suite: {
    dir: string;
    steps: number;
    proposalPath?: string;
    proposalRefusal?: string;
  } | null,
  investigationId: string
): string {
  const lines = [session.finalMessage.trim(), ""];
  if (outcome.kind === "question") {
    lines.push(
      "The session is paused on a question. Answer it and it resumes with the browser and",
      "everything it has already done still in place:",
      "",
      `  investigate author --investigation ${investigationId} --resume ${session.sessionId ?? "<session>"} --answer "<your answer>"`
    );
  } else if (outcome.kind === "done" && suite) {
    lines.push(
      `Reproduction authored: ${suite.steps} steps.`,
      `  ${suite.dir}`,
      "",
      "Watch it work, then run it as many times as you need:",
      "  npm i && npx playwright test            # once, with video",
      "  npx playwright test --repeat-each=100   # to measure how often it fails"
    );
    if (suite.proposalPath) {
      lines.push(
        "",
        "The same flow is also ready to MEASURE, which is the path that captures console,",
        `network and trace evidence and can be analysed afterwards (${DEFAULT_REPETITIONS} runs by default —`,
        "edit `repetitions` in the proposal before approving if you want a different count):",
        "",
        `  investigate plan --investigation ${investigationId} --from ${suite.proposalPath}`,
        `  investigate approve experiment_selection --investigation ${investigationId} ...`,
        `  investigate run --investigation ${investigationId}`,
        `  investigate analyze --investigation ${investigationId} --ai`
      );
    } else if (suite.proposalRefusal) {
      lines.push(
        "",
        "The suite above is fine, but this session could NOT be turned into a measurable",
        "experiment, so the evidence-capturing path is unavailable for it:",
        `  ${suite.proposalRefusal}`
      );
    }
  } else if (outcome.kind === "stuck") {
    lines.push(
      "The session stopped and produced no script. That is deliberate:",
      "a partial reproduction looks complete, and the next person runs it."
    );
  } else {
    lines.push(
      "The session ended without saying how. No script was emitted, because an unrecognised",
      "ending may be a session that stopped halfway."
    );
  }
  return lines.join("\n");
}

/** Run the CLI to completion and return its final message. */
function runClaude(
  cli: string,
  args: string[],
  prompt: string,
  rt: Runtime
): Promise<{ sessionId: string | null; finalMessage: string; exitCode: number | null }> {
  return new Promise((resolvePromise) => {
    // `shell: false`, always. The prompt embeds a bug report written by someone else, and a shell
    // on Windows concatenates arguments rather than escaping them -- a report containing
    // `& del ...` would have run it. The prompt does not go in argv at all now; it is written to
    // stdin below.
    const child = spawn(cli, args, {
      env: claudeCliEnv(process.env),
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    });

    child.stdin.end(prompt, "utf8");

    let out = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (d: string) => (out += d));
    // stderr carries the CLI's own progress. Surfaced live so a long session is not a silent one.
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (d: string) => rt.logger.debug("claude", { line: d.trimEnd() }));

    child.on("close", (exitCode) => {
      let sessionId: string | null = null;
      let finalMessage = out.trim();
      try {
        const parsed = JSON.parse(out) as { session_id?: string; result?: string };
        sessionId = parsed.session_id ?? null;
        finalMessage = parsed.result ?? finalMessage;
      } catch {
        // Not JSON. The raw text is still the most useful thing to show.
      }
      resolvePromise({ sessionId, finalMessage, exitCode });
    });
  });
}

/** The operator's brief, a versioned file rather than a string literal in TypeScript. */
function readBrief(): string {
  for (const candidate of [
    resolve(process.cwd(), "ai", "authoring", "brief.md"),
    resolve(__dirname, "..", "..", "..", "..", "ai", "authoring", "brief.md"),
  ]) {
    if (existsSync(candidate)) return readFileSync(candidate, "utf8");
  }
  return fail("CONFIG_INVALID", "Could not locate ai/authoring/brief.md", {
    context: { cwd: process.cwd() },
  });
}

function buildPrompt(a: {
  report: string;
  targetName: string;
  baseUrl: string;
  allowedOrigins: readonly string[];
  credentialNames: readonly string[];
  approvedPlan?: string;
  planAmendments?: string;
}): string {
  return [
    "Reproduce this reported bug in the browser.",
    "",
    "## The report, in the reporter's own words",
    "",
    a.report,
    "",
    "## Where",
    "",
    `Target: ${a.targetName} — ${a.baseUrl}`,
    `Stay within these origins: ${a.allowedOrigins.join(", ") || "(none configured)"}`,
    "",
    a.credentialNames.length
      ? `Credentials available by name (reference them, never type a value): ${a.credentialNames.join(", ")}`
      : "No credentials were supplied. Ask if the flow needs one.",
    ...(a.approvedPlan
      ? [
          "",
          "## The plan the operator approved",
          "",
          a.approvedPlan,
          "",
          "Follow it. If the page turns out to differ from what you assumed when you wrote this,",
          "that is expected and you should adapt — but a step the operator struck out stays struck",
          "out, and anything they supplied here is the value to use rather than one you choose.",
        ]
      : []),
    ...(a.planAmendments
      ? ["", "## What the operator changed about that plan", "", a.planAmendments]
      : []),
  ].join("\n");
}

/**
 * Write the plan, with no browser anywhere near the session.
 *
 * No `--mcp-config` and no `--allowed-tools`, so the model physically cannot navigate, click or
 * submit while it is deciding what to do. The plan is persisted next to the session so approving
 * it is a second CLI call rather than state held in a web process.
 */
async function runPlanningPhase(a: {
  rt: Runtime;
  cli: string;
  brief: string;
  planPath: string;
  investigationId: string;
  targetName: string;
  report: string;
  baseUrl: string;
}): Promise<AuthorResult> {
  const prompt = [
    "Write the plan for reproducing this reported bug. Do not reproduce it yet.",
    "",
    "You have NO browser tools on this turn. That is deliberate: the operator reads your plan",
    "before anything touches their application, and approves or corrects it first.",
    "",
    "## The report, in the reporter's own words",
    "",
    a.report,
    "",
    "## Where",
    "",
    `Target: ${a.targetName} — ${a.baseUrl}`,
    "",
    a.rt.credentials.names().length
      ? `Credentials available by name: ${a.rt.credentials.names().join(", ")}`
      : "No credentials were supplied.",
  ].join("\n");

  const args = claudeCliArgs({
    appendSystemPrompt: a.brief,
    maxTurns: 4,
    outputFormat: "json",
  });

  const session = await runClaude(a.cli, args, prompt, a.rt);
  const outcome = readAuthoringOutcome(session.finalMessage);

  /* A planning turn may legitimately end on QUESTION rather than PLAN, and the first real one did:
   * it wrote seven steps, then asked which account to sign in as and what password to type. Both
   * endings are the same thing here -- a plan, with the gaps named -- so the plan is the body above
   * whichever sentinel was used, and a question is carried alongside rather than replacing it.
   * Keeping the sentinel line out of the plan matters: it is shown to the operator verbatim. */
  const plan = stripSentinel(session.finalMessage);
  const question = outcome.kind === "question" ? outcome.question : "";
  writeFileSync(a.planPath, plan, "utf8");

  return {
    json: {
      ok: outcome.kind === "plan" || outcome.kind === "question",
      investigationId: a.investigationId,
      target: a.targetName,
      outcome: "plan",
      plan,
      ...(question ? { question } : {}),
      sessionId: session.sessionId,
      suite: null,
      message: session.finalMessage,
    },
    human: () =>
      [
        "The plan, before anything opens a browser:",
        "",
        plan,
        ...(question ? ["", `It needs to know: ${question}`] : []),
        "",
        `Approve it with:  investigate author --investigation ${a.investigationId} --approve-plan`,
        `Answer or change: the same command plus --answer "<your answer>"`,
      ].join("\n"),
  };
}

/**
 * Everything above the last `AUTHORING:` line.
 *
 * The sentinel is harness plumbing; showing it to the operator inside the plan they are being
 * asked to approve is noise at best and confusing at worst.
 */
export function stripSentinel(message: string): string {
  const lines = message.trimEnd().split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^\s*[*_`\s]*AUTHORING:/i.test(lines[i]!)) return lines.slice(0, i).join("\n").trim();
  }
  return message.trim();
}

/**
 * Write the credential file the MCP server reads.
 *
 * Returns null when there is nothing to write, so no empty file sits in the workspace implying
 * credentials exist. `allValues` has one other caller — the redactor — and both exist to keep
 * these values out of everything else.
 */
function writeSecretsFile(rt: Runtime, sessionDir: string): string | null {
  const names = rt.credentials.names();
  if (names.length === 0) return null;
  const lines = names.map((n) => `${n}=${rt.credentials.revealSync(n) ?? ""}`);
  const path = join(sessionDir, ".secrets.env");
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(path, lines.join("\n") + "\n", { encoding: "utf8", mode: 0o600 });
  return path;
}

/** The most recently stored intake report for this investigation. */
function latestIntakeReport(rt: Runtime, investigationId: string): string | null {
  const dirs = investigationDirs(rt.workspace, investigationId);
  const kindDir = join(dirs.artifacts, "intake-report");
  if (!existsSync(kindDir)) return null;
  const files: string[] = [];
  for (const shard of readdirSync(kindDir)) {
    const shardDir = join(kindDir, shard);
    for (const f of readdirSync(shardDir)) files.push(join(shardDir, f));
  }
  if (files.length === 0) return null;
  const newest = files.map((f) => ({ f, t: statMtime(f) })).sort((a, b) => b.t - a.t)[0]!.f;
  return readFileSync(newest, "utf8");
}

function statMtime(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    // A file that vanished between listing and stat is simply not the newest one.
    return 0;
  }
}

/**
 * A short name for the test, from whatever the reporter wrote.
 *
 * A report pasted into the chat box is often one long paragraph with no heading, and taking "the
 * first line" then produced a test whose name was the entire bug report -- unreadable in a
 * Playwright run and worse in a CI summary. Trimmed at a sentence or word boundary so the name
 * still reads as a name.
 */
export function deriveTitleForTest(reportSummary: string, fallback: string): string {
  return deriveTitle(reportSummary, fallback);
}

function deriveTitle(reportSummary: string, fallback: string): string {
  const firstLine = firstLines(reportSummary, 1)
    .replace(/^#+\s*/, "")
    .trim();
  if (firstLine.length === 0) return fallback;
  if (firstLine.length <= 80) return firstLine;

  // Prefer ending on a sentence; otherwise cut on a word so it does not end mid-token.
  const sentence = firstLine.slice(0, 80).lastIndexOf(". ");
  if (sentence > 30) return firstLine.slice(0, sentence);
  const word = firstLine.slice(0, 80).lastIndexOf(" ");
  return `${firstLine.slice(0, word > 30 ? word : 80).trimEnd()}…`;
}

function firstLines(text: string, n: number): string {
  return text
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0)
    .slice(0, n)
    .join("\n");
}

/**
 * Assemble the emitted suite, and the gate-1 proposal that lets the same flow be MEASURED.
 *
 * Two artifacts from one session, both rendered from the same `AuthoredStep[]`:
 *
 * - `suite/` is the developer handoff — ordinary Playwright, runnable by someone who has never
 *   heard of this tool.
 * - `experiment-proposal.json` is the same flow in the closed action vocabulary, so
 *   `plan --from` can render it into the checksum-bound triple a human approves and `run` can
 *   execute it with full evidence capture. Without it the authored flow can only ever produce a
 *   pass/fail count and a video in its own folder, which no part of the analysis can read.
 *
 * The proposal is BEST EFFORT and never fails the command. A session can legitimately produce a
 * statement the vocabulary cannot express, and when that happens the suite is still worth having
 * — refusing to emit anything would trade a working handoff for nothing. The refusal reason is
 * returned so the operator is told plainly why the measured path is unavailable, rather than
 * discovering later that the button is missing.
 */
function emitSuite(a: {
  rt: Runtime;
  investigationId: string;
  sessionDir: string;
  outputDir: string;
  reportSummary: string;
  approvedPlan: string;
  repetitions: number;
}): { dir: string; steps: number; proposalPath?: string; proposalRefusal?: string } {
  const sessionMd = findSessionMarkdown(a.outputDir);
  const steps = sessionMd ? extractAuthoredSteps(readFileSync(sessionMd, "utf8")) : [];

  /* A session saying DONE is a claim, not a result — the same status every AI output in this
   * product has, and the same rule applies: untrusted until validated. The claim being checked
   * here is the only one that matters for what happens next, because the suite is about to be
   * handed to a human with a "Run it 30×" button beside it. If it cannot fail, those 30 runs
   * produce 30 passes and a report saying the bug did not reproduce, which is worse than no
   * report at all. Refusing here costs the operator one more authoring round. */
  const unmeasurable = whyStepsCannotMeasure(steps);
  if (unmeasurable) {
    fail("EXEC_VALUE_UNRESOLVED", `The session reported success but ${unmeasurable}`, {
      context: { outputDir: a.outputDir, steps: steps.length },
    });
  }

  const suiteDir = join(a.sessionDir, "suite");
  mkdirSync(join(suiteDir, "tests"), { recursive: true });

  const title = deriveTitle(a.reportSummary, a.investigationId);
  writeFileSync(
    join(suiteDir, "tests", "repro.spec.ts"),
    renderAuthoredSpec(steps, {
      title,
      investigationId: a.investigationId,
      reportSummary: a.reportSummary,
      authoredAt: systemClock.nowIso(),
    }),
    "utf8"
  );
  writeFileSync(
    join(suiteDir, "playwright.config.ts"),
    renderPlaywrightConfig({ outputDir: "./artifacts" }),
    "utf8"
  );
  writeFileSync(
    join(suiteDir, "package.json"),
    renderSuitePackageJson({
      investigationId: a.investigationId,
      playwrightVersion: playwrightVersion(),
    }),
    "utf8"
  );

  const { proposalPath, proposalRefusal } = emitProposal({ ...a, steps, suiteDir });
  return {
    dir: suiteDir,
    steps: steps.length,
    ...(proposalPath ? { proposalPath } : {}),
    ...(proposalRefusal ? { proposalRefusal } : {}),
  };
}

/**
 * Render the same session into a gate-1 proposal, or explain why it could not be.
 *
 * The credential map is built from `names()` plus `revealSync`, which is the only way to tell a
 * typed password apart from a typed search term. A value that matches a supplied credential
 * becomes a `secretRef` carrying the variable NAME, so the proposal — which is written to disk,
 * content-hashed, and read back at the gate — never holds the secret itself.
 */
function emitProposal(a: {
  rt: Runtime;
  investigationId: string;
  sessionDir: string;
  reportSummary: string;
  approvedPlan: string;
  repetitions: number;
  steps: readonly AuthoredStep[];
  suiteDir: string;
}): { proposalPath?: string; proposalRefusal?: string } {
  const secretsByValue = new Map<string, string>();
  for (const name of a.rt.credentials.names()) {
    const value = a.rt.credentials.revealSync(name);
    if (value && value.length > 0) secretsByValue.set(value, name);
  }

  const translated = translateAuthoredSteps(
    a.steps.map((s) => s.code),
    { secretsByValue }
  );
  if (!translated.ok) {
    return {
      proposalRefusal: `${translated.reason} — statement: ${translated.statement}`,
    };
  }

  const built = buildAuthoredGateProposal({
    investigationId: a.investigationId,
    actions: translated.actions,
    approvedPlan: a.approvedPlan,
    reportSummary: a.reportSummary,
    repetitions: a.repetitions,
    authoredAt: systemClock.nowIso(),
    briefVersion: AUTHORING_BRIEF_VERSION,
  });
  if (!built.ok) return { proposalRefusal: built.reason };

  const proposalPath = join(a.sessionDir, "experiment-proposal.json");
  writeFileSync(proposalPath, `${JSON.stringify(built.proposal, null, 2)}\n`, "utf8");
  return { proposalPath };
}

function findSessionMarkdown(outputDir: string): string | null {
  if (!existsSync(outputDir)) return null;
  for (const entry of readdirSync(outputDir)) {
    const candidate = join(outputDir, entry, "session.md");
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** Pin the emitted suite to the Playwright this machine authored with. */
function playwrightVersion(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return (require("playwright/package.json") as { version: string }).version;
  } catch {
    return "latest";
  }
}
