import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fail } from "@investigator/core";
import { investigationDirs } from "@investigator/storage";
import type { GlobalOptions, Runtime } from "../runtime.js";

/**
 * `investigate rerun --repeat N` — run the authored Playwright suite N times and count the failures.
 *
 * This is the operator's own script, against the target they named, on their own machine. The
 * count they press is the decision: one pass proves nothing about a bug that only shows up
 * sometimes, and the number that matters is how many of N runs failed.
 *
 * It is NOT the measured executor. That path (`plan` → approve → `run`) captures console, network
 * and trace evidence for the analysis flow and is gated on a recorded approval. This one runs the
 * emitted suite exactly as `npx playwright test --repeat-each=N` would in a terminal, which is
 * what the suite was emitted for.
 *
 * Nothing here is spawned through a shell, and no argument comes from the browser except the
 * repetition count, which is validated as an integer twice over — once in the web allowlist and
 * again here.
 */

export interface RerunOptions {
  repeat?: number;
}

export interface RerunResult {
  json: unknown;
  human: () => string;
}

export interface SuiteCounts {
  total: number;
  passed: number;
  failed: number;
  flaky: number;
  skipped: number;
}

/**
 * Counts from Playwright's own JSON report, not from parsing its console output.
 *
 * `stats` is what the reporter writes when it has one; the walk is the fallback for a report that
 * does not, and both are here because a miscount is a wrong failure rate reported as a
 * measurement. Anything unrecognised counts as nothing rather than as a pass.
 */
export function summarizeReport(report: unknown): SuiteCounts {
  const stats = (report as { stats?: Record<string, unknown> } | null)?.stats;
  if (stats && typeof stats === "object") {
    const n = (key: string): number =>
      typeof stats[key] === "number" ? (stats[key] as number) : 0;
    const passed = n("expected");
    const failed = n("unexpected");
    const flaky = n("flaky");
    const skipped = n("skipped");
    return { total: passed + failed + flaky + skipped, passed, failed, flaky, skipped };
  }

  const counts: SuiteCounts = { total: 0, passed: 0, failed: 0, flaky: 0, skipped: 0 };
  const walk = (suite: unknown): void => {
    const s = suite as { suites?: unknown[]; specs?: unknown[] } | null;
    if (!s || typeof s !== "object") return;
    for (const spec of s.specs ?? []) {
      const tests = (spec as { tests?: unknown[] }).tests ?? [];
      for (const test of tests) {
        const status = String((test as { status?: unknown }).status ?? "");
        if (status === "expected") counts.passed++;
        else if (status === "unexpected") counts.failed++;
        else if (status === "flaky") counts.flaky++;
        else if (status === "skipped") counts.skipped++;
        else continue;
        counts.total++;
      }
    }
    for (const child of s.suites ?? []) walk(child);
  };
  for (const suite of (report as { suites?: unknown[] } | null)?.suites ?? []) walk(suite);
  return counts;
}

/** `7 of 30 (23%)`, or `none of 30` — the sentence the operator actually wants. */
export function describeFailures(counts: SuiteCounts): string {
  if (counts.total === 0) return "no runs were recorded";
  if (counts.failed === 0) return `none of ${counts.total} runs failed`;
  const percent = Math.round((counts.failed / counts.total) * 100);
  return `${counts.failed} of ${counts.total} runs failed (${percent}%)`;
}

/** Terminal colour codes Playwright puts in error messages; built from the escape character's code. */
const ANSI_COLOUR = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

/** Where a group of runs stopped short of the final check, and what they were waiting for. */
export interface RunStop {
  /** Script line the run was on, or null when it never reached a step (a browser that did not start). */
  line: number | null;
  statement: string;
  waitingFor: string | null;
  runs: number;
  /** Playwright's own page snapshot for the first run that stopped here, when it saved one. */
  errorContextPath?: string;
}

export interface RunBreakdown extends SuiteCounts {
  /** Runs that got as far as the final check, whatever its result. */
  reachedCheck: number;
  /** Runs where the final check itself failed: the measurement of the bug. */
  failedAtCheck: number;
  /** Runs that stopped at an earlier step: the script or the site, never the bug. */
  stoppedEarly: number;
  checkLine: number | null;
  stops: RunStop[];
}

