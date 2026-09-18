import { describe, it, expect } from "vitest";
import { classifyRuns, describeBreakdown, describeFailures, summarizeReport } from "./rerun.js";

describe("telling the bug apart from a script that never got there", () => {
  // Lines 1-5 of a tiny spec; the last `await page.` statement (line 5) is the final check.
  const SPEC = [
    'import { test } from "@playwright/test";',
    'test("t", async ({ page }) => {',
    "    await page.getByTestId('primary-button').click();",
    "    await page.getByRole('textbox', { name: 'Full Name' }).fill(process.env['ACCOUNT_USERNAME']);",
    "    await page.getByText(\"Account has been deleted successfully!\").first().waitFor({ state: 'visible' });",
    "});",
  ].join("\n");

  const run = (status: string, line?: number, waiting?: string) => ({
    status,
    errors:
      line === undefined
        ? status === "failed"
          ? [
              {
                message:
                  "Error: browserType.launch: Target page, context or browser has been closed",
              },
            ]
          : []
        : [
            { message: "Test timeout of 15000ms exceeded." },
            {
              message: `Error: locator.fill: Test timeout of 15000ms exceeded.\nCall log:\n  - waiting for ${waiting}\n`,
              location: { line },
            },
          ],
    attachments: [{ name: "error-context", path: `C:/artifacts/run-${line}/error-context.md` }],
  });

  // Shaped like the real report: runs that never reached the check, one that failed the check, one that passed.
  const report = {
    stats: { expected: 1, unexpected: 4, flaky: 0, skipped: 0 },
    suites: [
      {
        specs: [
          {
            tests: [
              { results: [run("passed")] },
              { results: [run("timedOut", 4, "getByRole('textbox', { name: 'Full Name' })")] },
              { results: [run("timedOut", 4, "getByRole('textbox', { name: 'Full Name' })")] },
              {
                results: [
                  run("timedOut", 5, 'getByText("Account has been deleted successfully!").first()'),
                ],
              },
              { results: [run("failed")] },
            ],
          },
        ],
      },
    ],
  };

  it("counts only runs that reached the final check towards the bug", () => {
    const b = classifyRuns(report, SPEC);
    expect(b.checkLine).toBe(5);
    expect(b.reachedCheck).toBe(2);
    expect(b.failedAtCheck).toBe(1);
    expect(b.stoppedEarly).toBe(3);
  });

  it("says where the other runs stopped and what they were waiting for", () => {
    const b = classifyRuns(report, SPEC);
    expect(b.stops[0]).toEqual({
      line: 4,
      statement:
        "await page.getByRole('textbox', { name: 'Full Name' }).fill(process.env['ACCOUNT_USERNAME']);",
      waitingFor: "getByRole('textbox', { name: 'Full Name' })",
      runs: 2,
      errorContextPath: "C:/artifacts/run-4/error-context.md",
    });
    expect(b.stops[1]!.line).toBeNull();
    expect(describeBreakdown(b)).toBe(
      "2 of 5 runs reached the final check and 1 of those failed it (50%); 3 stopped before it — the script or the site, not the bug — most at line 4, waiting for getByRole('textbox', { name: 'Full Name' })"
    );
  });

  it("does not report a failure rate when no run got as far as the check", () => {
    const none = {
      stats: { expected: 0, unexpected: 2, flaky: 0, skipped: 0 },
      suites: [
        {
          specs: [
            {
              tests: [
                { results: [run("timedOut", 4, "x")] },
                { results: [run("timedOut", 4, "x")] },
              ],
            },
          ],
        },
      ],
    };
    expect(describeBreakdown(classifyRuns(none, SPEC))).toBe(
      "none of 2 runs reached the final check; 2 stopped before it — the script or the site, not the bug — at line 4, waiting for x"
    );
  });
});

/**
 * Counting what N runs of the authored suite actually did.
 *
 * The counts come from Playwright's own JSON report rather than from its console output, because
 * a miscount here is a wrong failure rate presented as a measurement — the one number the whole
 * re-run exists to produce.
 */

describe("counting the runs", () => {
  it("reads the reporter's own stats", () => {
    const counts = summarizeReport({
      stats: { expected: 23, unexpected: 7, flaky: 0, skipped: 0, duration: 1234 },
    });
    expect(counts).toEqual({ total: 30, passed: 23, failed: 7, flaky: 0, skipped: 0 });
    expect(describeFailures(counts)).toBe("7 of 30 runs failed (23%)");
  });

  it("walks the suites when the report carries no stats", () => {
    // --repeat-each makes each repetition its own test entry under the spec.
    const counts = summarizeReport({
      suites: [
        {
          specs: [{ tests: [{ status: "expected" }, { status: "unexpected" }] }],
          suites: [{ specs: [{ tests: [{ status: "flaky" }, { status: "skipped" }] }] }],
        },
      ],
    });
    expect(counts).toEqual({ total: 4, passed: 1, failed: 1, flaky: 1, skipped: 1 });
  });

  it("counts nothing it does not recognise, rather than counting it as a pass", () => {
    expect(
      summarizeReport({ suites: [{ specs: [{ tests: [{ status: "interrupted" }] }] }] })
    ).toEqual({ total: 0, passed: 0, failed: 0, flaky: 0, skipped: 0 });
    expect(summarizeReport(null)).toEqual({ total: 0, passed: 0, failed: 0, flaky: 0, skipped: 0 });
    expect(describeFailures({ total: 0, passed: 0, failed: 0, flaky: 0, skipped: 0 })).toBe(
      "no runs were recorded"
    );
  });

  it("says plainly when nothing failed", () => {
    expect(describeFailures({ total: 30, passed: 30, failed: 0, flaky: 0, skipped: 0 })).toBe(
      "none of 30 runs failed"
    );
  });
});
