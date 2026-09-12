import { describe, it, expect } from "vitest";
import { readAuthoringOutcome } from "./author.js";

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
