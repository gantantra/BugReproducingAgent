import { describe, it, expect } from "vitest";
import {
  extractAuthoredSteps,
  isFailableCheck,
  renderAuthoredSpec,
  renderPlaywrightConfig,
  renderSuitePackageJson,
  whyStepsCannotMeasure,
} from "./authoring-script.js";

/**
 * Turning a successful authoring session into the re-runnable script (ADR-0027).
 *
 * The fixture below is trimmed from a REAL Playwright MCP session recorded by driving the Claude
 * CLI against a page — same structure, same escaping, same mix of code-bearing and code-free tool
 * calls. A hand-written approximation of the format would test my idea of it rather than it.
 */

const SESSION = `
### Tool call: browser_navigate
- Args
\`\`\`json
{
  "url": "https://shop.example/search"
}
\`\`\`
- Result
\`\`\`json
{
  "code": "await page.goto('https://shop.example/search');",
  "snapshot": "- heading \\"Search\\" [level=1] [ref=e2]"
}
\`\`\`

### Tool call: browser_snapshot
- Args
\`\`\`json
{}
\`\`\`
- Result
\`\`\`json
{
  "inlineSnapshot": "- textbox \\"Search widgets\\" [ref=e3]"
}
\`\`\`

### Tool call: browser_type
- Args
\`\`\`json
{
  "element": "Search widgets textbox",
  "target": "e3",
  "text": "bolt"
}
\`\`\`
- Result
\`\`\`json
{
  "code": "await page.getByRole('textbox', { name: 'Search widgets' }).fill('bolt');"
}
\`\`\`

### Tool call: browser_click
- Args
\`\`\`json
{
  "element": "Search button",
  "target": "e4"
}
\`\`\`
- Result
\`\`\`json
{
  "code": "await page.getByRole('button', { name: 'Search' }).click();"
}
\`\`\`
`;

describe("reading a session back", () => {
  it("keeps the statements in the order they ran", () => {
    const steps = extractAuthoredSteps(SESSION);
    expect(steps.map((s) => s.code)).toEqual([
      "await page.goto('https://shop.example/search');",
      "await page.getByRole('textbox', { name: 'Search widgets' }).fill('bolt');",
      "await page.getByRole('button', { name: 'Search' }).click();",
    ]);
  });

  it("skips tool calls that produced no code", () => {
    // A snapshot is how the model looked at the page; it is not a step in the reproduction.
    const steps = extractAuthoredSteps(SESSION);
    expect(steps.map((s) => s.tool)).not.toContain("browser_snapshot");
    expect(steps).toHaveLength(3);
  });

  it("attributes each statement to the tool that produced it", () => {
    expect(extractAuthoredSteps(SESSION).map((s) => s.tool)).toEqual([
      "browser_navigate",
      "browser_type",
      "browser_click",
    ]);
  });

  it("survives a block that is not valid JSON", () => {
    // Losing a step shows up the moment the script runs. Inventing one does not.
    const damaged = SESSION.replace('"code": "await page.goto', '"code" "await page.goto');
    expect(() => extractAuthoredSteps(damaged)).not.toThrow();
    expect(extractAuthoredSteps(damaged)).toHaveLength(2);
  });

  it("returns nothing for a session with no tool calls", () => {
    expect(extractAuthoredSteps("# nothing happened here")).toEqual([]);
  });

  it("preserves quotes and braces inside a selector", () => {
    // The reason this parses JSON rather than pattern-matching the rendered markdown.
    const tricky = `### Tool call: browser_click
- Result
\`\`\`json
{ "code": "await page.getByRole('button', { name: 'It\\\\'s \\"quoted\\"' }).click();" }
\`\`\``;
    const [step] = extractAuthoredSteps(tricky);
    expect(step!.code).toContain(`{ name:`);
    expect(step!.code).toContain(`"quoted"`);
  });
});

describe("the emitted spec", () => {
  const steps = extractAuthoredSteps(SESSION);
  const spec = renderAuthoredSpec(steps, {
    title: "Search returns nothing for a valid term",
    investigationId: "INV-014",
    authoredAt: "2026-09-13",
    reportSummary: "Reporter: searching sometimes returns nothing.",
  });

  it("is ordinary Playwright with no dependency on this project", () => {
    // It is handed to a developer who has never run ReproAgent.
    expect(spec).toContain('import { test } from "@playwright/test";');
    expect(spec).not.toMatch(/@investigator/);
  });

  it("names the bug in the test title, so a failure names it too", () => {
    expect(spec).toContain('test("Search returns nothing for a valid term"');
  });

  it("carries every authored statement", () => {
    for (const s of steps) expect(spec).toContain(s.code);
  });

  it("says how to re-run it N times", () => {
    expect(spec).toMatch(/--repeat-each=N/);
  });

  it("records where it came from", () => {
    expect(spec).toContain("INV-014");
    expect(spec).toContain("Reporter: searching sometimes returns nothing.");
  });
});

