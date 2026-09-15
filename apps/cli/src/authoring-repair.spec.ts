import { describe, it, expect, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRepairPrompt, pageSnapshotFrom, readRepairEvidence } from "./authoring-repair.js";

/**
 * Sending a replay that stopped before the final check back to the session that recorded it.
 *
 * The error-context shape below is the one Playwright wrote for the real INV-001 runs.
 */

const ERROR_CONTEXT = [
  "# Instructions",
  "",
  "- Following Playwright test failed.",
  "",
  "# Error details",
  "",
  "```",
  "Error: locator.fill: Test timeout of 15000ms exceeded.",
  "```",
  "",
  "# Page snapshot",
  "",
  "```yaml",
  "- generic [ref=f1e3]:",
  "  - generic [ref=f1e5]: All Categories",
  '  - button "Sell/Rent" [ref=f1e15] [cursor=pointer]',
  "```",
  "",
].join("\n");

describe("what the page showed", () => {
  it("takes the page snapshot out of Playwright's error context", () => {
    expect(pageSnapshotFrom(ERROR_CONTEXT)).toBe(
      '- generic [ref=f1e3]:\n  - generic [ref=f1e5]: All Categories\n  - button "Sell/Rent" [ref=f1e15] [cursor=pointer]'
    );
  });

  it("trims a long snapshot to what a prompt can carry, and says so", () => {
    const long = `# Page snapshot\n\n\`\`\`yaml\n${Array.from({ length: 100 }, (_, i) => `- line ${i}`).join("\n")}\n\`\`\`\n`;
    const snap = pageSnapshotFrom(long, 5)!;
    expect(snap.split("\n")).toHaveLength(6);
    expect(snap).toContain("(95 more lines)");
  });

  it("is null when there is no snapshot", () => {
    expect(pageSnapshotFrom("# Error details\n\nnothing else")).toBeNull();
  });
});

describe("reading the evidence a replay left", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("reads where runs stopped and attaches what the page showed", () => {
    const suite = mkdtempSync(join(tmpdir(), "repair-"));
    dirs.push(suite);
    mkdirSync(join(suite, "artifacts", "run-2"), { recursive: true });
    const contextPath = join(suite, "artifacts", "run-2", "error-context.md");
    writeFileSync(contextPath, ERROR_CONTEXT);
    writeFileSync(
      join(suite, "artifacts", "last-run.evidence.json"),
      JSON.stringify({
        repetitions: 2,
        reachedCheck: 1,
        stoppedEarly: 1,
        stops: [
          {
            line: 24,
            statement: "await page.getByRole('textbox', { name: 'Full Name' }).fill(process.env['ACCOUNT_USERNAME']);",
            waitingFor: "getByRole('textbox', { name: 'Full Name' })",
            runs: 1,
            errorContextPath: contextPath,
          },
        ],
      })
    );

    const evidence = readRepairEvidence(suite)!;
    expect(evidence.stoppedEarly).toBe(1);
    expect(evidence.stops[0]!.pageSnapshot).toContain("All Categories");
  });

  it("is null when no replay has been recorded", () => {
    const suite = mkdtempSync(join(tmpdir(), "repair-"));
    dirs.push(suite);
    expect(readRepairEvidence(suite)).toBeNull();
  });
});

describe("the repair prompt", () => {
  const prompt = buildRepairPrompt({
    repetitions: 2,
    reachedCheck: 0,
    stoppedEarly: 2,
    stops: [
      {
        line: 24,
        statement: "await page.getByRole('textbox', { name: 'Full Name' }).fill(process.env['ACCOUNT_USERNAME']);",
        waitingFor: "getByRole('textbox', { name: 'Full Name' })",
        runs: 2,
        pageSnapshot: "- generic [ref=f1e5]: All Categories",
      },
    ],
  });

  it("says exactly where the replay stopped, what it waited for, and what the page showed", () => {
    expect(prompt).toContain("Of 2 replay(s), 0 reached the final check and 2 stopped before it:");
    expect(prompt).toContain(
      "- 2 run(s) stopped at script line 24: `await page.getByRole('textbox', { name: 'Full Name' }).fill(process.env['ACCOUNT_USERNAME']);` — waiting for getByRole('textbox', { name: 'Full Name' }), which never appeared."
    );
    expect(prompt).toContain("```yaml\n- generic [ref=f1e5]: All Categories\n```");
  });

  it("asks for the whole flow again, made to hold on later runs, ending with the check", () => {
    expect(prompt).toContain("Record the whole flow again, from the very start");
    expect(prompt).toContain("browser_wait_for on proof it went through");
    expect(prompt).toContain("declare with OPTIONAL");
    expect(prompt.trim().endsWith("AUTHORING: DONE.")).toBe(true);
  });
});
