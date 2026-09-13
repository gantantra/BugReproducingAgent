/**
 * Turning a successful authoring session into the script that gets re-run (ADR-0027).
 *
 * Playwright MCP records every tool call it made, and each result carries a `code` field holding
 * the exact Playwright statement for that call:
 *
 * ```
 * await page.getByRole('textbox', { name: 'Search widgets' }).fill('bolt');
 * await page.getByRole('button', { name: 'Search' }).click();
 * ```
 *
 * That is the whole reason this product drives the browser through MCP rather than through its
 * own Playwright. The script is a BY-PRODUCT of the run that worked — the same calls, in the same
 * order, with the same selectors — rather than something reconstructed afterwards from a
 * description of what happened. Reconstruction is where the drift lives: the run passes, the
 * rebuilt script does not, and the difference is discovered by whoever trusts it next.
 *
 * The selectors come out as role plus accessible name because that is what MCP's codegen emits.
 * That form survives a CSS refactor, which matters here more than usual: this script is not run
 * once, it is run N times, unattended, possibly weeks later.
 */

/** One recorded step: the Playwright statement, and the tool call it came from. */
export interface AuthoredStep {
  /** The Playwright statement, exactly as MCP generated it. */
  code: string;
  /** The MCP tool that produced it, for a human reading the session back. */
  tool: string;
}

/**
 * Pull the ordered Playwright statements out of a saved MCP session.
 *
 * The session is markdown with fenced JSON blocks. Parsing it rather than pattern-matching the
 * code lines directly is deliberate: a selector can contain braces, quotes and newlines, and a
 * regex over the rendered markdown would mangle exactly the interesting ones.
 *
 * Tool calls that produce no code — a snapshot, a console read — contribute nothing and are
 * skipped rather than represented as blank lines.
 */
export function extractAuthoredSteps(sessionMarkdown: string): AuthoredStep[] {
  const steps: AuthoredStep[] = [];
  let currentTool = "unknown";

  // Walk the document in order, tracking the most recent tool heading so each block is attributed.
  const tokens = sessionMarkdown.split(/^### Tool call: /m);
  for (const token of tokens) {
    const nameMatch = /^([A-Za-z0-9_]+)/.exec(token);
    if (nameMatch) currentTool = nameMatch[1]!;

    for (const block of fencedJsonBlocks(token)) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(block);
      } catch {
        // A block that is not valid JSON is not a result we understand. Skipping it loses a step
        // rather than inventing one, and a missing step shows up immediately when the script runs.
        continue;
      }
      const code = (parsed as { code?: unknown })?.code;
      if (typeof code === "string" && code.trim().length > 0) {
        steps.push({ code: code.trim(), tool: currentTool });
      }
    }
  }
  return steps;
}

/**
 * Does this statement assert something, or does it merely do something?
 *
 * `browser_wait_for` given `text` emits `.waitFor({ state: 'visible' })`, which throws when the
 * text never appears; given `textGone` it emits `state: 'hidden'`. Both can fail, which is the
 * whole point. Given `time` it emits a sleep, which cannot fail and is explicitly not a check —
 * a script that ends by waiting two seconds passes exactly as often as one that ends immediately.
 *
 * Actions are not checks even though Playwright auto-waits and a `click` on a missing element
 * fails. That failure says the CONTROL was absent, not that the application misbehaved. A form
 * that silently fails to save still renders its Save button, so a script ending in a click passes
 * every run while the bug happens in front of it.
 */
