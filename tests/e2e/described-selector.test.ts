import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * An approved experiment that still carries a `described` selector, end to end.
 *
 * Playwright produces evidence. Deterministic software normalizes and measures evidence. DeepSeek interprets and prioritizes evidence. Humans authorize consequential transitions.
 *
 * `described` holds the reporter's words for a control — "the Verified filter". It used to be
 * UNEXECUTABLE by design, and this file asserted two separate refusals.
 *
 * That design was wrong in a way this test had locked in. An investigator that stops at every
 * control it was not handed a CSS selector for cannot investigate anything a reporter described
 * in words, which is every real bug report. The phrase is now resolved by role and accessible
 * name — the same information a person acts on — so what these tests assert has changed:
 *
 *  - A phrase that matches NOTHING still fails as AUTOMATION_FAILED under rule 3, never as a
 *    product defect. That ordering was the real guarantee and it is untouched.
 *  - `suite generate` now emits the same locator the run used, rather than refusing. A run that
 *    works and a reproduction of that run that does not would be one input with two answers.
 */

const REPO = process.cwd();
const CLI = join(REPO, "apps", "cli", "dist", "bin.js");
const INTAKE = join(REPO, "docs", "examples", "intake", "blank-results.md");
const PROPOSAL = join(REPO, "docs", "examples", "proposals", "gate-1.input.json");

const ENV: NodeJS.ProcessEnv = (() => {
  const e = { ...process.env };
  for (const k of [
    "DEEPSEEK_API_KEY",
    "DEEPSEEK_BASE_URL",
    "DEEPSEEK_FAST_MODEL",
    "DEEPSEEK_REASONING_MODEL",
    "DEEPSEEK_FALLBACK_MODEL",
  ]) {
    delete e[k];
  }
  e["REPROAGENT_NO_ENV_FILE"] = "1";
  return e;
})();

function run(args: string[]): { status: number; stdout: string } {
  try {
    return {
      status: 0,
      stdout: execFileSync(process.execPath, [CLI, ...args], { encoding: "utf8", env: ENV }),
    };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { status: err.status ?? 1, stdout: (err.stdout ?? "") + (err.stderr ?? "") };
  }
}

let ws: string;

describe("an unresolved `described` selector", () => {
  beforeAll(() => {
    ws = mkdtempSync(join(tmpdir(), "reproagent-described-"));
    run(["init", "--workspace", ws]);

    // One experiment, one repetition, with the click's selector left as the reporter's phrase.
    const proposal = JSON.parse(readFileSync(PROPOSAL, "utf8")) as {
      items: Array<Record<string, unknown>>;
    };
    proposal.items = [proposal.items[0]!];
    const item = proposal.items[0]!;
    item["repetitions"] = 1;
    for (const a of item["actions"] as Array<Record<string, unknown>>) {
      if (a["type"] === "click") {
        a["selector"] = { strategy: "described", value: "the Verified filter" };
      }
    }
    const proposalPath = join(ws, "proposal.json");
    writeFileSync(proposalPath, JSON.stringify(proposal, null, 2), "utf8");

    run(["intake", "--workspace", ws, "--from", INTAKE, "--json"]);
    const plan = JSON.parse(
      run([
        "plan",
        "--workspace",
        ws,
        "--investigation",
        "INV-001",
        "--from",
        proposalPath,
        "--json",
      ]).stdout
    ) as { proposalChecksum: string };
    const scaffold = JSON.parse(
      run([
        "approve",
        "experiment_selection",
        "--workspace",
        ws,
        "--investigation",
        "INV-001",
        "--scaffold",
        "--approver",
        "Test",
        "--json",
      ]).stdout
    ) as { path: string };
    run([
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
    ]);
    run([
      "run",
      "--workspace",
      ws,
      "--investigation",
      "INV-001",
      "--fixture-app",
      "product-failing-intermittent",
      "--json",
    ]);
  }, 180_000);

  afterAll(() => rmSync(ws, { recursive: true, force: true }));

  it("is AUTOMATION_FAILED, never PRODUCT_FAILED", () => {
    const normDir = join(
      ws,
      ".investigator",
      "investigations",
      "INV-001",
      "artifacts",
      "normalized-evidence"
    );
    const file = readdirSync(normDir).flatMap((shard) =>
      readdirSync(join(normDir, shard)).map((f) => join(normDir, shard, f))
    )[0]!;
    const doc = JSON.parse(readFileSync(file, "utf8")) as {
      outcome: { outcome: string; ruleId: number; detail: string };
      actions: Array<{ actionId: string; status: string; failureReason?: string | null }>;
    };

    // Rule 3 (automation) is evaluated before rule 4 (product) precisely so a broken sequence is
    // never counted as a defect in the application. That ordering is the point of this test.
    expect(doc.outcome.outcome).toBe("AUTOMATION_FAILED");
    expect(doc.outcome.ruleId).toBe(3);

    // `timeout`, not `failed`. The old refusal threw the instant it saw the strategy; the locator
    // now genuinely looks for the control and waits the action timeout before giving up. Both are
    // rule 3, which is the guarantee — but the status changed, and a test asserting the old value
    // would have quietly passed on the wrong evidence.
    const failed = doc.actions.find((a) => a.status === "timeout" || a.status === "failed");
    expect(failed, `actions were: ${JSON.stringify(doc.actions)}`).toBeDefined();
    expect(failed!.status).toBe("timeout");
    expect(failed!.actionId).toBe("A2");
    // The fixture page has no such control, so the resolved locator matches nothing and the
    // action fails. What matters is that the failure names the words that were searched for, so
    // a reader can see the phrase was looked for and not found rather than never attempted.
    expect(failed.failureReason).toMatch(/Verified/i);
  });

  it("exports the same locator the run used, rather than refusing", () => {
    const out = join(ws, "suite");
    const r = run([
      "suite",
      "generate",
      "--workspace",
      ws,
      "--investigation",
      "INV-001",
      "--out",
      out,
      "--json",
    ]);
    expect(r.status, r.stdout).toBe(0);

    const files = readdirSync(out).filter((f) => f.endsWith(".ts") || f.endsWith(".spec.ts"));
    const source = files.map((f) => readFileSync(join(out, f), "utf8")).join("\n");
    // Role and accessible name, matching the interpreter — not `getByText("the Verified filter")`,
    // which would search for the filler words too and never match anything.
    expect(source).toMatch(/getByRole|getByLabel/);
    expect(source).toMatch(/Verified/);
    expect(source).toContain(".first()");
  });

  it("still analyses the runs it did produce", () => {
    // A sequence that could not execute is not a reason to lose the evidence that the attempt
    // itself generated.
    const r = run(["analyze", "--workspace", ws, "--investigation", "INV-001", "--json"]);
    expect(r.status).toBe(0);
    const j = JSON.parse(r.stdout) as {
      contrast: { failingRunIds: string[]; firstFailingAction: Array<{ value: string }> };
    };
    expect(j.contrast.failingRunIds).toHaveLength(1);
    expect(j.contrast.firstFailingAction[0]?.value).toContain("A2");
  });
});
