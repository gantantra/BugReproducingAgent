#!/usr/bin/env node
import { Command, Option } from "commander";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { EXIT, GOVERNING_PRINCIPLE, InvestigatorError, Logger, fail } from "@investigator/core";
import { initWorkspace, workspacePaths } from "@investigator/storage";
import {
  emit,
  openRuntime,
  reportAndExit,
  seedDefaultPolicy,
  type GlobalOptions,
} from "./runtime.js";
import { runCommand } from "./commands/run.js";
import { doctorCommand } from "./commands/doctor.js";
import { intakeCommand } from "./commands/intake.js";
import { planCommand } from "./commands/plan.js";
import { approveCommand } from "./commands/approve.js";
import { suiteGenerateCommand } from "./commands/suite.js";
import { lineageCommand, showCommand, statusCommand } from "./commands/inspect.js";
import { retentionApplyCommand } from "./commands/retention.js";
import { analyzeCommand } from "./commands/analyze.js";
import { authorCommand } from "./commands/author.js";
import { rerunCommand } from "./commands/rerun.js";
import { loadEnvFile } from "./env-file.js";
import { loadDeepSeekCredentials } from "./deepseek-credentials.js";

/**
 * `investigate` CLI.
 *
 * Thin by design: parse, load config, dispatch to a use-case function in a package, format
 * output. No business logic here.
 *
 * M1 implements `init`, `run`, and `doctor`. Every other command in the frozen contract is
 * registered and exits 1 with "not implemented in M1" rather than silently doing nothing, so
 * the contract is discoverable from `--help` today.
 */

const NOT_IMPLEMENTED: Record<string, string> = {
  classify: "M4",
  "frequency run": "M5",
  minimize: "M6",
  revalidate: "M6",
  report: "M7",
  export: "M7",
};

function globalsFrom(cmd: Command): GlobalOptions {
  const o = cmd.optsWithGlobals<Record<string, unknown>>();
  const g: GlobalOptions = {};
  if (typeof o["workspace"] === "string") g.workspace = o["workspace"];
  if (typeof o["investigation"] === "string") g.investigation = o["investigation"];
  if (o["json"] === true) g.json = true;
  if (o["verbose"] === true) g.verbose = true;
  if (o["allowUnsafeDebug"] === true) g.allowUnsafeDebug = true;
  if (o["seed"] !== undefined) g.seed = Number(o["seed"]);
  return g;
}

function notImplemented(name: string): never {
  throw new InvestigatorError(
    "NOT_IMPLEMENTED",
    `\`investigate ${name}\` is part of the frozen command contract but is not implemented yet. Arrives in ${NOT_IMPLEMENTED[name] ?? "a later milestone"}. See docs/milestones/.`,
    { context: { command: name, milestone: NOT_IMPLEMENTED[name] ?? null } }
  );
}

function version(): string {
  for (const candidate of [
    join(__dirname, "..", "package.json"),
    join(__dirname, "..", "..", "package.json"),
  ]) {
    try {
      return (
        (JSON.parse(readFileSync(candidate, "utf8")) as { version?: string }).version ?? "0.0.0"
      );
    } catch {
      /* try the next candidate */
    }
  }
  return "0.0.0";
}

// Before any command reads configuration. The real environment always wins over either file, and
// `REPROAGENT_NO_ENV_FILE=1` disables both outright — see `env-file.ts` for why both matter.
//
// `.env` first: a variable it sets is then already present, so `deepseek.json` leaves it alone.
// That ordering makes the repo's own file the more specific one, which is the useful way round.
loadEnvFile();
loadDeepSeekCredentials();

const program = new Command();

/**
 * One sentence per line. Commander re-wraps a description at the help width, which split
 * "Humans authorize consequential transitions." mid-sentence and left the governing principle
 * unquotable from the CLI's own help. Each sentence is comfortably under the 80-column default,
 * so this renders the principle intact at any terminal width. The constant itself is untouched:
 * `GOVERNING_PRINCIPLE` remains the single verbatim source.
 */
const PRINCIPLE_LINES = GOVERNING_PRINCIPLE.split(/(?<=\.)\s+/).join("\n");