/**
 * Split failed runs by WHERE they failed.
 *
 * The script's last statement is the check that decides whether the application behaved. A run
 * that fails THERE is the bug being measured. A run that fails at an earlier step never got far
 * enough to see it — the site offered a different path, or the script raced it — and counting it
 * as a failure reports a failure rate for the script rather than for the bug. Observed: thirty runs
 * reported as "30 of 30 failed", of which none had reached the check.
 */
export function classifyRuns(report: unknown, specText: string): RunBreakdown {
  const counts = summarizeReport(report);
  const lines = specText.split(/\r?\n/);
  let checkLine: number | null = null;
  lines.forEach((l, i) => {
    if (/^\s*await page\./.test(l)) checkLine = i + 1;
  });

  let reachedCheck = 0;
  let failedAtCheck = 0;
  let stoppedEarly = 0;
  const stops = new Map<string, RunStop>();

  const walk = (suite: unknown): void => {
    const s = suite as { suites?: unknown[]; specs?: unknown[] } | null;
    if (!s || typeof s !== "object") return;
    for (const spec of s.specs ?? []) {
      for (const test of (spec as { tests?: unknown[] }).tests ?? []) {
        for (const raw of (test as { results?: unknown[] }).results ?? []) {
          const result = raw as {
            status?: string;
            errors?: Array<{ message?: string; location?: { line?: number } }>;
            attachments?: Array<{ name?: string; path?: string }>;
          };
          if (result.status === "passed") {
            reachedCheck++;
            continue;
          }
          if (result.status !== "failed" && result.status !== "timedOut") continue;

          const errors = result.errors ?? [];
          const line =
            errors.map((e) => e.location?.line).find((n): n is number => typeof n === "number") ??
            null;
          if (line !== null && line === checkLine) {
            reachedCheck++;
            failedAtCheck++;
            continue;
          }

          stoppedEarly++;
          const text = errors
            .map((e) => String(e.message ?? ""))
            .join("\n")
            .replace(ANSI_COLOUR, "");
          const waitingFor = /waiting for ([^\n]+)/.exec(text)?.[1]?.trim() ?? null;
          const key = `${line ?? "none"}|${waitingFor ?? ""}`;
          const existing = stops.get(key);
          if (existing) {
            existing.runs++;
            continue;
          }
          const context = (result.attachments ?? []).find(
            (a) => /error-context/.test(a.name ?? "") && a.path
          );
          stops.set(key, {
            line,
            statement:
              line !== null ? (lines[line - 1] ?? "").trim() : text.split("\n")[0]!.slice(0, 200),
            waitingFor,
            runs: 1,
            ...(context?.path ? { errorContextPath: context.path } : {}),
          });
        }
      }
    }
    for (const child of s.suites ?? []) walk(child);
  };
  for (const suite of (report as { suites?: unknown[] } | null)?.suites ?? []) walk(suite);

  return {
    ...counts,
    reachedCheck,
    failedAtCheck,
    stoppedEarly,
    checkLine,
    stops: [...stops.values()].sort((a, b) => b.runs - a.runs),
  };
}

/** The sentence the operator actually wants: how often the BUG happened, and what else went wrong. */
export function describeBreakdown(b: RunBreakdown): string {
  if (b.total === 0) return "no runs were recorded";
  const parts: string[] = [];
  if (b.reachedCheck === 0) {
    parts.push(`none of ${b.total} runs reached the final check`);
  } else if (b.failedAtCheck === 0) {
    parts.push(`${b.reachedCheck} of ${b.total} runs reached the final check and none failed it`);
  } else {
    const percent = Math.round((b.failedAtCheck / b.reachedCheck) * 100);
    parts.push(
      `${b.reachedCheck} of ${b.total} runs reached the final check and ${b.failedAtCheck} of those failed it (${percent}%)`
    );
  }
  if (b.stoppedEarly > 0) {
    const top = b.stops[0]!;
    const where =
      top.line !== null
        ? `line ${top.line}${top.waitingFor ? `, waiting for ${top.waitingFor}` : ""}`
        : top.statement;
    parts.push(
      `${b.stoppedEarly} stopped before it — the script or the site, not the bug — ${b.stops.length > 1 ? "most at" : "at"} ${where}`
    );
  }
  return parts.join("; ");
}

