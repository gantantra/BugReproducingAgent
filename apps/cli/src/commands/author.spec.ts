import { describe, it, expect } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Runtime } from "../runtime.js";
import { extractAuthoredSteps, whyStepsCannotMeasure } from "../authoring-script.js";
import {
  attemptSessionMarkdowns,
  deriveTitleForTest,
  formatToolUse,
  readAuthoringOutcome,
  buildPrompt,
  planRevisionSection,
  planVersionOf,
  runClaudeForTest,
  screenshotLine,
} from "./author.js";

describe("the script is built from every browser run of the attempt", () => {
  /** A saved MCP session in the shape MCP writes: a tool heading, then a JSON result with `code`. */
  const sessionMd = (...calls: Array<[tool: string, code: string]>) =>
    calls
      .map(
        ([tool, code]) =>
          `### Tool call: ${tool}\n- Result\n\`\`\`json\n${JSON.stringify({ code })}\n\`\`\`\n`
      )
      .join("\n");

  it("takes the sign-in run and the resumed run that reached the flow, in the order they ran", () => {
    // Observed: a resume starts a new MCP server and a new session folder. Only the first folder
    // was read, which held the sign-in, while the run that deleted the account sat in the second.
    const outputDir = mkdtempSync(join(tmpdir(), "author-attempt-"));
    try {
      const write = (name: string, body: string) => {
        mkdirSync(join(outputDir, name), { recursive: true });
        writeFileSync(join(outputDir, name, "session.md"), body);
      };
      // Created out of order, so the answer cannot come from the order readdir happens to list.
      write(
        "session-3000",
        sessionMd(
          [
            "browser_click",
            "await page.getByRole('button', { name: 'Yes, Please continue to delete' }).click();",
          ],
          [
            "browser_wait_for",
            "await page.getByText(\"Account has been deleted successfully!\").first().waitFor({ state: 'visible' });",
          ]
        )
      );
      write(
        "session-1000",
        sessionMd(["browser_navigate", "await page.goto('https://www.99acres.com');"])
      );
      write(
        "session-500",
        sessionMd(["browser_navigate", "await page.goto('https://an-earlier-attempt.example');"])
      );
      mkdirSync(join(outputDir, "live"));

      const paths = attemptSessionMarkdowns(outputDir, 1000);
      expect(paths.map((p) => p.split(/[\\/]/).slice(-2)[0])).toEqual([
        "session-1000",
        "session-3000",
      ]);

      const steps = paths.flatMap((p) => extractAuthoredSteps(readFileSync(p, "utf8")));
      expect(steps.map((s) => s.tool)).toEqual([
        "browser_navigate",
        "browser_click",
        "browser_wait_for",
      ]);
      expect(whyStepsCannotMeasure(steps)).toBeNull();
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
    }
  });
});

describe("the directory the CLI was launched from is not the session's to tidy", () => {
  it("leaves an image the operator already had there exactly where it was", async () => {
    // The web UI runs the CLI with cwd set to the operator's launch directory, often the repo
    // root. A session used to move every image found there into its own folder and delete the
    // original, once at start and again every second.
    const launchDir = mkdtempSync(join(tmpdir(), "author-launch-"));
    const sessionDir = mkdtempSync(join(tmpdir(), "author-session-"));
    const original = Buffer.from("the operator's own screenshot");
    writeFileSync(join(launchDir, "keep.png"), original);
    const previous = process.cwd();
    process.chdir(launchDir);
    try {
      // A stand-in for `claude`: reads the prompt, then stays up past the one-second image poll.
      await runClaudeForTest(
        process.execPath,
        [
          "-e",
          "process.stdin.resume(); process.stdin.on('end', () => setTimeout(() => {}, 1500));",
        ],
        "prompt",
        { logger: { debug: () => {} } } as unknown as Runtime,
        sessionDir,
        sessionDir
      );
      expect(readFileSync(join(launchDir, "keep.png"))).toEqual(original);
      expect(existsSync(join(sessionDir, "keep.png"))).toBe(false);
    } finally {
      process.chdir(previous);
      rmSync(launchDir, { recursive: true, force: true });
      rmSync(sessionDir, { recursive: true, force: true });
    }
  });
});

