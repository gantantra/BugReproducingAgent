import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
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
  planOptionalBlocks,
  readOptionalScreens,
  renderAuthoredSpec,
  renderPlaywrightConfig,
  renderSuitePackageJson,
  whyStepsCannotMeasure,
  type AuthoredStep,
  type OptionalScreen,
} from "../authoring-script.js";
import { translateAuthoredSteps } from "../authoring-actions.js";
import { buildAuthoredGateProposal } from "../authoring-proposal.js";
import { buildRepairPrompt, readRepairEvidence } from "../authoring-repair.js";
import { LIVE_VIEW_DIR, liveFramePath, writeLiveViewHook } from "../live-view.js";
import type { EmulationProfile } from "@investigator/core";
import {
  browserContextOptions,
  describeProfile,
  profileCatalogue,
  readPlatformFile,
  readPlatformLine,
  stripPlatformLine,
  writePlatformFile,
  type PlatformChoice,
} from "../authoring-platform.js";

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
export const AUTHORING_BRIEF_VERSION = "2.5.0";

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
  /** The browser must be relaunched as another profile before the session can carry on. */
  | { kind: "platform"; profile: string }
  | { kind: "unknown"; tail: string };

/**
 * Read the sentinel the brief asks for.
 *
 * One line rather than a schema, on purpose. DeepSeek driving a browser does not need a validator
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
    const m = /^AUTHORING:\s*(DONE|PLAN|QUESTION|STUCK|PLATFORM)\b\s*(.*)$/i.exec(line);
    if (!m) continue;
    const verb = m[1]!.toUpperCase();
    const rest = (m[2] ?? "").trim();
    if (verb === "DONE") return { kind: "done" };
    if (verb === "PLATFORM") return { kind: "platform", profile: rest.split(/\s+/)[0] ?? "" };

    // The text may be on the sentinel line, or in the message above it. Both happen, and an
    // empty question is useless to the person being asked -- the page rendered a card with a
    // blank space in it and a button, which tells them nothing about what is wanted.
    const body = () => lines.slice(0, i).join("\n").trim();
    // A plan is always the message above the sentinel: it is a numbered list, never one line.
    if (verb === "PLAN") return { kind: "plan", plan: body() || rest };
    if (verb === "QUESTION") return { kind: "question", question: rest || body() };
    return { kind: "stuck", reason: rest || body() };
  }
  if (/maximum number of turns|max_turns_reached|maximum turns reached|turn limit reached/i.test(finalMessage)) {
    return {
      kind: "stuck",
      reason: "Authoring reached the turn limit without completing. You can inspect screenshots, supply credentials or instructions, and resume.",
    };
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
   * With `resume`: re-record the script from where its last replay stopped before the final check.
   * The evidence is read from disk (see authoring-repair.ts), so nothing is typed.
   */
  repair?: boolean;
  /**
   * Approve the written plan and start the browser.
   *
   * Without this, `author` runs the planning phase and stops. The two are separate CLI
   * invocations rather than one paused session because the planning phase is spawned with no MCP
   * server at all — see `runPlanningPhase`.
   */
  approvePlan?: boolean;
  /**
   * In the planning phase: the operator has nothing more to add. The turn must write its plan with
   * any remaining gaps marked, rather than ask again.
   */
  thatsAll?: boolean;
  /**
   * With `approvePlan`: the checksum of the plan the operator read. The plan on disk must still
   * hash to it, so an approval cannot land on a plan that was rewritten after it was shown.
   */
  planChecksum?: string;
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
  const userDataDir = join(sessionDir, "browser-profile");
  mkdirSync(outputDir, { recursive: true });
  mkdirSync(userDataDir, { recursive: true });

  // Credentials reach the browser as a file the MCP server reads, never as prompt text and never
  // as argv. The model names a secret; it never learns the value.
  const secretsPath = writeSecretsFile(rt, sessionDir);

  const liveViewHook = writeLiveViewHook(sessionDir);
  const mcpConfigPath = join(sessionDir, "mcp-config.json");
  const platformPath = join(sessionDir, "platform.json");
  const profiles = rt.config.execution.emulation.profiles;
  const defaultPlatform: PlatformChoice = {
    profile: rt.config.execution.emulation.defaultProfile,
    source: "default",
  };

  /* The browser is launched as a platform, not asked to imitate one (see authoring-platform.ts).
   * Rewritten before every browser session, because a session may switch profile mid-way and
   * each resume starts a fresh MCP server that reads these files. */
  const writeBrowserConfig = (profileName: string): void => {
    const profile = profiles[profileName];
    if (!profile) {
      return fail("CONFIG_INVALID", "Emulation profile is not defined", { context: { profileName } });
    }
    const browserConfigPath = join(sessionDir, "browser-config.json");
    writeFileSync(
      browserConfigPath,
      JSON.stringify({ browser: { contextOptions: browserContextOptions(profile) } }, null, 2),
      "utf8"
    );
    writeFileSync(
      mcpConfigPath,
      JSON.stringify(
        playwrightMcpConfig({
          outputDir,
          userDataDir,
          initPage: liveViewHook,
          browserConfigPath,
          ...(secretsPath ? { secretsPath } : {}),
          allowedOrigins: rt.config.safety.allowedOrigins,
          headless: opts.headed !== true,
        }),
        null,
        2
      ),
      "utf8"
    );
  };

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
      profiles,
      defaultProfile: defaultPlatform.profile,
      platformPath,
      ...(opts.answer ? { answer: opts.answer } : {}),
      thatsAll: opts.thatsAll === true,
    });
  }

  if (opts.approvePlan && opts.planChecksum !== undefined) {
    const onDisk = existsSync(planPath) ? sha256Prefixed(readFileSync(planPath, "utf8")) : null;
    if (onDisk !== opts.planChecksum) {
      fail(
        "GATE_CHECKSUM_MISMATCH",
        "The plan on disk is not the plan that was approved. Read the current plan and approve it again.",
        { context: { expected: opts.planChecksum, actual: onDisk ?? "(no plan)" } }
      );
    }
  }

  const approvedPlan =
    opts.approvePlan && existsSync(planPath) ? readFileSync(planPath, "utf8") : "";
  if (opts.approvePlan && approvedPlan) {
    // The plan the browser session is about to act on, bound by its hash. The operator's click is
    // recorded as the reason, not as a gate approval: a plan authorizes an attended authoring
    // session, never a measured run.
    await new LineageWriter(rt.metadata, systemClock).append({
      investigationId,
      edge: "interpreted_as",
      fromKind: "intake_report",
      fromId: "intake_report",
      toKind: "flow",
      toId: `PLAN-${investigationId}-v${planVersionOf(planPath)}`,
      actor: { kind: "deterministic", component: "author.approve-plan", version: AUTHORING_BRIEF_VERSION },
      inputs: {
        planChecksum: sha256Prefixed(approvedPlan),
        checksumConfirmed: opts.planChecksum !== undefined,
      },
    });
  }

  // The platform the plan chose, or the session later asked for. With neither on record the
  // configured default is used, and the log names it either way.
  let platform: PlatformChoice = readPlatformFile(platformPath, profiles) ?? defaultPlatform;
  const describePlatform = (): string => describeProfile(platform.profile, profiles[platform.profile]!);
  writeBrowserConfig(platform.profile);
  process.stderr.write(`📱 Browser: ${describePlatform()}\n`);

  // A plan approval starts a new attempt; a resume or a platform relaunch continues it, so the
  // script is built from every browser run since this moment.
  const attemptPath = join(sessionDir, "attempt.json");
  // A repair re-records the whole flow, so it is a new attempt too: the script it produces must
  // not include the recording it replaces.
  if (!opts.resume || opts.repair) writeFileSync(attemptPath, `${JSON.stringify({ startedAt: Date.now() })}\n`, "utf8");
  const attemptStartedAt = readAttemptStart(attemptPath);

  const resumeCreds = rt.credentials.entries();
  const credsReminder =
    resumeCreds.length > 0
      ? `\n\n(Session variables in secret store: ${resumeCreds.map((c) => (c.description ? `${c.name} (${c.description})` : c.name)).join(", ")}. Reference them by exact KEY NAME, never type raw values.)`
      : "";

  const platformReminder = `\n\n(The browser is ${describePlatform()}. If what the operator said calls for a different platform, end your turn with AUTHORING: PLATFORM <profile name>. Configured profiles:\n${profileCatalogue(profiles)})`;

  /* A repair turn is told where the replay stopped and what the page showed. The page snapshot is
   * the replay's own view of the site, not the session's, so it can hold what the replay TYPED —
   * a phone number, an OTP. Every stored value is replaced by its key name before the model sees
   * it, the same rule as everywhere else: the model names a secret, it never learns one. */
  let repairPrompt = "";
  if (opts.repair) {
    if (!opts.resume) {
      fail("INPUT_INVALID", "`--repair` re-records a session's script, so it needs --resume <sessionId>", {
        context: { flag: "--repair" },
      });
    }
    const suiteDirForRepair = join(sessionDir, "suite");
    const evidence = readRepairEvidence(suiteDirForRepair);
    if (!evidence || evidence.stoppedEarly === 0) {
      fail(
        "INPUT_INVALID",
        "There is no replay that stopped before the final check to repair from. Replay the script first.",
        { context: { suiteDir: suiteDirForRepair } }
      );
    }
    repairPrompt = rt.credentials.names().reduce((text, name) => {
      const value = rt.credentials.revealSync(name);
      return value ? text.split(value).join(`<${name}>`) : text;
    }, buildRepairPrompt(evidence));
  }

  // What a resumed turn actually gets: a new MCP server, so a fresh page on the same profile.
  const resumeNote =
    "\n\n(The browser restarted for this turn: the page is fresh, the browser profile and any sign-in in it are kept, and the steps from your earlier turns are already part of the script. Navigate back and carry on from where the flow stands.)";

  const prompt = opts.resume
    ? (opts.repair ? repairPrompt : (opts.answer ?? "") + resumeNote) + credsReminder + platformReminder
    : buildPrompt({
        report,
        targetName: targetName!,
        baseUrl: target.baseUrl,
        allowedOrigins: rt.config.safety.allowedOrigins,
        credentialNames: rt.credentials.names(),
        credentialEntries: rt.credentials.entries(),
        approvedPlan,
        ...(opts.answer ? { planAmendments: opts.answer } : {}),
        platform: describePlatform(),
        platforms: profileCatalogue(profiles),
      });

  const argsFor = (resume?: string): string[] => claudeCliArgs({
    mcpConfigPath,
    strictMcpConfig: true,
    // Without this the session stops on its first navigation asking for permission, which is not
    // a question the operator can usefully answer -- they approve the SCRIPT, at a gate, after
    // watching it. The allowlist is where "what may this session do" is decided, once.
    allowedTools: ALLOWED_PLAYWRIGHT_TOOLS,
    appendSystemPrompt: brief,
    maxTurns: opts.maxTurns ?? 60,
    outputFormat: "stream-json",
    ...(resume ? { resume } : {}),
  });

  // The web server names this session's folder as `--workspace` and serves screenshots relative
  // to it. A hand run without the flag has no page watching, and keeps the workspace root.
  const workspaceDir = globals.workspace ? resolve(globals.workspace) : rt.workspace.root;
  let session = await runClaude(cli!, argsFor(opts.resume), prompt, rt, sessionDir, workspaceDir);
  let outcome = readAuthoringOutcome(session.finalMessage);

  /* A platform named after the browser is already open -- in a plan correction or an answer --
   * cannot be applied from inside the page. The session ends its turn asking for it; the harness
   * checks the name, relaunches the browser as that profile and resumes the same session. Bounded,
   * so a session that keeps asking ends instead of relaunching forever.
   *
   * A session the turn counter stopped part-way through is continued once, the same way. It had not
   * decided it was stuck: one real session signed in, found a control with no accessible name and
   * reached the outcome, then ran out re-recording the check -- and the only way on from there was
   * to start over from a new plan, throwing all of that away. */
  const maxRelaunches = 2;
  const maxTurnLimitContinuations = 1;
  const turnLimitNote =
    "You ran out of turns before finishing, so this turn continues the same session. The browser restarted: the page is fresh, the browser profile and any sign-in in it are kept, and every step you recorded is already part of the script. Carry on from where the flow stands. The moment the outcome is on screen, make browser_wait_for on its text your very next call, then finish." +
    credsReminder +
    platformReminder;
  let relaunches = 0;
  let continuations = 0;
  for (;;) {
    if (outcome.kind === "platform") {
      const requested = outcome.profile;
      if (relaunches >= maxRelaunches || !session.sessionId) {
        outcome = {
          kind: "stuck",
          reason: `The session asked to switch the browser to "${requested}" again after ${maxRelaunches} relaunches, or could not be resumed to do it.`,
        };
        break;
      }
      relaunches++;
      let note: string;
      if (!Object.prototype.hasOwnProperty.call(profiles, requested)) {
        note = `"${requested}" is not a configured browser platform, so nothing was relaunched. The browser is still ${describePlatform()}. Configured profiles:\n${profileCatalogue(profiles)}`;
      } else if (requested === platform.profile) {
        note = `The browser is already ${describePlatform()}. Carry on.`;
      } else {
        platform = { profile: requested, source: "session-request" };
        writePlatformFile(platformPath, platform);
        writeBrowserConfig(requested);
        process.stderr.write(`📱 Relaunching the browser as ${describePlatform()}\n`);
        note = `The browser has been relaunched as ${describePlatform()}. The page was reset but the browser profile, and any sign-in in it, was kept, and the steps from your earlier turns are already part of the script. Navigate again and carry on from where the flow stands.`;
      }
      session = await runClaude(cli!, argsFor(session.sessionId), note, rt, sessionDir, workspaceDir);
      outcome = readAuthoringOutcome(session.finalMessage);
      continue;
    }
    if (session.turnLimit && session.sessionId && continuations < maxTurnLimitContinuations) {
      continuations++;
      process.stderr.write(
        `⏭️ Out of turns part-way through — continuing the same session (${continuations} of ${maxTurnLimitContinuations})\n`
      );
      session = await runClaude(cli!, argsFor(session.sessionId), turnLimitNote, rt, sessionDir, workspaceDir);
      outcome = readAuthoringOutcome(session.finalMessage);
      continue;
    }
    break;
  }

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
      // The platform it was authored on, so the suite and the measured runs use the same browser.
      platform: { name: platform.profile, profile: profiles[platform.profile]! },
      attemptStartedAt,
      // Screens the session declared as appearing on some runs only; checked, never trusted.
      optionalScreens: readOptionalScreens(session.finalMessage),
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
      platform: { profile: platform.profile, description: describePlatform(), source: platform.source },
      ...(outcome.kind === "question" ? { question: outcome.question } : {}),
      ...(outcome.kind === "stuck" ? { reason: outcome.reason } : {}),
      // Stopped by the turn counter even after the automatic continuation; the page offers to keep going.
      ...(outcome.kind === "stuck" && session.turnLimit ? { turnLimit: true } : {}),
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
      "Run it many times to find out how often it fails — one pass proves nothing about a bug",
      "that only shows up sometimes:",
      "",
      `  investigate rerun --investigation ${investigationId} --repeat 30`,
      "",
      "That installs what the suite needs the first time, runs it, and reports the failure count."
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

