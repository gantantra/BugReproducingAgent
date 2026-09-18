import { describe, it, expect } from "vitest";
import {
  locatorOfStep,
  planOptionalBlocks,
  readOptionalScreens,
  renderAuthoredSpec,
  renderPlaywrightConfig,
  type AuthoredStep,
} from "./authoring-script.js";

/**
 * Screens that appear on some runs only, and time limits a real flow fits into.
 *
 * The statements are the real INV-001 script: a mobile sign-in that shows a sign-up form only when
 * the number has no account, followed by deleting the account. Replayed 30 times as one fixed path,
 * run 1 created the account and every later run waited for a sign-up form that never came.
 */

const step = (code: string, tool = "browser_click"): AuthoredStep => ({ code, tool });

const REAL = [
  step("await page.goto('https://www.99acres.com');", "browser_navigate"),
  step("await page.getByTestId('BOTTOM_TAB_ITEM_CONTAINER_menuTab').click();"),
  step("await page.getByTestId('LOGIN_BANNER').click();"),
  step("await page.getByTestId('LOGIN_BANNER_CTA_BUY_RESIDENTIAL').click();"),
  step(
    "await page.getByRole('spinbutton', { name: 'Phone Number' }).fill(process.env['ACCOUNT_PHONE']);",
    "browser_type"
  ),
  step("await page.getByTestId('primary-button').click();"),
  step(
    "await page.getByTestId('OTP_SCREEN_OTP1').fill(process.env['ACCOUNT_OTP']);",
    "browser_type"
  ),
  step("await page.locator('div').filter({ hasText: /^Verify$/ }).first().click();"),
  // The sign-up screen: only an unregistered number sees it.
  step(
    "await page.getByRole('textbox', { name: 'Full Name' }).fill(process.env['ACCOUNT_USERNAME']);",
    "browser_type"
  ),
  step("await page.getByTestId('No').click();"),
  step("await page.getByTestId('ContactAgreementCheckbox').getByLabel('checkbox').click();"),
  step("await page.locator('div').filter({ hasText: 'Continue' }).nth(5).click();"),
  step("await page.locator('text=\"Continue\"').click();"),
  // What the brief now asks for after a submit: proof the sign-in landed before navigating.
  step(
    "await page.getByText(\"My Profile\").first().waitFor({ state: 'visible' });",
    "browser_wait_for"
  ),
  step("await page.goto('https://www.99acres.com/profile/editProfile');", "browser_navigate"),
  step(
    'await page.locator(\'div[tabindex="0"]:has(img[src*="delete.shared.svg"]):not(:has(input))\').click();'
  ),
  step(
    "await page.locator('div').filter({ hasText: /^Yes, Please continue to delete$/ }).first().click();"
  ),
  step(
    "await page.getByText(\"Account has been deleted successfully!\").first().waitFor({ state: 'visible' });",
    "browser_wait_for"
  ),
];

describe("reading the declarations", () => {
  it("reads a screen and its action count", () => {
    const message = [
      "Deleted the account; the toast appeared.",
      'OPTIONAL: "Full Name" | 5',
      "AUTHORING: DONE",
    ].join("\n");
    expect(readOptionalScreens(message)).toEqual([{ trigger: "Full Name", actions: 5 }]);
  });

  it("tolerates the formatting a model wraps lines in, and ignores lines that are not declarations", () => {
    expect(
      readOptionalScreens(
        '**OPTIONAL: `Accept cookies` | 1**\nOPTIONAL: nothing here\nOPTIONAL: "x" | 0'
      )
    ).toEqual([{ trigger: "Accept cookies", actions: 1 }]);
  });
});

describe("placing a declared screen in the recording", () => {
  it("covers exactly the sign-up form's five actions", () => {
    const { blocks, refused } = planOptionalBlocks(REAL, [{ trigger: "Full Name", actions: 5 }]);
    expect(refused).toEqual([]);
    expect(blocks).toHaveLength(1);
    expect(REAL.slice(blocks[0]!.start, blocks[0]!.end).map((s) => s.code)).toEqual(
      REAL.slice(8, 13).map((s) => s.code)
    );
    expect(blocks[0]!.locator).toBe("page.getByRole('textbox', { name: 'Full Name' })");
  });

  it("refuses a block that would swallow a check or a navigation, and keeps those steps mandatory", () => {
    const { blocks, refused } = planOptionalBlocks(REAL, [{ trigger: "Full Name", actions: 7 }]);
    expect(blocks).toEqual([]);
    expect(refused[0]).toMatch(/Full Name.*navigation or a check.*stay mandatory/);
  });

  it("refuses a trigger that no recorded action mentions", () => {
    const { blocks, refused } = planOptionalBlocks(REAL, [{ trigger: "Rate us", actions: 1 }]);
    expect(blocks).toEqual([]);
    expect(refused[0]).toMatch(/Rate us.*no recorded action/);
  });

  it("finds the locator of an action and of a check, and none for a navigation", () => {
    expect(locatorOfStep(REAL[9]!.code)).toBe("page.getByTestId('No')");
    expect(locatorOfStep(REAL[13]!.code)).toBe('page.getByText("My Profile").first()');
    expect(locatorOfStep(REAL[0]!.code)).toBeNull();
  });
});

describe("the emitted script", () => {
  const spec = renderAuthoredSpec(REAL, {
    title: "Deleting the account shows no message",
    investigationId: "INV-001",
    authoredAt: "2026-09-15",
    optional: [{ trigger: "Full Name", actions: 5 }],
  });

  it("handles the sign-up form when it shows and skips it when the sign-in goes straight on", () => {
    expect(spec).toContain("const optional1 = page.getByRole('textbox', { name: 'Full Name' });");
    // Races the form against the step that follows it, so an existing account costs no fixed wait.
    expect(spec).toContain(
      'if (await optional1.or(page.getByText("My Profile").first()).first().waitFor({ state: "visible" }).then(() => optional1.isVisible(), () => false)) {'
    );
    expect(spec).toContain("      await page.getByTestId('No').click();");
  });

  it("keeps every other step exactly as recorded, in order", () => {
    const outside = spec.split("\n").filter((l) => /^ {4}await page\./.test(l));
    expect(outside[0]).toBe("    await page.goto('https://www.99acres.com');");
    expect(outside[outside.length - 1]).toBe(
      "    await page.getByText(\"Account has been deleted successfully!\").first().waitFor({ state: 'visible' });"
    );
  });

  it("gives a screen followed by a navigation a bounded wait instead of a race", () => {
    const withoutCheck = REAL.filter((s) => !s.code.includes("My Profile"));
    const s = renderAuthoredSpec(withoutCheck, {
      title: "t",
      investigationId: "INV-001",
      authoredAt: "2026-09-15",
      optional: [{ trigger: "Full Name", actions: 5 }],
    });
    expect(s).toContain(
      'if (await optional1.waitFor({ state: "visible", timeout: 10_000 }).then(() => true, () => false)) {'
    );
  });
});

describe("time limits a real flow fits into", () => {
  it("sizes the whole run to its steps, and still fails a single impossible step fast", () => {
    const config = renderPlaywrightConfig({ outputDir: "./artifacts", steps: REAL.length });
    // 30s + 10s × 18 steps. The old flat 15s cut every run of a 16-step flow off partway through.
    expect(config).toContain("timeout: 210_000,");
    expect(config).toContain("actionTimeout: 15_000,");
    expect(config).toContain("navigationTimeout: 30_000,");
  });
});