describe("a session the turn counter stopped", () => {
  /** A stand-in for `claude` that prints these stream-json lines once it has read the prompt. */
  const standIn = (...lines: object[]): string[] => [
    "-e",
    `process.stdin.resume(); process.stdin.on('end', () => { for (const l of ${JSON.stringify(
      lines.map((l) => JSON.stringify(l))
    )}) console.log(l); });`,
  ];
  const rt = { logger: { debug: () => {} } } as unknown as Runtime;

  it("is marked, so the harness can continue it rather than start over", async () => {
    const session = await runClaudeForTest(
      process.execPath,
      standIn(
        {
          type: "assistant",
          session_id: "s-1",
          message: { content: [{ type: "text", text: "Ticking the consent box" }] },
        },
        { type: "result", subtype: "error_max_turns", is_error: true, session_id: "s-1" }
      ),
      "prompt",
      rt
    );
    expect(session.turnLimit).toBe(true);
    expect(session.sessionId).toBe("s-1");
    expect(readAuthoringOutcome(session.finalMessage).kind).toBe("stuck");
  });

  it("is not marked when the session ended on its own sentinel", async () => {
    const session = await runClaudeForTest(
      process.execPath,
      standIn({
        type: "result",
        subtype: "error_max_turns",
        is_error: true,
        session_id: "s-2",
        result: "Recorded the check.\nAUTHORING: DONE",
      }),
      "prompt",
      rt
    );
    expect(session.turnLimit).toBe(false);
    expect(readAuthoringOutcome(session.finalMessage).kind).toBe("done");
  });
});

describe("pointing the live viewport at a screenshot", () => {
  it("names the image relative to the --workspace folder, which the server resolves against", () => {
    // The layout a web session really has: the CLI's workspace root is `.investigator` INSIDE the
    // folder the server passed. A path relative to that root dropped `.investigator/`, and the
    // server answered 404 for every frame.
    const sessionFolder = resolve("sessions", "2026-09-15T07-57-20Z-96307f");
    const image = join(
      sessionFolder,
      ".investigator",
      "investigations",
      "INV-002",
      "authoring",
      "mcp",
      "page-1.png"
    );
    expect(screenshotLine(sessionFolder, image)).toBe(
      `[SCREENSHOT:/api/session-image?file=${encodeURIComponent(
        ".investigator/investigations/INV-002/authoring/mcp/page-1.png"
      )}]`
    );
  });
});

/**
 * Reading how an authoring session ended (ADR-0027).
 *
 * A single sentinel line rather than a schema, because DeepSeek driving a browser does not need a
 * validator adjudicating each step — the harness only needs to know which of three things
 * happened. The parsing still has to be strict about one thing: never reading an unrecognised
 * ending as success, because "done" is what causes a script to be emitted.
 */

