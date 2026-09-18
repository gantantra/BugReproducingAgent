import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";

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
  checksum: `sha256:${"a".repeat(64)}`,
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

describe("the planner's author calls reach the parser intact", () => {
  const ctx: BuildContext = { inWorkspace: (rel) => resolve(dir, rel) };
  const author = () => ACTIONS.find((a) => a.id === "author")!;

  it.each([
    ["a plan revision", { investigation: "INV-001", answer: "use the QA account" }],
    ["That's all I know", { investigation: "INV-001", thatsAll: true, answer: "Android" }],
    [
      "an approval bound to the plan checksum",
      { investigation: "INV-001", approvePlan: true, planChecksum: `sha256:${"a".repeat(64)}` },
    ],
  ])("%s", async (_label, params) => {
    const argv = author().build(params as Record<string, unknown>, ctx);
    const { output } = await invoke(argv);
    expect(PARSER_REJECTION.exec(output)?.[0]).toBeUndefined();
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

/**
 * The whole approval path, driven the way the page drives it, asserting SUCCESS.
 *
 * The suite above deliberately does not assert success: most actions fail on a precondition and
 * that is the right answer. But `approve` was passed a dummy checksum, so it failed on the
 * checksum and that looked like an acceptable domain error — which is exactly how a real defect
 * hid here. The allowlist accepted only bare hex while `checksumOfBytes` returns `sha256:<hex>`,
 * so the page stripped the prefix and every one-click approval died with GATE_CHECKSUM_MISMATCH.
 * Shape was verified; the VALUE never was.
 *
 * So this one runs plan, reads the checksum the CLI itself printed, feeds it back through the
 * allowlist exactly as the page does, and requires exit 0.
 */
describe("the page can actually approve a gate", () => {
  const ctx: BuildContext = { inWorkspace: (rel) => resolve(dir, rel) };
  const build = (id: string, params: Record<string, unknown>): string[] => {
    const action = ACTIONS.find((a) => a.id === id);
    if (!action) throw new Error(`no action ${id}`);
    return action.build(params, ctx);
  };

  it("plans, scaffolds and approves, using the checksum the CLI printed", async () => {
    const intake = join(process.cwd(), "docs", "examples", "intake", "blank-results.md");
    const proposal = join(process.cwd(), "docs", "examples", "proposals", "gate-1.input.json");

    const intaken = await invoke(["intake", "--from", intake]);
    expect(intaken.status, intaken.output).toBe(0);
    const investigation = (JSON.parse(intaken.output) as { investigationId: string })
      .investigationId;

    const planned = await invoke([
      "plan",
      "--investigation",
      investigation,
      "--from",
      proposal,
      "--gate",
      "experiment_selection",
    ]);
    expect(planned.status, planned.output).toBe(0);
    const checksum = (JSON.parse(planned.output) as { proposalChecksum: string }).proposalChecksum;

    // The form the CLI prints. If this stops being prefixed, the allowlist pattern must change
    // with it — which is the coupling that broke.
    expect(checksum).toMatch(/^sha256:[0-9a-f]{64}$/);

    const scaffolded = await invoke(
      build("approve-scaffold", {
        investigation,
        gate: "experiment_selection",
        approver: "web-ui operator",
      })
    );
    expect(scaffolded.status, scaffolded.output).toBe(0);
    const scaffoldPath = (JSON.parse(scaffolded.output) as { path: string }).path;

    // Straight through the allowlist, unmodified, exactly as approveThenRun does it.
    const approved = await invoke(
      build("approve", {
        investigation,
        gate: "experiment_selection",
        checksum,
        from: relative(dir, scaffoldPath).split(sep).join("/"),
      })
    );
    expect(approved.status, approved.output).toBe(0);
    expect(JSON.parse(approved.output)).toMatchObject({ ok: true });
  }, 120_000);

  it("still refuses a checksum that does not match the proposal", async () => {
    // The binding is the point of the gate: widening the pattern must not have widened what the
    // CLI accepts.
    const wrong = `sha256:${"a".repeat(64)}`;
    const refused = await invoke(
      build("approve", {
        investigation: "INV-001",
        gate: "experiment_selection",
        checksum: wrong,
        from: "approvals/nope.yaml",
      })
    );
    expect(refused.status).not.toBe(0);
    expect(refused.output).not.toMatch(PARSER_REJECTION);
  }, 60_000);
});