export function formatToolUse(name: string, input: unknown): string {
  const tool = name.replace(/^mcp__playwright__/, "");
  const inp = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  switch (tool) {
    // Not browser actions: the session reading files MCP saved (a snapshot, a response body).
    // Labelled as what they are, so a log full of them reads as a session digging, not browsing.
    case "Read":
      return `📄 Reading saved file: ${String(inp.file_path ?? "").split(/[\\/]/).pop() || "file"}`;
    case "Grep":
      return `🔎 Searching saved files for: ${String(inp.pattern ?? "").slice(0, 60)}`;
    case "browser_navigate":
      return `🌐 Navigating to ${inp.url || inp.target || "URL"}`;
    case "browser_navigate_back":
      return `🔙 Navigating back`;
    case "browser_click":
      return `👆 Clicking: ${inp.element || inp.selector || inp.target || JSON.stringify(inp)}`;
    case "browser_type":
      return `⌨️ Typing text: ${inp.text !== undefined ? inp.text : inp.value || ""}`;
    case "browser_fill_form":
      return `📝 Filling form: ${inp.fields ? Object.keys(inp.fields as object).join(", ") : inp.element || JSON.stringify(inp)}`;
    case "browser_press_key":
      return `⌨️ Key press: ${inp.key ?? ""}`;
    case "browser_wait_for":
      return `⏳ Waiting for: ${inp.text || inp.selector || JSON.stringify(inp)}`;
    case "browser_find":
      return `🔍 Searching for element: ${inp.query || inp.text || inp.selector || JSON.stringify(inp)}`;
    case "browser_take_screenshot":
      return `📸 Capturing viewport screenshot...`;
    case "browser_snapshot":
      return `👁️ Inspecting page DOM snapshot`;
    case "browser_tabs":
      return `📑 Managing browser tabs (${inp.action || "list"})`;
    case "browser_resize":
      return `📐 Resizing viewport to ${inp.width}x${inp.height}`;
    case "browser_hover":
      return `👆 Hovering: ${inp.element || inp.selector || JSON.stringify(inp)}`;
    case "browser_select_option":
      return `📋 Selecting option: ${Array.isArray(inp.values) ? inp.values.join(", ") : JSON.stringify(inp)}`;
    default:
      return `🤖 Browser action: ${tool}`;
  }
}