describe("recognising the ending", () => {
  it("reads DONE", () => {
    expect(readAuthoringOutcome("I reproduced it.\n\nAUTHORING: DONE")).toEqual({ kind: "done" });
  });

  it("reads a request to relaunch the browser as another platform", () => {
    // The operator said "mobile web only" after the browser was already open as desktop.
    expect(
      readAuthoringOutcome(
        "They want the mobile site.\n\nAUTHORING: PLATFORM pixel-7-chrome-mobile"
      )
    ).toEqual({ kind: "platform", profile: "pixel-7-chrome-mobile" });
  });

  it("reads a question and keeps its text", () => {
    const out = readAuthoringOutcome(
      "There are two Delete controls on this page.\n\nAUTHORING: QUESTION Which Delete did you mean, the one in the row or the one in the dialog?"
    );
    expect(out.kind).toBe("question");
    if (out.kind === "question") expect(out.question).toMatch(/Which Delete/);
  });

  it("reads stuck and keeps the reason", () => {
    const out = readAuthoringOutcome("AUTHORING: STUCK The login page shows a CAPTCHA.");
    expect(out.kind).toBe("stuck");
    if (out.kind === "stuck") expect(out.reason).toContain("CAPTCHA");
  });

  it("takes the LAST sentinel, not one mentioned while explaining", () => {
    // A model explaining the protocol to itself must not end the session by accident.
    const out = readAuthoringOutcome(
      "I will end with AUTHORING: QUESTION if I need you.\nAll good.\n\nAUTHORING: DONE"
    );
    expect(out).toEqual({ kind: "done" });
  });

  it("tolerates markdown emphasis and trailing whitespace around the line", () => {
    expect(readAuthoringOutcome("done\n\n**AUTHORING: DONE**   \n\n").kind).toBe("done");
    expect(readAuthoringOutcome("`AUTHORING: DONE`").kind).toBe("done");
  });

  it("is case-insensitive on the verb", () => {
    expect(readAuthoringOutcome("authoring: done").kind).toBe("done");
  });

  it("never reads an unrecognised ending as success", () => {
    // The load-bearing case: `done` is what emits a script, and a session that stopped halfway
    // must not produce one that looks complete.
    for (const ending of ["I think that worked.", "", "AUTHORING: MAYBE", "DONE"]) {
      expect(readAuthoringOutcome(ending).kind, JSON.stringify(ending)).toBe("unknown");
    }
  });

  it("shows the tail when it could not tell, so a human can", () => {
    const out = readAuthoringOutcome("line one\nline two\nline three\nline four");
    expect(out.kind).toBe("unknown");
    if (out.kind === "unknown") expect(out.tail).toContain("line four");
  });
});

describe("naming the emitted test", () => {
  it("uses a heading when the report has one", () => {
    expect(deriveTitleForTest("# Search shows no parts\n\nMore detail here.", "INV-001")).toBe(
      "Search shows no parts"
    );
  });

  it("shortens a report pasted as one long paragraph", () => {
    // What a chat box actually produces. Taking "the first line" made the test name the whole
    // report, which is unreadable in a Playwright run and worse in a CI summary.
    const pasted =
      "On the Parts Catalogue page I type bearing into the search box and press Search. " +
      "Most of the time it lists three bearings. But every so often it says No parts found.";
    const title = deriveTitleForTest(pasted, "INV-001");
    expect(title.length).toBeLessThanOrEqual(81);
    expect(title).toContain("Parts Catalogue");
  });

  it("ends on a boundary rather than mid-word", () => {
    const title = deriveTitleForTest("a".repeat(20) + " " + "b".repeat(90), "INV-001");
    expect(title.endsWith("…") || !title.endsWith("b")).toBe(true);
  });

  it("falls back to the investigation id when there is nothing to use", () => {
    expect(deriveTitleForTest("   \n\n  ", "INV-007")).toBe("INV-007");
  });
});