/** npm as a script this Node can run, so nothing needs a shell to install the suite's own deps. */
function npmCli(): string {
  const candidates = [
    join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
    join(dirname(process.execPath), "lib", "node_modules", "npm", "bin", "npm-cli.js"),
    ...(process.env["APPDATA"]
      ? [join(process.env["APPDATA"], "npm", "node_modules", "npm", "bin", "npm-cli.js")]
      : []),
    "/usr/lib/node_modules/npm/bin/npm-cli.js",
    "/usr/local/lib/node_modules/npm/bin/npm-cli.js",
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return fail(
    "CONFIG_INVALID",
    "The suite needs its own Playwright installed once and npm could not be located. Run `npm install` in the suite folder yourself, then press run again.",
    { context: { searched: candidates.join(" | ") } }
  );
}

/**
 * Why a child would not start here, in words the operator can act on.
 *
 * Windows caps a process's working directory at 260 characters — a limit `CreateProcess` reports
 * as ENOENT against the EXECUTABLE, which reads as "node is missing" when node is plainly running.
 * A session folder is already long (workspace, session, investigation, `authoring/suite`), so this
 * is reachable rather than theoretical, and the honest answer is the path and its length.
 */
function whyItWouldNotStart(suiteDir: string): string {
  return suiteDir.length >= 240
    ? ` The suite folder path is ${suiteDir.length} characters, and Windows limits a process's working directory to 260 — run the suite from a shorter workspace path.`
    : "";
}

/** Run a node script, streaming every line to stderr so the page's log shows it live. */
function runNode(args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<number | null> {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });
    const pump = (stream: NodeJS.ReadableStream): void => {
      let buffer = "";
      stream.setEncoding("utf8");
      // A pipe to a child that has already gone emits its own error, and an unhandled one on a
      // socket takes this process down with ENOTCONN before the run can be reported. The child's
      // own `error` and `close` below are what decide the outcome.
      stream.on("error", () => {});
      stream.on("data", (chunk: string) => {
        buffer += chunk;
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (line.trim()) process.stderr.write(`${line}\n`);
        }
      });
      stream.on("end", () => {
        if (buffer.trim()) process.stderr.write(`${buffer}\n`);
      });
    };
    if (child.stdout) pump(child.stdout);
    if (child.stderr) pump(child.stderr);
    let startFailure: string | null = null;
    child.on("error", (e) => {
      // Reported rather than thrown: "npm is not where this looked" is an answer the operator can
      // act on, and the caller turns a non-zero result into a typed failure naming the step.
      startFailure = e.message;
      process.stderr.write(`could not start ${args[0] ?? "the process"}: ${e.message}\n`);
    });
    child.on("close", (code) => resolvePromise(startFailure !== null ? -1 : code));
  });
}

