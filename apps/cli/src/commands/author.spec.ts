import { describe, it, expect } from "vitest";
import { deriveTitleForTest, readAuthoringOutcome } from "./author.js";

/**
 * Reading how an authoring session ended (ADR-0027).
 *
 * A single sentinel line rather than a schema, because Sonnet driving a browser does not need a
 * validator adjudicating each step — the harness only needs to know which of three things
 * happened. The parsing still has to be strict about one thing: never reading an unrecognised
 * ending as success, because "done" is what causes a script to be emitted.
 */

describe("recognising the ending", () => {
  it("reads DONE", () => {
    expect(readAuthoringOutcome("I reproduced it.\n\nAUTHORING: DONE")).toEqual({ kind: "done" });
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
