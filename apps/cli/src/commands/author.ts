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
} from "../authoring-script.js";

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
export const AUTHORING_BRIEF_VERSION = "1.2.0";

/** How the session ended, read from the last line of the final message. */
export type AuthoringOutcome =
  | { kind: "done" }
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
 */
export function readAuthoringOutcome(finalMessage: string): AuthoringOutcome {
  const lines = finalMessage.trimEnd().split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim().replace(/^[*_`\s]+|[*_`\s]+$/g, "");
    const m = /^AUTHORING:\s*(DONE|QUESTION|STUCK)\b\s*(.*)$/i.exec(line);
    if (!m) continue;
    const verb = m[1]!.toUpperCase();
    const rest = (m[2] ?? "").trim();
    if (verb === "DONE") return { kind: "done" };
    if (verb === "QUESTION") return { kind: "question", question: rest };
    return { kind: "stuck", reason: rest };
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
  /** The answer to the question that paused it. */
  answer?: string;
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
  const prompt = opts.resume
    ? (opts.answer ?? "")
    : buildPrompt({
        report,
        targetName: targetName!,
        baseUrl: target.baseUrl,
        allowedOrigins: rt.config.safety.allowedOrigins,
        credentialNames: rt.credentials.names(),
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
  suite: { dir: string; steps: number } | null,
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
  ].join("\n");
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

function firstLines(text: string, n: number): string {
  return text
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0)
    .slice(0, n)
    .join("\n");
}

/** Assemble the emitted suite from the MCP session record. */
function emitSuite(a: {
  rt: Runtime;
  investigationId: string;
  sessionDir: string;
  outputDir: string;
  reportSummary: string;
}): { dir: string; steps: number } {
  const sessionMd = findSessionMarkdown(a.outputDir);
  const steps = sessionMd ? extractAuthoredSteps(readFileSync(sessionMd, "utf8")) : [];
  if (steps.length === 0) {
    fail("EXEC_VALUE_UNRESOLVED", "The session reported success but recorded no browser steps", {
      context: { outputDir: a.outputDir },
    });
  }

  const suiteDir = join(a.sessionDir, "suite");
  mkdirSync(join(suiteDir, "tests"), { recursive: true });

  const title = firstLines(a.reportSummary, 1).replace(/^#+\s*/, "") || a.investigationId;
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

  return { dir: suiteDir, steps: steps.length };
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
