import { describe, it, expect } from "vitest";
import { readDescribedSelector } from "./action-interpreter.js";
import { isOriginAllowed, shouldBlockDestructiveExecution } from "./destructive-classifier.js";

/**
 * The two guards that stopped a run for reasons that were not protecting anything.
 *
 * Both were written as refusals and both refused the normal case: a reporter who described a
 * control in words, and a site that redirects to its own login host. The replacements are narrow,
 * so these tests are mostly about what they still refuse.
 */

describe("reading a described control", () => {
  it("splits a phrase into the role and the label, the way English orders them", () => {
    expect(readDescribedSelector("the delete button")).toEqual({ role: "button", name: "delete" });
    expect(readDescribedSelector("the phone field")).toEqual({ role: "textbox", name: "phone" });
    expect(readDescribedSelector("the Verified filter")).toEqual({
      role: null,
      name: "Verified filter",
    });
  });

  it("keeps a bare label as the label", () => {
    expect(readDescribedSelector("Continue")).toEqual({ role: null, name: "Continue" });
  });

  it("drops the verb the reporter used to describe the interaction", () => {
    // "click the Save button" names a control, not an action to re-derive.
    expect(readDescribedSelector("click the Save button")).toEqual({
      role: "button",
      name: "Save",
    });
  });

  it("reports an empty name when the phrase is all filler and role", () => {
    // "the button" identifies nothing beyond its kind, and the locator says so rather than
    // matching whichever button happens to be first in the document.
    expect(readDescribedSelector("the button")).toEqual({ role: "button", name: "" });
  });

  it("is a pure function of the phrase, so a run is reproducible", () => {
    const once = readDescribedSelector("the Delete Account button");
    const twice = readDescribedSelector("the Delete Account button");
    expect(once).toEqual(twice);
    expect(once.name).toBe("Delete Account");
  });
});

describe("the origin allowlist", () => {
  const allowed = ["https://www.example.com"];

  it("accepts the origin itself", () => {
    expect(isOriginAllowed("https://www.example.com/cart", allowed)).toBe(true);
  });

  it("accepts a subdomain, because a site redirects to its own login host", () => {
    expect(isOriginAllowed("https://login.example.com/signin", allowed)).toBe(true);
    expect(isOriginAllowed("https://m.example.com/", allowed)).toBe(true);
  });

  it("accepts the apex when the allowlist named www, and the reverse", () => {
    // www-to-apex is the commonest redirect on the web, and the operator plainly named the site.
    expect(isOriginAllowed("https://example.com/cart", allowed)).toBe(true);
    expect(isOriginAllowed("https://www.example.com/", ["https://example.com"])).toBe(true);
  });

  it("still refuses a different site", () => {
    expect(isOriginAllowed("https://evil.com/", allowed)).toBe(false);
  });

  it("cannot be fooled by appending the allowed host to another domain", () => {
    // The check is on dot-delimited host boundaries, not a string suffix.
    expect(isOriginAllowed("https://example.com.attacker.net/", allowed)).toBe(false);
    expect(isOriginAllowed("https://notexample.com/", allowed)).toBe(false);
  });

  it("still refuses a protocol downgrade", () => {
    expect(isOriginAllowed("http://www.example.com/", allowed)).toBe(false);
  });

  it("still refuses a different port", () => {
    expect(isOriginAllowed("https://www.example.com:8443/", allowed)).toBe(false);
  });

  it("refuses something that is not a URL at all", () => {
    expect(isOriginAllowed("javascript:alert(1)", allowed)).toBe(false);
    expect(isOriginAllowed("not a url", allowed)).toBe(false);
  });
});

describe("the destructive flag governs every checkpoint", () => {
  // The bug this pins: the flag cleared enqueue and the approval acknowledgement, and the
  // executor refused anyway. Turning it off produced an approved batch that died on the first
  // delete, which read as a product problem rather than as a setting that had not taken effect.
  it("does not block the executor when the operator turned the flag off", () => {
    expect(
      shouldBlockDestructiveExecution({
        blockDestructiveActions: false,
        destructiveActionCount: 3,
        targetClassification: "test",
      })
    ).toBe(false);
  });

  it("blocks the executor when the flag is on and the target is not a fixture", () => {
    for (const targetClassification of ["test", "staging"] as const) {
      expect(
        shouldBlockDestructiveExecution({
          blockDestructiveActions: true,
          destructiveActionCount: 1,
          targetClassification,
        }),
        targetClassification
      ).toBe(true);
    }
  });

  it("never blocks a fixture target, which has no external state to protect", () => {
    expect(
      shouldBlockDestructiveExecution({
        blockDestructiveActions: true,
        destructiveActionCount: 5,
        targetClassification: "fixture",
      })
    ).toBe(false);
  });

  it("never blocks a sequence with no destructive actions", () => {
    expect(
      shouldBlockDestructiveExecution({
        blockDestructiveActions: true,
        destructiveActionCount: 0,
        targetClassification: "staging",
      })
    ).toBe(false);
  });
});