export function isFailableCheck(code: string): boolean {
  if (/waitForTimeout|setTimeout/.test(code)) return false;
  return /\.waitFor\s*\(|\bexpect\s*\(/.test(code);
}

/**
 * Why the emitted steps cannot measure anything, or null when they can.
 *
 * This is a hard gate rather than advice, because advice did not hold. The brief tells every
 * session to end with a check, and a session against a real site returned DONE with this:
 *
 * ```
 * await page.goto('…/createNewPassword');
 * await page.getByRole('textbox').nth(2).fill('…');
 * await page.getByRole('button', { name: 'Create New Password' }).click();
 * ```
 *
 * Eight statements, no assertion. Run 30 times it reports 30 passes whatever the application
 * does, and the report reads as evidence the bug does not reproduce — the most expensive possible
 * wrong answer, because it looks like a result. Refusing to emit turns a fake success into a
 * visible failure the operator can act on, which is the outcome the product's governing principle
 * requires: a script that cannot fail measures nothing.
 */
export function whyStepsCannotMeasure(steps: readonly AuthoredStep[]): string | null {
  if (steps.length === 0) return "the session recorded no browser steps at all";

  const checks = steps.filter((s) => isFailableCheck(s.code));
  if (checks.length === 0) {
    return (
      "not one of the recorded steps can fail. Every statement is an action — navigate, fill, " +
      "click — so re-running this suite reports a pass on every run no matter how the " +
      "application behaves, and a pass rate computed from it is meaningless. The session needed " +
      "to end with a browser_wait_for on text that is present when the flow works"
    );
  }

  if (!isFailableCheck(steps[steps.length - 1]!.code)) {
    return (
      "the last recorded step is an action, not a check. Whatever the flow did after the final " +
      "assertion is unverified, which is the part the bug is in. The session needed to finish " +
      "with a browser_wait_for rather than a click"
    );
  }

  return null;
}

/** Every ```json fenced block in a markdown fragment, in order. */
function fencedJsonBlocks(markdown: string): string[] {
  const blocks: string[] = [];
  const fence = /```json\r?\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = fence.exec(markdown)) !== null) blocks.push(m[1]!);
  return blocks;
}

export interface RenderSpecOptions {
  /** Shown as the test name, so a failing run names the bug rather than a file. */
  title: string;
  investigationId: string;
  /** What the reporter said, as a comment. The script should explain itself to a stranger. */
  reportSummary?: string;
  /** Recorded so a reader knows the script was authored, not hand-written. */
  authoredAt: string;
}

/**
 * Render the steps as a standalone Playwright spec.
 *
 * Deliberately ordinary Playwright with no import from this project. The output is handed to a
 * developer who has never run ReproAgent, and it has to be readable and runnable on its own —
 * `npx playwright test --repeat-each=N` and nothing else.
 */
export function renderAuthoredSpec(
  steps: readonly AuthoredStep[],
  opts: RenderSpecOptions
): string {
  const body = steps.map((s) => `    ${s.code.replace(/\n/g, "\n    ")}`);

  return [
    `// ${opts.title}`,
    `//`,
    `// Authored by driving a real browser until the reported behaviour was reached, then kept:`,
    `// every line below is the statement Playwright itself generated for a call that actually`,
    `// ran. Investigation ${opts.investigationId}, authored ${opts.authoredAt}.`,
    ...(opts.reportSummary ? [`//`, ...opts.reportSummary.split("\n").map((l) => `// ${l}`)] : []),
    `//`,
    `// Re-run it N times with:  npx playwright test --repeat-each=N`,
    `// An intermittent fault is the reason for N: one pass proves nothing about a bug that`,
    `// appears one time in five.`,
    ``,
    `import { test } from "@playwright/test";`,
    ``,
    `test(${JSON.stringify(opts.title)}, async ({ page }) => {`,
    ...body,
    `});`,
    ``,
  ].join("\n");
}

/**
 * The Playwright config that makes a re-run produce the video the gate asks for.
 *
 * `video: "on"` rather than `retain-on-failure`: the operator approves the script by watching it
 * work, so the passing run is exactly the one whose recording is needed. `retries: 0` because a
 * retry would hide the intermittent failure this exists to count.
 */
export function renderPlaywrightConfig(opts: { outputDir: string }): string {
  return [
    `import { defineConfig } from "@playwright/test";`,
    ``,
    `export default defineConfig({`,
    `  // No retries. A retry hides the intermittent failure this suite exists to measure.`,
    `  retries: 0,`,
    `  // Shorter than Playwright's 30s default, because here failures are the POINT and there are`,
    `  // many of them: 30 runs of a 1-in-3 bug spent 6.4 minutes, almost all of it ten failing`,
    `  // runs waiting out a timeout for an element that was never going to appear. Still generous`,
    `  // enough that a merely slow page is not reported as a broken one.`,
    `  timeout: 15_000,`,
    `  // One worker: repetitions of one flow against one account are not independent.`,
    `  workers: 1,`,
    `  outputDir: ${JSON.stringify(opts.outputDir)},`,
    `  use: {`,
    `    // Every run, not just failures: the approval gate is a human watching a PASSING run.`,
    `    video: "on",`,
    `    trace: "retain-on-failure",`,
    `  },`,
    `});`,
    ``,
  ].join("\n");
}

/**
 * The package manifest that makes the emitted suite self-sufficient.
 *
 * Found necessary by running the real thing: a folder holding only a spec and a config fails with
 * `MODULE_NOT_FOUND` in one environment and, worse, with `Error: No tests found` in another —
 * where a stray `@playwright/test` resolved from a parent directory at a version that did not
 * match the runner. Neither message points at the actual problem, which is that the suite never
 * declared what it needs.
 *
 * The version is pinned rather than ranged. This suite is re-run weeks later to compare against
 * earlier results, and "the same script" has to mean the same runner too.
 */
export function renderSuitePackageJson(opts: {
  investigationId: string;
  playwrightVersion: string;
}): string {
  return (
    JSON.stringify(
      {
        name: `repro-${opts.investigationId.toLowerCase()}`,
        private: true,
        description: `Reproduction authored for ${opts.investigationId}. Run it N times to measure how often it fails.`,
        scripts: {
          test: "playwright test",
          "test:100": "playwright test --repeat-each=100",
        },
        devDependencies: { "@playwright/test": opts.playwrightVersion },
      },
      null,
      2
    ) + "\n"
  );
}