program
  .name("investigate")
  .description(
    `Local CLI agent that investigates intermittent Chrome-based web issues.\n\n${PRINCIPLE_LINES}`
  )
  .version(version(), "-V, --version")
  .option("--workspace <dir>", "workspace root (defaults to the nearest .investigator upward)")
  .option("--investigation <id>", "target investigation")
  .option("--json", "emit machine-readable JSON on stdout; human text goes to stderr")
  .option("--verbose", "increase log detail (never increases secret or evidence exposure)")
  .option("--seed <int>", "override the deterministic base seed")
  .option("--no-color", "disable ANSI colour")
  .addOption(
    new Option(
      "--allow-unsafe-debug",
      "proceed despite Playwright protocol logging; marks the session and its manifests unsafe"
    ).hideHelp(false)
  )
  // There is deliberately no --yes, --force-approve, or --auto. Approvals cannot be granted
  // from the command line (ADR-0013).
  .showHelpAfterError();

program
  .command("init")
  .description("create a workspace: database, config.yaml, prompts/, investigations/")
  .option("--force-migrate", "apply migrations even if the schema version is current")
  .action(async function (this: Command) {
    const g = globalsFrom(this);
    const logger = new Logger({ json: g.json === true });
    try {
      const root = g.workspace
        ? join(g.workspace, ".investigator")
        : join(process.cwd(), ".investigator");
      const result = initWorkspace(root);
      const policySeeded = seedDefaultPolicy(result.workspace);

      // Migrate immediately so a fresh workspace is usable, and so re-running validates.
      const { SqliteMetadataStore } = await import("@investigator/storage");
      const store = new SqliteMetadataStore({ path: result.workspace.dbPath });
      await store.migrate();
      const schemaVersion = await store.schemaVersion();
      await store.close();

      emit(
        {
          ok: true,
          workspace: result.workspace.root,
          created: result.created,
          configWritten: result.configWritten,
          policySeeded,
          schemaVersion,
        },
        g.json === true,
        () =>
          [
            `Workspace ready at ${result.workspace.root}`,
            `  config.yaml   ${result.configWritten ? "created" : "kept (not overwritten)"}`,
            `  policy        ${policySeeded ? "seeded policies/default.yaml" : "already present"}`,
            `  database      migrated to schema version ${schemaVersion}`,
            "",
            "Next: edit config.yaml to add a target and its origin to safety.allowedOrigins.",
          ].join("\n")
      );
    } catch (e) {
      reportAndExit(e, logger, g.json === true);
    }
  });

program
  .command("run")
  .description("execute approved experiments deterministically (no provider calls)")
  .option("--experiment <id...>", "limit to specific experiment ids")
  .option("--repeat <n>", "repetitions to enqueue", (v) => Number.parseInt(v, 10))
  .option("--max-parallel <n>", "override maxParallelRuns", (v) => Number.parseInt(v, 10))
  .option("--stop-after-failures <n>", "stop the batch after n product failures", (v) =>
    Number.parseInt(v, 10)
  )
  .option(
    "--fixture-app <kind>",
    "start a local fixture application for this run and allowlist its origin. Supplies a " +
      "TARGET only; what runs is still only what gate 1 approved. One of: passing, " +
      "product-failing-deterministic, product-failing-intermittent, automation-failing, " +
      "infrastructure-failing, straddling-requests, sensitive."
  )
  .option("--target <name>", "target name for the fixture experiment")
  .action(async function (this: Command) {
    const g = globalsFrom(this);
    const logger = new Logger({ json: g.json === true, level: g.verbose ? "debug" : "info" });
    let rt;
    try {
      rt = await openRuntime(g);
      const result = await runCommand(rt, this.opts(), g);
      emit(result.json, g.json === true, result.human);
      // A captured product failure is a successful investigation step, not a CLI error.
      process.exit(EXIT.OK);
    } catch (e) {
      reportAndExit(e, logger, g.json === true);
    } finally {
      await rt?.close();
    }
  });

program
  .command("doctor")
  .description("report workspace, config, queue, integrity, and safety state")
  .option("--verify-lineage", "walk the lineage hash chain and report the first break")
  .action(async function (this: Command) {
    const g = globalsFrom(this);
    const logger = new Logger({ json: g.json === true });
    let rt;
    try {
      rt = await openRuntime(g);
      const result = await doctorCommand(rt, this.opts());
      emit(result.json, g.json === true, result.human);
    } catch (e) {
      reportAndExit(e, logger, g.json === true);
    } finally {
      await rt?.close();
    }
  });

// ---------------------------------------------------------------------------
// Read-only inspection. All answer offline: no browser, no provider.
// ---------------------------------------------------------------------------

