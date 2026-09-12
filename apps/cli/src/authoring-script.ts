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
