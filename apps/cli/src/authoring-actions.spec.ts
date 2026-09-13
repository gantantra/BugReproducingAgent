import { describe, expect, it } from "vitest";

import { renderActionStatement, translateAuthoredSteps } from "./authoring-actions.js";

/**
 * The fixture is not invented. Every statement in `REAL_SESSION` was taken verbatim out of the
 * MCP transcripts under `repro-workspace/sessions/`, produced by authoring sessions driven
 * against a real production site. Writing plausible-looking statements instead would have tested
 * the translator against the grammar I imagined rather than the one Playwright MCP emits — and
 * the two differ: nothing I would have written by hand contained
 * `.filter({ hasText: ... }).nth(5)`, which is the form that forced a schema change.
 */
const REAL_SESSION = [
  "await page.goto('https://www.99acres.com');",
  "await page.locator('div').filter({ hasText: 'CONTACT US Toll Free | 9:30' }).nth(5).click();",
  "await new Promise(f => setTimeout(f, 3 * 1000));",
  "await page.locator('div').filter({ hasText: 'CONTACT US Toll Free | 9:30' }).nth(5).hover();",
  "await page.goto('https://www.99acres.com/createNewPassword');",
  "await page.getByRole('textbox').nth(2).fill('TestPass123');",
  "await page.getByRole('textbox').nth(3).fill('TestPass123');",
  "await page.getByRole('button', { name: 'Create New Password' }).click();",
];

/** Exactly as MCP emits it: a comment naming an absolute path, then a multi-line call. */
const REAL_SCREENSHOT = [
  "// Screenshot viewport and save it as repro-workspace\\sessions\\2026-09-12T23-18-51Z-279cbc\\.investigator\\investigations\\INV-002\\authoring\\mcp\\page.png",
  "await page.screenshot({",
  "  path: 'repro-workspace\\\\sessions\\\\2026-09-12T23-18-51Z-279cbc\\\\page.png',",
  "  scale: 'css',",
  "  type: 'png'",
  "});",
].join("\n");

function ok(r: ReturnType<typeof translateAuthoredSteps>) {
  if (!r.ok) throw new Error(`expected translation to succeed, refused: ${r.reason}`);
  return r;
}

describe("translating a real authoring session into executable actions", () => {
  it("translates every statement the real session produced", () => {
    const r = ok(translateAuthoredSteps(REAL_SESSION));
    expect(r.actions.map((a) => a.action.type)).toEqual([
      "goto",
      "click",
      "waitForTimeout",
      "hover",
      "goto",
      "fill",
      "fill",
      "click",
    ]);
  });

  it("carries `.filter({ hasText })` and `.nth()` through in Playwright's own order", () => {
    const r = ok(translateAuthoredSteps(REAL_SESSION));
    const click = r.actions[1]!.action as unknown as Record<string, unknown>;
    expect(click["selector"]).toEqual({
      strategy: "css",
      value: "div",
      filterHasText: "CONTACT US Toll Free | 9:30",
      nth: 5,
    });
  });

  it("reads a role selector that has an nth but no accessible name", () => {
    const r = ok(translateAuthoredSteps(REAL_SESSION));
    const fill = r.actions[5]!.action as unknown as Record<string, unknown>;
    expect(fill["selector"]).toEqual({ strategy: "role", role: "textbox", nth: 2 });
  });

  it("folds the sleep idiom into waitForTimeout", () => {
    const r = ok(translateAuthoredSteps(REAL_SESSION));
    const sleep = r.actions[2]!.action as unknown as Record<string, unknown>;
    expect(sleep["ms"]).toBe(3000);
  });

  it("numbers actions from zero, so an approval hashes a stable document", () => {
    const r = ok(translateAuthoredSteps(REAL_SESSION));
    expect(r.actions.map((a) => a.action.actionId)).toEqual([
      "A0",
      "A1",
      "A2",
      "A3",
      "A4",
      "A5",
      "A6",
      "A7",
    ]);
  });

  it("gives two translations of the same input the same ids", () => {
    // Guards the counter against being module-level state: a second call in the same process
    // must not continue numbering where the first stopped.
    const a = ok(translateAuthoredSteps(REAL_SESSION));
    const b = ok(translateAuthoredSteps(REAL_SESSION));
    expect(b.actions.map((x) => x.action.actionId)).toEqual(
      a.actions.map((x) => x.action.actionId)
    );
  });
});

describe("statements that are the tool's bookkeeping rather than the flow", () => {
  it("drops MCP's own screenshot, naming why, and never keeps its absolute path", () => {
    const r = ok(translateAuthoredSteps([...REAL_SESSION, REAL_SCREENSHOT]));
    expect(r.dropped).toHaveLength(1);
    expect(r.dropped[0]!.why).toMatch(/screenshot/i);
    expect(JSON.stringify(r.actions)).not.toContain("repro-workspace");
  });

  it("does not let a comment's contents reach the actions", () => {
    const r = ok(translateAuthoredSteps(["// go to the site\nawait page.goto('https://x.test');"]));
    expect(r.actions).toHaveLength(1);
    expect(JSON.stringify(r.actions)).not.toContain("go to the site");
  });
});