export async function rerunCommand(
  rt: Runtime,
  opts: RerunOptions,
  globals: GlobalOptions
): Promise<RerunResult> {
  const investigationId = globals.investigation;
  if (!investigationId) {
    fail("INPUT_INVALID", "`investigate rerun` requires --investigation <id>", {
      context: { flag: "--investigation" },
    });
  }

  const repetitions = opts.repeat ?? 1;
  if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 500) {
    fail("INPUT_INVALID", "`--repeat` must be a whole number between 1 and 500", {
      context: { repeat: String(opts.repeat ?? "") },
    });
  }

  const suiteDir = join(
    investigationDirs(rt.workspace, investigationId).root,
    "authoring",
    "suite"
  );
  if (!existsSync(join(suiteDir, "package.json"))) {
    fail(
      "INPUT_INVALID",
      "There is no authored suite for this investigation yet. Reproduce the bug in a browser first; the suite is written when a session reaches the behaviour.",
      { context: { investigationId, suiteDir } }
    );
  }

  /* The suite declares its own pinned Playwright, and it needs its own copy of it: the machine
   * may have a different version installed elsewhere, and two copies in one run fail with
   * "Playwright Test did not expect test() to be called here" rather than anything legible. */
  const runnerCli = join(suiteDir, "node_modules", "@playwright", "test", "cli.js");
  if (!existsSync(runnerCli)) {
    process.stderr.write("📦 Installing the suite's own Playwright (first run only)...\n");
    const installed = await runNode(
      [npmCli(), "install", "--no-audit", "--no-fund"],
      suiteDir,
      process.env
    );
    if (installed !== 0 || !existsSync(runnerCli)) {
      fail(
        "EXEC_ACTION_FAILED",
        `Could not install the suite's Playwright.${whyItWouldNotStart(suiteDir)}`,
        {
          context: {
            suiteDir,
            pathLength: String(suiteDir.length),
            exitCode: String(installed ?? "null"),
          },
        }
      );
    }
  }

  // The script types credentials by name (`process.env['ACCOUNT_PHONE']`), exactly as the browser
  // session did. The values stay in this process's child env and never reach argv or a log line.
  /* Colour is left exactly as the operator's environment set it: output here goes to a pipe
   * rather than a terminal, so the runner prints plain text anyway.
   *
   * What IS suppressed is Node's process warnings inside the runner. Playwright sets FORCE_COLOR
   * for the workers it spawns, and if the environment already carries NO_COLOR the two contradict,
   * so every worker prints a two-line warning about it -- sixty lines in a thirty-run batch,
   * around the handful the operator is actually watching for. Test results and failures come from
   * the runner's own reporter and are untouched. */
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_NO_WARNINGS: "1" };
  const supplied: string[] = [];
  for (const name of rt.credentials.names()) {
    const value = rt.credentials.revealSync(name);
    if (value !== undefined) {
      env[name] = value;
      supplied.push(name);
    }
  }

  const artifactsDir = join(suiteDir, "artifacts");
  mkdirSync(artifactsDir, { recursive: true });
  const reportPath = join(artifactsDir, "last-run.report.json");
  env["PLAYWRIGHT_JSON_OUTPUT_NAME"] = reportPath;

  process.stderr.write(
    `▶️ Running the authored script ${repetitions}× (video per run, no retries)...\n`
  );
  const exitCode = await runNode(
    [runnerCli, "test", `--repeat-each=${repetitions}`, "--reporter=list,json"],
    suiteDir,
    env
  );

  if (exitCode === -1) {
    fail(
      "EXEC_ACTION_FAILED",
      `The Playwright runner could not start.${whyItWouldNotStart(suiteDir)}`,
      {
        context: { suiteDir, pathLength: String(suiteDir.length) },
      }
    );
  }

  let counts: SuiteCounts = { total: 0, passed: 0, failed: 0, flaky: 0, skipped: 0 };
  let reportRead = false;
  let parsedReport: unknown = null;
  if (existsSync(reportPath)) {
    try {
      parsedReport = JSON.parse(readFileSync(reportPath, "utf8"));
      counts = summarizeReport(parsedReport);
      reportRead = true;
    } catch {
      // A report that cannot be parsed leaves the counts at zero and says so below, rather than
      // reporting a pass rate computed from nothing.
    }
  }

  const specPath = join(suiteDir, "tests", "repro.spec.ts");
  const breakdown = classifyRuns(
    parsedReport,
    existsSync(specPath) ? readFileSync(specPath, "utf8") : ""
  );
  const summary = reportRead ? describeBreakdown(breakdown) : describeFailures(counts);
  // Kept beside the report, so a later step can see where runs stopped without re-running them.
  if (reportRead) {
    writeFileSync(
      join(artifactsDir, "last-run.evidence.json"),
      `${JSON.stringify({ at: new Date().toISOString(), repetitions, ...breakdown }, null, 2)}\n`,
      "utf8"
    );
  }
  return {
    json: {
      // A failing run is the POINT here: the command succeeded if the suite ran and was counted.
      ok: reportRead,
      investigationId,
      suiteDir,
      repetitions,
      ...breakdown,
      // Of the runs that reached the check. A run that stopped earlier says nothing about the bug.
      failureRate:
        breakdown.reachedCheck > 0 ? breakdown.failedAtCheck / breakdown.reachedCheck : 0,
      summary,
      exitCode,
      reportPath,
      artifactsDir,
      credentialsSupplied: supplied,
      ...(reportRead
        ? {}
        : {
            code: "EXEC_ACTION_FAILED",
            message:
              "The suite ran but wrote no readable report, so nothing was counted. The log above is what it printed.",
          }),
    },
    human: () =>
      [
        `Ran the authored suite ${repetitions}× for ${investigationId}.`,
        `  ${summary}`,
        `  passed ${counts.passed}   failed ${counts.failed}   flaky ${counts.flaky}   skipped ${counts.skipped}`,
        `  videos and traces  ${artifactsDir}`,
        "",
        breakdown.stoppedEarly > 0
          ? "Runs that stopped before the final check are not counted against the bug: they never got far enough to see it."
          : breakdown.failedAtCheck > 0
            ? "That is a failure rate measured from real runs, which is what an intermittent bug needs."
            : "Every run passed. Either the fault did not appear this time, or the check does not catch it.",
      ].join("\n"),
  };
}
