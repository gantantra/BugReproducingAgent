import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { ACTIONS, type BuildContext } from "../../apps/web/src/actions.js";

/**
 * The web UI's allowlist, checked against the CLI's actual parser.
 *
 * Reading the source was not enough twice over: the allowlist first invented an `inspect` command
 * the CLI does not have, then passed `--gate` for an argument `approve` takes positionally. Both
 * built clean, type-checked clean, and failed only when a real command ran. So this spawns the
 * built binary for every action and asserts the parser accepted the SHAPE.
 *
 * It deliberately does not assert success. Most actions here fail on a precondition — no approval,
 * no runs yet, a milestone that is not built — and that is the correct answer. What must never
 * appear is the parser rejecting the arguments themselves.
 */

const CLI = join(process.cwd(), "apps", "cli", "dist", "bin.js");

/** A parser rejection, as opposed to the command running and reporting a domain error. */
const PARSER_REJECTION =
  /unknown command|unknown option|error: missing required|too many arguments/i;

/** Plausible values for every parameter any action reads. */
const PARAMS: Record<string, unknown> = {
  investigation: "INV-001",
  gate: "experiment_selection",
  checksum: "a".repeat(64),
  from: "reports/report.md",
  out: "suite",
  repeat: 1,
  what: "experiment_selection",
  nodeId: "FLOW-001",
  approver: "tester",
  title: "A title",
  ai: false,
};

let dir: string;

const run = promisify(execFile);

/**
 * Asynchronous on purpose. `execFileSync` blocks the worker's event loop, and with this many
 * spawns vitest's reporter RPC times out and raises an unhandled error beside a passing run --
 * which turned the suite red intermittently.
 */
async function invoke(args: string[]): Promise<{ status: number; output: string }> {
  try {
    const { stdout } = await run(process.execPath, [CLI, ...args, "--workspace", dir, "--json"], {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, REPROAGENT_NO_ENV_FILE: "1" },
    });
    return { status: 0, output: stdout };
  } catch (e) {
    const err = e as { code?: number; stdout?: string; stderr?: string };
    return { status: err.code ?? -1, output: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "investigator-web-"));
  execFileSync(process.execPath, [CLI, "init", "--workspace", dir], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, REPROAGENT_NO_ENV_FILE: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
}, 120_000);

afterAll(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* a locked sqlite handle on Windows must not fail the suite */
  }
});

describe("every web action produces argv the CLI parser accepts", () => {
  const ctx: BuildContext = { inWorkspace: (rel) => resolve(dir, rel) };

  it.each(ACTIONS.map((a) => a.id))("%s", async (id) => {
    const action = ACTIONS.find((a) => a.id === id);
    expect(action, `no action ${id}`).toBeDefined();

    const argv = action!.build(PARAMS, ctx);
    const { output } = await invoke(argv);
    const rejection = PARSER_REJECTION.exec(output);

    expect(
      rejection?.[0],
      `\`investigate ${argv.join(" ")}\` was rejected by the parser: ${rejection?.[0] ?? ""}`
    ).toBeUndefined();
  });
});

describe("the UI cannot walk past a gate", () => {
  const ctx: BuildContext = { inWorkspace: (rel) => resolve(dir, rel) };

  it("refuses to run experiments that were never approved", async () => {
    const runAction = ACTIONS.find((a) => a.id === "run");
    const { output } = await invoke(runAction!.build(PARAMS, ctx));
    // The point is not the exact code but that an unapproved batch does not execute.
    expect(output).not.toMatch(PARSER_REJECTION);
    expect(output.toLowerCase()).toMatch(/gate|approv/);
  });

  // One case per command rather than a loop in a single test: `execFileSync` blocks the worker's
  // event loop, and five of them in one test starves vitest's reporter RPC and raises an
  // unhandled timeout alongside a passing run.
  it.each(["classify", "minimize", "revalidate", "report", "export"])(
    "%s reports NOT_IMPLEMENTED rather than hiding the step",
    async (id) => {
      const action = ACTIONS.find((a) => a.id === id);
      const { output } = await invoke(action!.build(PARAMS, ctx));
      expect(output, `${id} should report NOT_IMPLEMENTED`).toContain("NOT_IMPLEMENTED");
    }
  );
});