program
  .command("status")
  .description("gate states, run outcomes, queue and lineage health for an investigation")
  .action(async function (this: Command) {
    await dispatch(this, (rt, g) => statusCommand(rt, g));
  });

program
  .command("show")
  .argument("<what>", "a gate name, or an artifact id")
  .description("print a rendered proposal or the contents of an artifact")
  .action(async function (this: Command, what: string) {
    await dispatch(this, (rt, g) => showCommand(rt, what, g));
  });

program
  .command("lineage")
  .argument("<nodeId>", "run, job, experiment, approval or artifact id")
  .description("ancestor and descendant closure for a node, with the actor on every hop")
  .action(async function (this: Command, nodeId: string) {
    await dispatch(this, (rt, g) => lineageCommand(rt, nodeId, g));
  });

const retention = program.command("retention").description("artifact retention");
retention
  .command("apply")
  .description("tombstone artifacts past their retention age (dry run without --confirm)")
  .option("--confirm", "actually delete; without this the command only reports")
  .option("--older-than-days <n>", "override storage.retention.artifactDays", (v) =>
    Number.parseInt(v, 10)
  )
  .action(async function (this: Command) {
    await dispatch(this, (rt, g) => retentionApplyCommand(rt, this.opts(), g));
  });

// ---------------------------------------------------------------------------
// Frozen contract commands that arrive in later milestones. Registered so the
// contract is discoverable, and failing loudly rather than doing nothing.
// ---------------------------------------------------------------------------

program
  .command("intake")
  .description("open an investigation from a human's report file (--ai interprets it into a Flow)")
  .requiredOption("--from <file>", "report file")
  .option("--title <text>", "override the title")
  .option("--env <name>", "target name")
  .option("--ai", "also interpret the report into a structured Flow with intake_to_flow")
  .option("--replay <dir>", "replay recorded provider responses instead of calling one")
  .action(async function (this: Command) {
    await dispatch(this, (rt, g) => intakeCommand(rt, this.opts(), g));
  });

program
  .command("author")
  .description(
    "write the plan for reproducing the bug; with --approve-plan, drive a real browser with your " +
      "own claude login until it reproduces, then emit the script"
  )
  .option("--env <name>", "target name")
  .option("--headed", "show the browser instead of running it headless")
  .option("--max-turns <n>", "ceiling on agent turns", (v) => Number.parseInt(v, 10))
  .option("--approve-plan", "accept the written plan and open the browser")
  .option("--resume <sessionId>", "resume a session that paused on a question")
  .option("--answer <text>", "the answer to the question, or a correction to the plan")
  .option("--repair", "with --resume: re-record the script from where its last replay stopped")
  .option("--thats-all", "planning: the operator has nothing more to add; write the plan with gaps marked")
  .option("--plan-checksum <sha256>", "with --approve-plan: the checksum of the plan that was read; refused if it changed")
  .action(async function (this: Command) {
    await dispatch(this, (rt, g) => authorCommand(rt, this.opts(), g));
  });

program
  .command("rerun")
  .description(
    "run the authored Playwright suite N times and report how often it failed (the operator's own script, not the measured executor)"
  )
  .requiredOption("--repeat <n>", "how many times to run it", (v) => Number.parseInt(v, 10))
  .action(async function (this: Command) {
    await dispatch(this, (rt, g) => rerunCommand(rt, this.opts(), g));
  });

program
  .command("plan")
  .description("render the gate 1 proposal a human decides on (--ai drafts it with DeepSeek)")
  .option("--from <file>", "proposal input file")
  .option("--gate <gate>", "gate to render for", "experiment_selection")
  .option("--ai", "generate the proposal with propose_experiments instead of reading a file")
  .option("--replay <dir>", "replay recorded provider responses instead of calling one")
  .action(async function (this: Command) {
    await dispatch(this, (rt, g) => planCommand(rt, this.opts(), g));
  });

program
  .command("analyze")
  .description(
    "read the runs already measured and report what separates the failures (--ai interprets them)"
  )
  .option("--ai", "add a DeepSeek reading: findings, root-cause hypotheses, reproduction steps")
  .option("--replay <dir>", "replay recorded provider responses instead of calling one")
  .action(async function (this: Command) {
    const g = globalsFrom(this);
    const logger = new Logger({ json: g.json === true });
    let rt;
    try {
      rt = await openRuntime(g);
      const result = await analyzeCommand(rt, this.opts(), g);
      emit(result.json, g.json === true, result.human);
    } catch (e) {
      reportAndExit(e, logger, g.json === true);
    } finally {
      await rt?.close?.();
    }
  });