/**
 * The line the web page turns into a live viewport frame.
 *
 * The path is relative to the folder passed as `--workspace`, because that is the folder the
 * server resolves `/api/session-image` against. It is not `rt.workspace.root`: that is the
 * `.investigator` directory inside it, and a path relative to that named a file the server could
 * never find, so every frame rendered as "Error rendering screenshot".
 */
export function screenshotLine(workspaceDir: string, imagePath: string): string {
  const rel = relative(workspaceDir, imagePath).replace(/\\/g, "/");
  return `[SCREENSHOT:/api/session-image?file=${encodeURIComponent(rel)}]`;
}

function mtimeOf(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

function scanForImages(dir: string, seen: Set<string>, skipDir?: string): string[] {
  if (!existsSync(dir)) return [];
  const found: string[] = [];
  function scan(curr: string) {
    try {
      for (const entry of readdirSync(curr, { withFileTypes: true })) {
        const fullPath = join(curr, entry.name);
        if (entry.isDirectory()) {
          if (fullPath !== skipDir) scan(fullPath);
        } else if (entry.isFile() && /\.(png|jpe?g|webp)$/i.test(entry.name)) {
          if (!seen.has(fullPath)) {
            seen.add(fullPath);
            found.push(fullPath);
          }
        }
      }
    } catch {
      // Ignore transient filesystem errors
    }
  }
  scan(dir);
  return found;
}

/** Run the CLI to completion and return its final message. */
function runClaude(
  cli: string,
  args: string[],
  prompt: string,
  rt: Runtime,
  sessionDir?: string,
  /** The folder screenshot paths are made relative to; see `screenshotLine`. */
  workspaceDir?: string
): Promise<{ sessionId: string | null; finalMessage: string; exitCode: number | null; turnLimit: boolean }> {
  return new Promise((resolvePromise) => {
    // `shell: false`, always. The prompt embeds a bug report written by someone else, and a shell
    // on Windows concatenates arguments rather than escaping them -- a report containing
    // `& del ...` would have run it. The prompt does not go in argv at all now; it is written to
    // stdin below.
    const child = spawn(cli, args, {
      cwd: sessionDir,
      env: claudeCliEnv(process.env),
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    });

    child.stdin.end(prompt, "utf8");

    let out = "";
    let sessionId: string | null = null;
    let finalMessage = "";
    const seenImages = new Set<string>();

    // The live frame is rewritten in place, so it is followed by mtime rather than by name.
    const liveDir = sessionDir ? join(sessionDir, LIVE_VIEW_DIR) : undefined;
    const liveFrame = sessionDir ? liveFramePath(sessionDir) : undefined;
    // A frame left by an earlier run shows a browser that no longer exists; wait for this run's.
    let liveFrameMtime = liveFrame ? mtimeOf(liveFrame) : 0;

    if (sessionDir) {
      scanForImages(sessionDir, seenImages, liveDir);
    }

    function emitNewImages() {
      if (!sessionDir || !workspaceDir) return;
      const newImgs = scanForImages(sessionDir, seenImages, liveDir);
      for (const imgPath of newImgs) {
        process.stderr.write(`${screenshotLine(workspaceDir, imgPath)}\n`);
      }
    }

    function emitLiveFrame() {
      if (!liveFrame || !workspaceDir) return;
      const mtime = mtimeOf(liveFrame);
      if (mtime === 0 || mtime === liveFrameMtime) return;
      liveFrameMtime = mtime;
      process.stderr.write(`${screenshotLine(workspaceDir, liveFrame)}\n`);
    }

    const imagePollTimer = sessionDir ? setInterval(emitNewImages, 1000) : null;
    const liveFrameTimer = liveFrame ? setInterval(emitLiveFrame, 500) : null;

    let stdoutBuf = "";
    let maxTurnsReached = false;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (d: string) => {
      out += d;
      stdoutBuf += d;
      const lines = stdoutBuf.split(/\r?\n/);
      stdoutBuf = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line) as {
            type?: string;
            subtype?: string;
            is_error?: boolean;
            attachment?: { type?: string };
            session_id?: string;
            result?: string;
            message?: { content?: Array<{ type: string; name?: string; input?: unknown; text?: string }> };
          };
          if (
            (parsed.type === "attachment" && parsed.attachment?.type === "max_turns_reached") ||
            parsed.subtype === "error_max_turns" ||
            (parsed.is_error && /maximum number of turns|max_turns/i.test(parsed.result || ""))
          ) {
            maxTurnsReached = true;
          }
          if (parsed.type === "result") {
            if (parsed.session_id) sessionId = parsed.session_id;
            if (parsed.result) finalMessage = parsed.result;
            continue;
          }
          if (parsed.session_id) sessionId = parsed.session_id;
          if (parsed.result) finalMessage = parsed.result;

          if (parsed.type === "assistant" && parsed.message?.content) {
            if (Array.isArray(parsed.message.content)) {
              for (const item of parsed.message.content) {
                if (item.type === "tool_use" && item.name) {
                  const formatted = formatToolUse(item.name, item.input);
                  process.stderr.write(`${formatted}\n`);
                  emitNewImages();
                } else if (item.type === "text" && item.text) {
                  finalMessage = item.text;
                }
              }
            }
          } else if (parsed.type === "user") {
            emitNewImages();
          }
        } catch {
          // Plain text line or incomplete JSON
        }
      }
    });

    // stderr carries the CLI's own internal progress/diagnostics
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (d: string) => rt.logger.debug("claude", { line: d.trimEnd() }));

    child.on("close", (exitCode) => {
      if (imagePollTimer) clearInterval(imagePollTimer);
      if (liveFrameTimer) clearInterval(liveFrameTimer);
      emitNewImages();

      if (stdoutBuf.trim()) {
        try {
          const parsed = JSON.parse(stdoutBuf.trim()) as { session_id?: string; result?: string };
          if (parsed.session_id) sessionId = parsed.session_id;
          if (parsed.result) finalMessage = parsed.result;
        } catch {
          // ignore
        }
      }

      if (!finalMessage) {
        try {
          const parsed = JSON.parse(out) as { session_id?: string; result?: string };
          sessionId = parsed.session_id ?? sessionId;
          finalMessage = parsed.result ?? out.trim();
        } catch {
          finalMessage = out.trim();
        }
      }

      // Stopped by the turn counter rather than by an ending of its own: the session did not decide
      // it was stuck, so the caller may continue it.
      const turnLimit = maxTurnsReached && !finalMessage.includes("AUTHORING:");
      if (turnLimit) {
        finalMessage = "AUTHORING: STUCK Authoring reached the maximum turn limit without completing.";
      }

      resolvePromise({ sessionId, finalMessage, exitCode, turnLimit });
    });
  });
}

