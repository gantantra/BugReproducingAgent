import { describe, it, expect } from "vitest";
import { ERROR_CODES, ERROR_SPEC, fail, isInvestigatorError } from "@investigator/core";
import { classifyAction } from "./destructive-classifier.js";
import type { ActionSpec } from "./types.js";

/**
 * The `described` selector: the reporter's words for a control nobody has located yet.
 *
 * Playwright produces evidence. Deterministic software normalizes and measures evidence. DeepSeek interprets and prioritizes evidence. Humans authorize consequential transitions.
 *
 * It exists so an interpreted flow can say "the Verified filter" instead of inventing
 * `[data-testid=...]`. The value of that depends entirely on it being UNEXECUTABLE: a system that
 * quietly treated the phrase as a text selector would run something nobody chose and produce
 * evidence indistinguishable from evidence about the real control.
 *
 * Two places must refuse it, and both were reachable with no test before this file: the executor
 * (a run) and the suite generator (an exported script). The second was found only by running the
 * guided flow with a described selector, where it crashed the whole session.
 */

const described: ActionSpec = {
  actionId: "A2",
  type: "click",
  selector: { strategy: "described", value: "the Verified filter" },
};

describe("a described selector is classified like any other action", () => {
  it("does not escalate merely for being unresolved", () => {
    // Unresolved is not dangerous; it is unfinished. Conflating the two would push harmless
    // interpretations through the destructive-acknowledgement path for no reason.
    expect(classifyAction(described)).toBe("read");
  });

  it("still escalates when the reporter's own words describe a destructive control", () => {
    // The phrase is all the classifier has to go on, and "Delete account" is a warning whether or
    // not anyone has found the button yet.
    const deleteControl: ActionSpec = {
      actionId: "A7",
      type: "click",
      selector: { strategy: "described", value: "the Delete account button" },
    };
    expect(classifyAction(deleteControl)).toBe("destructive");
  });
});

describe("the refusal is a distinct, non-retryable error", () => {
  it("EXEC_VALUE_UNRESOLVED is registered and never retried", () => {
    // Distinct from EXEC_ACTION_FAILED on purpose: a selector that did not match is a fact about
    // the page, while a selector that was never resolved is a gap in the approved sequence. Only
    // the first is worth looking at the application for.
    expect(ERROR_CODES).toContain("EXEC_VALUE_UNRESOLVED");

    // Retrying cannot help. The sequence is unfinished, and that is a human decision surfaced at
    // the gate, not an infrastructure hiccup to paper over with another attempt.
    expect(ERROR_SPEC["EXEC_VALUE_UNRESOLVED"].retryable).toBe(false);
  });

  it("carries the described text so the message names what to fix", () => {
    let err: unknown;
    try {
      fail(
        "EXEC_VALUE_UNRESOLVED",
        'Selector is still described in prose ("the Verified filter")',
        {
          context: { strategy: "described", described: "the Verified filter" },
        }
      );
    } catch (e) {
      err = e;
    }
    expect(isInvestigatorError(err)).toBe(true);
    const e = err as { code: string; message: string; context?: Record<string, unknown> };
    expect(e.code).toBe("EXEC_VALUE_UNRESOLVED");
    // A message saying only "selector failed" would send someone hunting through the application
    // for a control that was never specified.
    expect(e.message).toContain("the Verified filter");
    expect(e.context?.["described"]).toBe("the Verified filter");
  });
});
