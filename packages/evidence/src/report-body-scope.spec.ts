import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Redactor } from "./redaction.js";

/**
 * What survives an operator's own bug report, and what does not.
 *
 * `report.body` is different in kind from every other scope in the policy. The others hold bytes
 * CAPTURED FROM a live application, where an email or a phone number belongs to a real customer
 * and masking it protects them. A report body is what an operator typed about a system they
 * control, and the identifiers in it are how the agent reaches the bug at all: the account to
 * sign in as, the order to open, the profile to visit.
 *
 * Masking those protected nobody and cost the product its job. A realistic report came through as
 * "the QA account [redacted] cannot see order [redacted]" — unreproducible — while the login OTP
 * beside it survived untouched, because no rule happened to match six bare digits. The rules were
 * removing what was needed and keeping what was dangerous.
 */

function redactor(): Redactor {
  const root = resolve(__dirname, "..", "..", "..");
  return Redactor.fromString(readFileSync(resolve(root, "policies", "default.yaml"), "utf8"));
}

const TOKEN_PARTS = ["eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiIxMjM0NTY3ODkwIn0", "dBjftJeZ4CVPmB92K27"];

describe("an operator's report keeps what reproduces the bug", () => {
  const r = redactor();

  it("keeps a test account's phone number", () => {
    const out = r.redactField("report.body", "Sign in as 9876543210 and open the orders page");
    expect(out.value).toContain("9876543210");
  });

  it("keeps a test account's email", () => {
    const out = r.redactField("report.body", "Sign in as qa.bot@corp.example");
    expect(out.value).toContain("qa.bot@corp.example");
  });

  it("keeps a long numeric identifier, even a card-shaped one", () => {
    // Order numbers, SKUs and reference ids are routinely 13-19 digits. The card rule was
    // removing them, and an order number is exactly what "open order X" needs.
    const out = r.redactField("report.body", "Order 4111111111111111 shows an empty page");
    expect(out.value).toContain("4111111111111111");
  });

  it("keeps a grouped identifier that happens to look like a government id", () => {
    const out = r.redactField("report.body", "Profile id 1234 5678 9012 has no photo");
    expect(out.value).toContain("1234 5678 9012");
  });

  it("leaves an ordinary report completely untouched", () => {
    const report = "On /search I type bearing and press Search. One time in three it shows none.";
    expect(r.redactField("report.body", report).value).toBe(report);
  });
});

describe("an operator's report still loses what is genuinely dangerous", () => {
  const r = redactor();

  it("masks a bearer token, which is never how a bug is reproduced", () => {
    const out = r.redactField("report.body", `Cookie: Bearer ${TOKEN_PARTS.join(".")}`);
    for (const part of TOKEN_PARTS) expect(out.value).not.toContain(part);
  });

  it("masks a secret pasted inside a URL's query", () => {
    const out = r.redactField(
      "report.body",
      "It happens at https://app.test/a?password=hunter2placeholder&x=1"
    );
    expect(out.value).not.toContain("hunter2placeholder");
  });

  it("masks a private key block", () => {
    const pem = ["-----BEGIN PRIVATE KEY-----", "AAAABBBBCCCCDDDD", "-----END PRIVATE KEY-----"];
    const out = r.redactField("report.body", `Config has ${pem.join("\n")}`);
    expect(out.value).not.toContain("AAAABBBBCCCCDDDD");
  });
});

describe("captured evidence is unchanged — that is someone else's data", () => {
  const r = redactor();

  it("still masks a phone number read off a live page", () => {
    // The distinction the whole change rests on: this number belongs to a customer, not to the
    // operator, and nothing about reproducing a bug requires keeping it.
    expect(r.redactField("dom.text", "Customer 9876543210").value).not.toContain("9876543210");
  });

  it("still removes an email from a response body", () => {
    // Dropped outright rather than masked — a response body is withheld wholesale, which is
    // stronger than masking and is why `value` is undefined here rather than a redacted string.
    const out = r.redactField(
      "network.responseBody",
      '{"email":"real.user@company-domain.example"}'
    );
    expect(out.value ?? "").not.toContain("real.user@company-domain.example");
  });

  it("still masks a card number in a console line", () => {
    expect(r.redactField("console.text", "paid 4111111111111111").value).not.toContain(
      "4111111111111111"
    );
  });
});