describe("the emitted config", () => {
  const config = renderPlaywrightConfig({ outputDir: "./artifacts" });

  it("records video on every run, not only failures", () => {
    // The approval gate is a human watching a PASSING run, so that is the recording needed.
    expect(config).toContain('video: "on"');
  });

  it("never retries", () => {
    // A retry hides the intermittent failure the whole suite exists to count.
    expect(config).toContain("retries: 0");
  });

  it("uses one worker, because repetitions of one flow are not independent", () => {
    expect(config).toContain("workers: 1");
  });

  it("fails faster than Playwright's default, because failures are the point", () => {
    // Measured: 30 runs of a 1-in-3 bug took 6.4 minutes, almost all of it ten failing runs
    // waiting out a 30s timeout for an element that was never going to appear.
    expect(config).toContain("timeout: 15_000");
  });
});

describe("the emitted package manifest", () => {
  const pkg = JSON.parse(
    renderSuitePackageJson({ investigationId: "INV-014", playwrightVersion: "1.63.0" })
  ) as { devDependencies: Record<string, string>; scripts: Record<string, string> };

  it("declares what the suite needs, pinned", () => {
    // Found by running the real thing: without this the suite fails with MODULE_NOT_FOUND, or
    // worse, picks up a mismatched @playwright/test from a parent directory and reports
    // "No tests found" — neither of which points at the actual problem.
    expect(pkg.devDependencies["@playwright/test"]).toBe("1.63.0");
  });

  it("ships the N-times command rather than leaving it to be remembered", () => {
    expect(pkg.scripts["test:100"]).toContain("--repeat-each=100");
  });
});

describe("refusing a suite that cannot measure anything", () => {
  const step = (code: string, tool = "browser_click") => ({ code, tool });

  /**
   * The exact script a session emitted against a real site, reported DONE, and offered to the
   * operator with a "Run it 30×" button. It contains no assertion, so those 30 runs would have
   * reported 30 passes and a bug that does not reproduce — while the bug reproduced.
   */
  const THE_ONE_THAT_GOT_THROUGH = [
    step("await page.goto('https://www.99acres.com/createNewPassword');", "browser_navigate"),
    step("await page.getByRole('textbox').nth(2).fill('TestPass123');", "browser_type"),
    step("await page.getByRole('textbox').nth(3).fill('TestPass123');", "browser_type"),
    step("await page.getByRole('button', { name: 'Create New Password' }).click();"),
  ];

  it("refuses the script that actually shipped, naming why", () => {
    const why = whyStepsCannotMeasure(THE_ONE_THAT_GOT_THROUGH);
    expect(why).toBeTruthy();
    expect(why).toContain("not one of the recorded steps can fail");
  });

  it("refuses a check that is only a sleep", () => {
    // browser_wait_for given `time` rather than `text`. It looks like a wait and asserts nothing:
    // a script ending in it passes exactly as often as one ending immediately.
    const why = whyStepsCannotMeasure([
      ...THE_ONE_THAT_GOT_THROUGH,
      step("await page.waitForTimeout(2000);", "browser_wait_for"),
    ]);
    expect(why).toContain("not one of the recorded steps can fail");
  });

  it("accepts a script that ends in a real wait, which is what the brief asks for", () => {
    const steps = [
      ...THE_ONE_THAT_GOT_THROUGH,
      step(
        "await page.getByText(\"Password changed\").first().waitFor({ state: 'visible' });",
        "browser_wait_for"
      ),
    ];
    expect(whyStepsCannotMeasure(steps)).toBeNull();
  });

  it("refuses a check followed by more clicking, because the tail is unverified", () => {
    const steps = [
      step(
        "await page.getByText(\"Settings\").first().waitFor({ state: 'visible' });",
        "browser_wait_for"
      ),
      step("await page.getByRole('button', { name: 'Save' }).click();"),
    ];
    expect(whyStepsCannotMeasure(steps)).toContain("last recorded step is an action");
  });

  it("still refuses an empty session", () => {
    expect(whyStepsCannotMeasure([])).toContain("no browser steps");
  });

  it("counts waitFor and expect as failable, and actions and sleeps as not", () => {
    expect(isFailableCheck("await page.getByText('x').waitFor({ state: 'hidden' });")).toBe(true);
    expect(isFailableCheck("await expect(page.getByRole('alert')).toBeVisible();")).toBe(true);
    expect(isFailableCheck("await page.getByRole('button').click();")).toBe(false);
    expect(isFailableCheck("await page.waitForTimeout(500);")).toBe(false);
  });
});