describe("secrets never reach a persisted proposal", () => {
  it("emits a secretRef carrying the variable name, not the value", () => {
    const r = ok(
      translateAuthoredSteps(REAL_SESSION, {
        secretsByValue: new Map([["TestPass123", "ACCOUNT_PASSWORD"]]),
      })
    );
    const fill = r.actions[5]!.action as unknown as Record<string, unknown>;
    expect(fill["value"]).toEqual({ kind: "secretRef", envVar: "ACCOUNT_PASSWORD" });
    expect(JSON.stringify(r.actions)).not.toContain("TestPass123");
  });

  it("keeps a value that is not a supplied credential as a literal", () => {
    const r = ok(translateAuthoredSteps(["await page.getByRole('textbox').fill('Mumbai');"]));
    const fill = r.actions[0]!.action as unknown as Record<string, unknown>;
    expect(fill["value"]).toEqual({ kind: "literal", literal: "Mumbai" });
  });
});

describe("the round trip is what makes the translation trustworthy", () => {
  it("renders every translated action back to the statement it came from", () => {
    const r = ok(translateAuthoredSteps(REAL_SESSION));
    for (const { action, statement } of r.actions) {
      // The sleep is the one exception: it is not a page call, so it cannot render back to the
      // `new Promise` idiom. It carries a single integer and no selector, so the mistranslation
      // this check exists to catch — picking a different element — is not reachable for it.
      if (action.type === "waitForTimeout") continue;
      expect(renderActionStatement(action)).toBe(statement);
    }
  });

  it("preserves a selector containing quotes, commas and braces", () => {
    const tricky = `await page.getByText('a, b) {c}').click();`;
    const r = ok(translateAuthoredSteps([tricky]));
    expect(renderActionStatement(r.actions[0]!.action)).toBe(tricky);
  });
});

describe("refusing rather than guessing", () => {
  it("refuses a locator option that changes which element matches", () => {
    // `checked` is a real getByRole option and a real behavioural difference. Silently dropping
    // it would select a different control and measure the wrong flow.
    const r = translateAuthoredSteps([
      "await page.getByRole('checkbox', { name: 'Agree', checked: true }).click();",
    ]);
    expect(r.ok).toBe(false);
  });

  it("refuses `.has()` because a nested locator cannot be carried", () => {
    const r = translateAuthoredSteps([
      "await page.locator('li').filter({ has: page.locator('img') }).click();",
    ]);
    expect(r.ok).toBe(false);
  });

  it("refuses a verb outside the vocabulary", () => {
    const r = translateAuthoredSteps(["await page.getByRole('button').dragTo(other);"]);
    expect(r.ok).toBe(false);
  });

  it("refuses a value that is not a constant", () => {
    const r = translateAuthoredSteps(["await page.getByRole('textbox').fill(password);"]);
    expect(r.ok).toBe(false);
  });

  it("refuses a sleep whose duration is computed", () => {
    const r = translateAuthoredSteps(["await new Promise(f => setTimeout(f, delay * 1000));"]);
    expect(r.ok).toBe(false);
  });

  it("refuses the whole translation, not just the bad step", () => {
    // A proposal missing one step from the middle is not a shorter version of the flow, it is a
    // different flow — and it would still run, and still report a pass rate.
    const r = translateAuthoredSteps([
      "await page.goto('https://x.test');",
      "await page.getByRole('button').dragTo(other);",
      "await page.getByRole('button', { name: 'Save' }).click();",
    ]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.statement).toContain("dragTo");
  });

  it("refuses an empty session rather than emitting an empty experiment", () => {
    expect(translateAuthoredSteps([]).ok).toBe(false);
  });
});

describe("the assertion the measurability gate requires", () => {
  it("translates a waitFor into the matching condition", () => {
    const r = ok(
      translateAuthoredSteps([
        "await page.getByText('Password updated').waitFor({ state: 'visible' });",
      ])
    );
    const a = r.actions[0]!.action as unknown as Record<string, unknown>;
    expect(a["type"]).toBe("waitFor");
    expect(a["condition"]).toBe("selectorVisible");
  });

  it("translates the textGone form into selectorHidden", () => {
    const r = ok(
      translateAuthoredSteps(["await page.getByText('Saving').waitFor({ state: 'hidden' });"])
    );
    const a = r.actions[0]!.action as unknown as Record<string, unknown>;
    expect(a["condition"]).toBe("selectorHidden");
  });
});