describe("a question always carries its text", () => {
  // The page renders this as the question. An empty one is a card with a blank space and a
  // button, which tells the operator nothing about what is wanted — seen in a real session,
  // because the brief asked for the text on the sentinel line AND for the sentinel to stand
  // alone. Reading both forms is what makes that class of mistake stop mattering.
  it("takes the text from the sentinel line when it is there", () => {
    const out = readAuthoringOutcome(
      "Looking at the login page.\n\nAUTHORING: QUESTION Which account?"
    );
    expect(out.kind).toBe("question");
    if (out.kind === "question") expect(out.question).toBe("Which account?");
  });

  it("falls back to the message above a bare sentinel", () => {
    const out = readAuthoringOutcome(
      "I need the password for the test account to sign in.\n\nAUTHORING: QUESTION"
    );
    expect(out.kind).toBe("question");
    if (out.kind === "question") expect(out.question).toContain("password for the test account");
  });

  it("never yields an empty question when anything was said at all", () => {
    for (const msg of [
      "Something.\nAUTHORING: QUESTION",
      "AUTHORING: QUESTION the thing",
      "Line one\nLine two\n\nAUTHORING: QUESTION   ",
    ]) {
      const out = readAuthoringOutcome(msg);
      expect(out.kind, msg).toBe("question");
      if (out.kind === "question") expect(out.question.length, msg).toBeGreaterThan(0);
    }
  });

  it("does the same for a stuck reason", () => {
    const out = readAuthoringOutcome("The login page shows a CAPTCHA.\n\nAUTHORING: STUCK");
    expect(out.kind).toBe("stuck");
    if (out.kind === "stuck") expect(out.reason).toContain("CAPTCHA");
  });
});

describe("reading the plan sentinel", () => {
  it("takes the plan from the body above the sentinel, not the sentinel line", () => {
    // A plan is a numbered list, so unlike a question it never fits on the sentinel line.
    const outcome = readAuthoringOutcome(
      [
        "1. Sign in as ACCOUNT_EMAIL / ACCOUNT_PASSWORD",
        "2. Open /account/password",
        '3. Fill "New Password" with ??? — I don\'t have this',
        '4. Check for "Password changed"',
        "",
        "AUTHORING: PLAN",
      ].join("\n")
    );
    expect(outcome.kind).toBe("plan");
    if (outcome.kind !== "plan") throw new Error("unreachable");
    expect(outcome.plan).toContain("Sign in as ACCOUNT_EMAIL");
    expect(outcome.plan).toContain("I don't have this");
    expect(outcome.plan).not.toContain("AUTHORING:");
  });

  it("does not mistake a plan for a finished reproduction", () => {
    // The distinction that matters: "done" emits a script, "plan" must not.
    expect(readAuthoringOutcome("steps\n\nAUTHORING: PLAN").kind).toBe("plan");
    expect(readAuthoringOutcome("steps\n\nAUTHORING: DONE").kind).toBe("done");
  });
});

describe("formatting browser tool calls for live chat streaming", () => {
  it("formats navigation", () => {
    expect(
      formatToolUse("mcp__playwright__browser_navigate", { url: "http://localhost:3000/app" })
    ).toBe("🌐 Navigating to http://localhost:3000/app");
  });

  it("formats clicking with element description or selector", () => {
    expect(formatToolUse("mcp__playwright__browser_click", { element: "Submit button" })).toBe(
      "👆 Clicking: Submit button"
    );
    expect(formatToolUse("mcp__playwright__browser_click", { selector: "#submit" })).toBe(
      "👆 Clicking: #submit"
    );
  });

  it("formats typing input", () => {
    expect(formatToolUse("mcp__playwright__browser_type", { text: "hello world" })).toBe(
      "⌨️ Typing text: hello world"
    );
  });

  it("formats form filling", () => {
    expect(
      formatToolUse("mcp__playwright__browser_fill_form", {
        fields: { username: "admin", role: "qa" },
      })
    ).toBe("📝 Filling form: username, role");
  });

  it("formats waiting for elements / assertions", () => {
    expect(formatToolUse("mcp__playwright__browser_wait_for", { text: "Dashboard loaded" })).toBe(
      "⏳ Waiting for: Dashboard loaded"
    );
  });

  it("formats screenshots and snapshots", () => {
    expect(formatToolUse("mcp__playwright__browser_take_screenshot", {})).toBe(
      "📸 Capturing viewport screenshot..."
    );
    expect(formatToolUse("mcp__playwright__browser_snapshot", {})).toBe(
      "👁️ Inspecting page DOM snapshot"
    );
  });

  it("labels the session reading saved files as that, not as a browser action", () => {
    expect(formatToolUse("Read", { file_path: "C:\\ws\\authoring\\mcp\\snap-home.md" })).toBe(
      "📄 Reading saved file: snap-home.md"
    );
    expect(formatToolUse("Grep", { pattern: "Delete", path: "C:\\ws\\mcp" })).toBe(
      "🔎 Searching saved files for: Delete"
    );
  });

  it("formats unrecognised browser tools gracefully", () => {
    expect(formatToolUse("mcp__playwright__browser_custom", {})).toBe(
      "🤖 Browser action: browser_custom"
    );
  });
});