/** Exported so a spec can run the session loop against a stand-in CLI. */
export const runClaudeForTest = runClaude;

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

export function buildPrompt(a: {
  report: string;
  targetName: string;
  baseUrl: string;
  allowedOrigins: readonly string[];
  credentialNames: readonly string[];
  credentialEntries?: readonly { name: string; description?: string }[];
  approvedPlan?: string;
  planAmendments?: string;
  /** The profile the browser was launched as, described. */
  platform?: string;
  /** Every configured profile, for a session that must ask for a different one. */
  platforms?: string;
}): string {
  const credLines: string[] = [];
  if (a.credentialEntries && a.credentialEntries.length > 0) {
    for (const entry of a.credentialEntries) {
      credLines.push(entry.description ? `- ${entry.name}: ${entry.description}` : `- ${entry.name}`);
    }
  } else if (a.credentialNames.length > 0) {
    for (const name of a.credentialNames) {
      credLines.push(`- ${name}`);
    }
  }

  const credentialsSection =
    credLines.length > 0
      ? [
          "## Session Credentials & Variables",
          "The following credentials and variables are configured for this session in the MCP secret store.",
          "IMPORTANT: You MUST reference them strictly by their exact KEY NAME (e.g. browser_type with text set to the key name like \"ACCOUNT_PHONE\").",
          "NEVER guess, ask for, or type raw values; the browser tool resolves them automatically from the secret store.",
          ...credLines,
        ].join("\n")
      : "No credentials were supplied. Ask if the flow needs one.";

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
    credentialsSection,
    ...(a.platform
      ? [
          "",
          "## Browser platform",
          "",
          `The browser was launched as ${a.platform}.`,
          "Do not resize it to imitate another platform. If the report, the plan correction or an answer calls for a different one, end your turn with AUTHORING: PLATFORM <profile name>. Configured profiles:",
          a.platforms ?? "",
        ]
      : []),
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
  profiles: Readonly<Record<string, EmulationProfile>>;
  defaultProfile: string;
  platformPath: string;
  /** What the operator said about the previous plan: an answer, a correction, or more detail. */
  answer?: string;
  /** The operator has nothing more to add; write the plan with the gaps marked. */
  thatsAll?: boolean;
}): Promise<AuthorResult> {
  // A planning turn with something new from the operator revises the plan it already wrote rather
  // than starting from the report alone, so nothing they were already told is lost.
  const previousPlan =
    (a.answer !== undefined || a.thatsAll === true) && existsSync(a.planPath)
      ? readFileSync(a.planPath, "utf8")
      : "";
  const credEntries = a.rt.credentials.entries();
  const credSummary =
    credEntries.length > 0
      ? `Credentials & variables available by name:\n${credEntries.map((e) => (e.description ? `- ${e.name}: ${e.description}` : `- ${e.name}`)).join("\n")}`
      : a.rt.credentials.names().length
      ? `Credentials available by name: ${a.rt.credentials.names().join(", ")}`
      : "No credentials were supplied.";

  const prompt = [
    "Write the plan for reproducing this reported bug. Do not reproduce it yet.",
    "",
    "You have NO browser tools on this turn. That is deliberate: the operator reads your plan",
    "before anything touches their application, and approves or corrects it first.",
    "",
    "Do not attempt to search or modify the codebase, and do not execute terminal commands.",
    "Output the numbered reproduction plan immediately, naming any gaps, and conclude with AUTHORING: PLAN.",
    "",
    "## The report, in the reporter's own words",
    "",
    a.report,
    "",
    "## Where",
    "",
    `Target: ${a.targetName} — ${a.baseUrl}`,
    "",
    credSummary,
    "",
    "## Browser platforms you can choose from",
    "",
    profileCatalogue(a.profiles),
    `Default, when nothing the operator said names a platform: ${a.defaultProfile}`,
    "",
    "Put PLATFORM: <profile name> on its own line directly above AUTHORING: PLAN.",
    ...planRevisionSection({ previousPlan, answer: a.answer, thatsAll: a.thatsAll === true }),
  ].join("\n");

  const args = claudeCliArgs({
    appendSystemPrompt: a.brief,
    strictMcpConfig: true,
    tools: "",
    maxTurns: 2,
    outputFormat: "json",
  });

  const session = await runClaude(a.cli, args, prompt, a.rt);
  const outcome = readAuthoringOutcome(session.finalMessage);

  /* A planning turn may legitimately end on QUESTION rather than PLAN, and the first real one did:
   * it wrote seven steps, then asked which account to sign in as and what password to type. Both
   * endings are the same thing here -- a plan, with the gaps named -- so the plan is the body above
   * whichever sentinel was used, and a question is carried alongside rather than replacing it.
   * Keeping the sentinel line out of the plan matters: it is shown to the operator verbatim. */
  const plan = stripPlatformLine(stripSentinel(session.finalMessage));
  // After "That's all I know" there is nobody left to ask. A question is dropped rather than put
  // back to the operator; the gap it named stays in the plan for the browser session to meet.
  const question = outcome.kind === "question" && a.thatsAll !== true ? outcome.question : "";
  const ok = outcome.kind === "plan" || outcome.kind === "question";

  // The model proposes a profile name; config decides whether it exists. The operator sees the
  // result on the plan card before any browser opens.
  const named = readPlatformLine(session.finalMessage);
  const known = named !== null && Object.prototype.hasOwnProperty.call(a.profiles, named);
  const platform: PlatformChoice = known
    ? { profile: named, source: "plan" }
    : { profile: a.defaultProfile, source: "default" };
  const platformNote =
    named !== null && !known
      ? `The plan named "${named}", which is not a configured platform, so the default is used.`
      : undefined;
  const platformDescription = describeProfile(platform.profile, a.profiles[platform.profile]!);
  if (ok) {
    archivePlan(a.planPath);
    writeFileSync(a.planPath, plan, "utf8");
    writePlatformFile(a.platformPath, platform);
  }
  const planVersion = ok ? planVersionOf(a.planPath) : null;
  const planChecksum = ok ? sha256Prefixed(plan) : null;

  return {
    json: {
      ok,
      investigationId: a.investigationId,
      target: a.targetName,
      outcome: ok ? "plan" : outcome.kind === "stuck" ? "stuck" : "error",
      plan: ok ? plan : "",
      platform: {
        profile: platform.profile,
        description: platformDescription,
        source: platform.source,
        ...(platformNote ? { note: platformNote } : {}),
      },
      ...(question ? { question } : {}),
      ...(planVersion !== null ? { planVersion, planChecksum } : {}),
      sessionId: session.sessionId,
      suite: null,
      message: session.finalMessage,
    },
    human: () =>
      ok
        ? [
            "The plan, before anything opens a browser:",
            "",
            plan,
            "",
            `Browser: ${platformDescription}`,
            ...(platformNote ? [platformNote] : []),
            ...(question ? ["", `It needs to know: ${question}`] : []),
            "",
            `Approve it with:  investigate author --investigation ${a.investigationId} --approve-plan --plan-checksum ${planChecksum}`,
            `Answer or change: the same command plus --answer "<your answer>"`,
            `Revise the plan:  investigate author --investigation ${a.investigationId} --answer "<more detail>"   (add --thats-all when you have nothing more)`,
          ].join("\n")
        : renderHuman(outcome, session, null, a.investigationId),
  };
}