program
  .command("approve")
  .argument("<gate>", "experiment_selection | target_failure | final_reproduction")
  .description("record a checksum-bound human approval")
  .option("--from <file>", "approval file")
  .option("--checksum <sha256>", "sha256 of the proposal being approved")
  .option("--scaffold", "write a pre-filled, schema-valid approval file (approves nothing)")
  .option("--approver <name>", "name recorded in the scaffold")
  .action(async function (this: Command, gate: string) {
    await dispatch(this, (rt, g) => approveCommand(rt, gate, this.opts(), g));
  });

program
  .command("classify")
  .description("cluster runs and render the gate 2 proposal [M4]")
  .option("--runs <id...>", "limit to specific runs")
  .option("--refresh", "recompute")
  .action(function (this: Command) {
    runStub("classify", this);
  });

const suite = program.command("suite").description("deterministic suite emission");
suite
  .command("generate")
  .description("emit a standalone Playwright suite for approved experiments")
  .option("--out <dir>", "output directory")
  .option("--experiment <id...>", "limit to specific experiments")
  .action(async function (this: Command) {
    await dispatch(this, (rt, g) => suiteGenerateCommand(rt, this.opts(), g));
  });

const frequency = program.command("frequency").description("frequency measurement");
frequency
  .command("run")
  .description("execute the approved sequence N times and compute statistics [M5]")
  .requiredOption("--repeat <n>", "repetitions")
  .option("--experiment <id>", "experiment id")
  .option("--stop-on-confidence <p>", "stop once the interval is tight enough")
  .action(function (this: Command) {
    runStub("frequency run", this);
  });

program
  .command("minimize")
  .description("propose and measure reductions, then render the gate 3 proposal [M6]")
  .option("--max-rounds <n>", "rounds")
  .option("--repeat-per-candidate <n>", "runs per candidate")
  .option("--retention-threshold <p>", "retention threshold")
  .action(function (this: Command) {
    runStub("minimize", this);
  });

program
  .command("revalidate")
  .description("re-execute the reproduction and its control, and re-verify integrity [M6]")
  .option("--repeat <n>", "repetitions")
  .option("--include-control", "also run the passing control")
  .action(function (this: Command) {
    runStub("revalidate", this);
  });

program
  .command("report")
  .description("render the Jira-ready report [M7]")
  .option("--out <file>", "output file")
  .option("--format <fmt>", "markdown | json", "markdown")
  .action(function (this: Command) {
    runStub("report", this);
  });

program
  .command("export")
  .description("package reproducer, report, manifests, and artifacts [M7]")
  .option("--out <file.zip>", "output bundle")
  .option("--include-artifacts <kinds>", "artifact kinds to include")
  .option("--verify-only", "re-run redaction and integrity verification without writing")
  .action(function (this: Command) {
    runStub("export", this);
  });

/**
 * Open the runtime, run a command, emit its result, and always close. Every implemented command
 * goes through here so that error reporting, JSON mode, and cleanup cannot drift apart.
 */
async function dispatch(
  cmd: Command,
  run: (
    rt: Awaited<ReturnType<typeof openRuntime>>,
    g: GlobalOptions
  ) => Promise<{ json: unknown; human: () => string }>
): Promise<void> {
  const g = globalsFrom(cmd);
  const logger = new Logger({ json: g.json === true, level: g.verbose ? "debug" : "info" });
  let rt;
  try {
    rt = await openRuntime(g);
    const result = await run(rt, g);
    emit(result.json, g.json === true, result.human);
  } catch (e) {
    reportAndExit(e, logger, g.json === true);
  } finally {
    await rt?.close();
  }
}

function runStub(name: string, cmd: Command): void {
  const g = globalsFrom(cmd);
  const logger = new Logger({ json: g.json === true });
  try {
    notImplemented(name);
  } catch (e) {
    reportAndExit(e, logger, g.json === true);
  }
}

async function main(): Promise<void> {
  try {
    await program.parseAsync(process.argv);
  } catch (e) {
    reportAndExit(e, new Logger({}), false);
  }
}

void main();

export { program, workspacePaths, fail };
