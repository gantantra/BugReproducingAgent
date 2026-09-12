import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Redactor } from "./redaction.js";

/**
 * Masking the operator's own credential values.
 *
 * The policy cannot describe these. A test account's OTP is six digits and its password is
 * arbitrary text, so no regex separates either from ordinary page content — which is exactly why
 * supplying a credential used to be refused rather than supported. Identity matching closes that
 * gap: once the operator has told the agent to type a value into a page, that value is masked on
 * the way back out of every scope, because we know the string rather than guessing its shape.
 */

function redactor(): Redactor {
  const root = resolve(__dirname, "..", "..", "..");
  return Redactor.fromString(readFileSync(resolve(root, "policies", "default.yaml"), "utf8"));
}

describe("operator credential values", () => {
  it("does nothing until values are registered", () => {
    const r = redactor();
    expect(r.redactField("dom.text", "the code is 481902").value).toBe("the code is 481902");
  });

  it("masks a registered value wherever it surfaces", () => {
    const r = redactor();
    r.maskValues(["481902", "Tr0ub4dor&3"]);
    // A six-digit OTP in a DOM snapshot is the case the policy provably cannot catch.
    const out = r.redactField("dom.text", "Your code is 481902, enter it now");
    expect(out.value).not.toContain("481902");
    expect(out.ruleId).toBe("operator-credential-value");
    expect(r.redactField("console.text", "login failed for Tr0ub4dor&3").value).not.toContain(
      "Tr0ub4dor"
    );
  });

  it("covers every scope, including ones the policy leaves alone", () => {
    const r = redactor();
    r.maskValues(["Tr0ub4dor&3"]);
    for (const scope of ["dom.text", "console.text", "action.inputValue", "report.body"] as const) {
      expect(r.redactField(scope, `value=Tr0ub4dor&3`).value, scope).not.toContain("Tr0ub4dor");
    }
  });

  it("masks the longer credential first when one contains another", () => {
    // Masking the short one first would leave the remainder of a real secret on disk.
    const r = redactor();
    r.maskValues(["pass", "password123"]);
    expect(r.redactField("dom.text", "password123").value).not.toContain("word123");
  });

  it("ignores values too short to be a credential", () => {
    // Masking every "1" in every artifact would destroy the evidence this product collects.
    const r = redactor();
    r.maskValues(["1", "ok"]);
    expect(r.redactField("dom.text", "1 result ok").value).toBe("1 result ok");
  });

  it("leaves ordinary evidence intact", () => {
    const r = redactor();
    r.maskValues(["481902"]);
    expect(r.redactField("dom.text", "cartCount=3").value).toBe("cartCount=3");
  });

  it("does not change the policy hash", () => {
    // The stamp records which POLICY ran and must stay comparable across machines. What values a
    // given operator registered is local, and hashing them into a published stamp would itself
    // be a disclosure.
    const r = redactor();
    const before = r.policyHash;
    r.maskValues(["Tr0ub4dor&3"]);
    expect(r.policyHash).toBe(before);
    expect(JSON.stringify(r.policy)).not.toContain("Tr0ub4dor");
  });
});