describe("max turns handling in outcome", () => {
  it("recognises maximum number of turns reached as stuck", () => {
    const out = readAuthoringOutcome(
      "Error: Maximum number of turns (60) reached without stopping"
    );
    expect(out.kind).toBe("stuck");
    if (out.kind === "stuck") {
      expect(out.reason).toMatch(/turn limit/i);
    }
  });

  it("recognises max_turns_reached indicator as stuck", () => {
    const out = readAuthoringOutcome("Session ended with max_turns_reached");
    expect(out.kind).toBe("stuck");
  });
});

describe("buildPrompt credentials formatting", () => {
  it("formats credential keys with descriptions", () => {
    const prompt = buildPrompt({
      report: "Login fails with wrong credentials",
      targetName: "local",
      baseUrl: "http://localhost:3000",
      allowedOrigins: ["http://localhost:3000"],
      credentialNames: ["ACCOUNT_PHONE", "ACCOUNT_OTP"],
      credentialEntries: [
        { name: "ACCOUNT_PHONE", description: "Test account phone number" },
        { name: "ACCOUNT_OTP", description: "One-time verification code" },
      ],
    });

    expect(prompt).toContain("## Session Credentials & Variables");
    expect(prompt).toContain("- ACCOUNT_PHONE: Test account phone number");
    expect(prompt).toContain("- ACCOUNT_OTP: One-time verification code");
    expect(prompt).toContain("You MUST reference them strictly by their exact KEY NAME");
    expect(prompt).not.toContain("1111111170"); // Never leaks values
  });

  it("handles empty credentials gracefully", () => {
    const prompt = buildPrompt({
      report: "No credentials test",
      targetName: "local",
      baseUrl: "http://localhost:3000",
      allowedOrigins: [],
      credentialNames: [],
    });

    expect(prompt).toContain("No credentials were supplied. Ask if the flow needs one.");
  });
});

describe("revising the plan before anything opens a browser", () => {
  it("adds nothing to a first planning turn beyond the offer to ask", () => {
    const text = planRevisionSection({ previousPlan: "", thatsAll: false }).join("\n");
    expect(text).not.toContain("The plan you wrote last time");
    expect(text).toContain("AUTHORING: QUESTION");
  });

  it("carries the previous plan and the operator's answer into the next turn", () => {
    const text = planRevisionSection({
      previousPlan: "1. Open /search",
      answer: "use the QA account",
      thatsAll: false,
    }).join("\n");
    expect(text).toContain("1. Open /search");
    expect(text).toContain("use the QA account");
  });

  it('after "That\'s all I know", forbids another question and asks for the gaps to be marked', () => {
    const text = planRevisionSection({ previousPlan: "1. Open /search", thatsAll: true }).join(
      "\n"
    );
    expect(text).toContain("Do not ask anything");
    expect(text).toContain("???");
    expect(text).not.toContain("you may end with AUTHORING: QUESTION");
  });

  it("numbers the current plan one past the versions kept beside it", () => {
    const dir = mkdtempSync(join(tmpdir(), "plan-versions-"));
    try {
      const planPath = join(dir, "plan.md");
      expect(planVersionOf(planPath)).toBe(1);
      writeFileSync(join(dir, "plan.v1.md"), "old");
      writeFileSync(join(dir, "plan.v2.md"), "older");
      expect(planVersionOf(planPath)).toBe(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