/**
 * What a revising planning turn is told on top of the report: the plan it wrote last time and
 * what the operator added. Empty when there is nothing to revise, so a first planning turn reads
 * exactly as it always has.
 */
export function planRevisionSection(a: {
  previousPlan: string;
  answer?: string | undefined;
  thatsAll: boolean;
}): string[] {
  const lines: string[] = [];
  if (a.previousPlan) {
    lines.push("", "## The plan you wrote last time", "", a.previousPlan);
  }
  if (a.answer) {
    lines.push(
      "",
      "## What the operator added",
      "",
      a.answer,
      "",
      "Revise the plan with this. Use what they supplied as given; do not ask again about anything it answers."
    );
  }
  if (a.thatsAll) {
    lines.push(
      "",
      "## The operator has nothing more to add",
      "",
      "Do not ask anything. Write the complete plan now, mark every value still missing as ??? with what",
      "it is for, and end with AUTHORING: PLAN. The browser session will work out what the page can show it."
    );
  } else {
    lines.push(
      "",
      "If something only the operator can know is still missing, you may end with AUTHORING: QUESTION",
      "instead. Ask at most three things at once, the one that matters most first, and never anything",
      "the page itself would show."
    );
  }
  return lines;
}

/**
 * Keep the plan about to be replaced as `plan.v<N>.md`, so every version the operator was shown
 * stays on disk and the current one is always `plan.md`.
 */
