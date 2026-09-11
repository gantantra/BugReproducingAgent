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
  intake: "M2",
  plan: "M3",
  approve: "M2",
  classify: "M4",
  "suite generate": "M2",
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
    `\`investigate ${name}\` is specified but not implemented in M1. Arrives in ${NOT_IMPLEMENTED[name] ?? "a later milestone"}. See docs/milestones/.`,
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
    "--fixture-experiment <file>",
    "[M1 ONLY] run a fixture experiment file directly. M2 removes this flag and requires gate 1."
  )
  .option(
    "--fixture-app <kind>",
    "[M1 ONLY] start a local fixture application for this run and allowlist its origin. " +
      "One of: passing, product-failing-deterministic, product-failing-intermittent, " +
      "automation-failing, infrastructure-failing, straddling-requests, sensitive."
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
// Frozen contract commands that arrive in later milestones. Registered so the
// contract is discoverable, and failing loudly rather than doing nothing.
// ---------------------------------------------------------------------------

program
  .command("intake")
  .description("register an investigation from a report file [M2]")
  .requiredOption("--from <file>", "report file")
  .option("--title <text>", "override the title")
  .option("--env <name>", "target name")
  .action(function (this: Command) {
    runStub("intake", this);
  });

program
  .command("plan")
  .description("propose ranked experiments and render the gate 1 proposal [M3]")
  .option("--max-proposals <n>", "cap the number of proposals")
  .option("--refresh", "re-run planning")
  .action(function (this: Command) {
    runStub("plan", this);
  });

program
  .command("approve")
  .argument("<gate>", "experiment_selection | target_failure | final_reproduction")
  .description("record a checksum-bound human approval [M2]")
  .option("--from <file>", "approval file")
  .option("--checksum <sha256>", "sha256 of the proposal being approved")
  .option("--scaffold", "write a pre-filled, schema-valid approval file (approves nothing)")
  .action(function (this: Command) {
    runStub("approve", this);
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
  .description("emit a standalone Playwright suite for approved experiments [M2]")
  .option("--out <dir>", "output directory")
  .option("--experiment <id...>", "limit to specific experiments")
  .action(function (this: Command) {
    runStub("suite generate", this);
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