function archivePlan(planPath: string): void {
  if (!existsSync(planPath)) return;
  const version = planVersionOf(planPath);
  writeFileSync(planPath.replace(/plan\.md$/, `plan.v${version}.md`), readFileSync(planPath));
}

/** The version number of the current `plan.md`: one more than the versions archived beside it. */
export function planVersionOf(planPath: string): number {
  const dir = dirname(planPath);
  if (!existsSync(dir)) return 1;
  return readdirSync(dir).filter((f) => /^plan\.v\d+\.md$/.test(f)).length + 1;
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
  platform: { name: string; profile: EmulationProfile };
  attemptStartedAt: number;
  optionalScreens: readonly OptionalScreen[];
}): {
  dir: string;
  steps: number;
  proposalPath?: string;
  proposalRefusal?: string;
  optionalScreens?: string[];
  optionalRefused?: string[];
} {
  // Every browser run of this attempt, in the order they ran (see attemptSessionMarkdowns).
  const steps = attemptSessionMarkdowns(a.outputDir, a.attemptStartedAt).flatMap((path) =>
    extractAuthoredSteps(readFileSync(path, "utf8"))
  );

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
      optional: a.optionalScreens,
    }),
    "utf8"
  );
  writeFileSync(
    join(suiteDir, "playwright.config.ts"),
    renderPlaywrightConfig({
      outputDir: "./artifacts",
      contextOptions: browserContextOptions(a.platform.profile),
      steps: steps.length,
    }),
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

  const optionalPlan = planOptionalBlocks(steps, a.optionalScreens);
  /* The measured runner's action vocabulary has no "only if this screen shows". Turning a script
   * with optional screens into a proposal would silently make those steps mandatory again — the
   * exact failure the declaration exists to prevent — so it is measured through the suite instead,
   * and the refusal says why. */
  const { proposalPath, proposalRefusal }: { proposalPath?: string; proposalRefusal?: string } =
    optionalPlan.blocks.length > 0
      ? {
          proposalRefusal: `the script has ${optionalPlan.blocks.length} screen(s) that appear on some runs only, which the measured runner's actions cannot express, so it is run as a suite`,
        }
      : emitProposal({ ...a, steps, suiteDir });
  return {
    dir: suiteDir,
    steps: steps.length,
    ...(proposalPath ? { proposalPath } : {}),
    ...(proposalRefusal ? { proposalRefusal } : {}),
    ...(optionalPlan.blocks.length ? { optionalScreens: optionalPlan.blocks.map((b) => b.trigger) } : {}),
    ...(optionalPlan.refused.length ? { optionalRefused: optionalPlan.refused } : {}),
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
  platform: { name: string; profile: EmulationProfile };
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
    emulationProfile: a.platform.name,
  });
  if (!built.ok) return { proposalRefusal: built.reason };

  const proposalPath = join(a.sessionDir, "experiment-proposal.json");
  writeFileSync(proposalPath, `${JSON.stringify(built.proposal, null, 2)}\n`, "utf8");
  return { proposalPath };
}

/**
 * The session logs of one authoring attempt, oldest first.
 *
 * MCP writes `session-<epoch ms>/session.md` each time its server starts, and every
 * `claude --resume` starts a new server. This used to return whichever folder `readdir` listed
 * first: in a real run that was the sign-in, while the run that reached the flow sat in the second
 * folder, so even a DONE would have been scripted from the wrong steps. Logs from before this
 * attempt began (an earlier "Try again") are left out.
 */
export function attemptSessionMarkdowns(outputDir: string, sinceMs: number): string[] {
  if (!existsSync(outputDir)) return [];
  return readdirSync(outputDir)
    .map((entry) => ({ entry, startedAt: Number(/^session-(\d+)$/.exec(entry)?.[1]) }))
    .filter(
      (s) =>
        Number.isFinite(s.startedAt) &&
        s.startedAt >= sinceMs &&
        existsSync(join(outputDir, s.entry, "session.md"))
    )
    .sort((a, b) => a.startedAt - b.startedAt)
    .map((s) => join(outputDir, s.entry, "session.md"));
}

/**
 * When the current attempt began, or 0 when that was never recorded (a session authored before
 * attempts were), in which case every log in the folder counts, as it did then.
 */
function readAttemptStart(path: string): number {
  try {
    const startedAt = (JSON.parse(readFileSync(path, "utf8")) as { startedAt?: unknown }).startedAt;
    return typeof startedAt === "number" && Number.isFinite(startedAt) ? startedAt : 0;
  } catch {
    return 0;
  }
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
