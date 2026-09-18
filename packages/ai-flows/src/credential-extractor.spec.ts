import { describe, expect, it } from "vitest";
import { extractCredentials, extractDeterministic } from "./credential-extractor.js";
import type { LlmProvider, LlmResponse } from "@investigator/ai-gateway";

describe("extractDeterministic", () => {
  it("extracts phone and OTP from labeled text", () => {
    const res = extractDeterministic("Use phone: 1111111170 and otp: 7982 for signing in");
    expect(res.extracted).toEqual([
      { name: "ACCOUNT_PHONE", value: "1111111170", description: "Phone number" },
      { name: "ACCOUNT_OTP", value: "7982", description: "One-time passcode" },
    ]);
  });

  it("extracts synthetic test phone number starting with 1", () => {
    const res = extractDeterministic("1111111170");
    expect(res.extracted).toEqual([
      { name: "ACCOUNT_PHONE", value: "1111111170", description: "Phone number" },
    ]);
  });

  it("extracts custom key value pairs", () => {
    const res = extractDeterministic("TENANT_ID: acme-corp and PIN=4321");
    expect(res.extracted).toEqual([
      { name: "ACCOUNT_OTP", value: "4321", description: "One-time passcode" },
      { name: "TENANT_ID", value: "acme-corp", description: "tenant id" },
    ]);
  });

  it("infers key from question context when input is a bare value", () => {
    const resPhone = extractDeterministic("9999999999", "What phone number should I use?");
    expect(resPhone.extracted).toEqual([
      { name: "ACCOUNT_PHONE", value: "9999999999", description: "Phone number" },
    ]);

    const resOtp = extractDeterministic("1234", "Enter 4-digit OTP sent to phone");
    expect(resOtp.extracted).toEqual([
      { name: "ACCOUNT_OTP", value: "1234", description: "One-time passcode" },
    ]);

    const resPassword = extractDeterministic("Xy9#kLm2", "What password should I type?");
    expect(resPassword.extracted).toEqual([
      { name: "ACCOUNT_PASSWORD", value: "Xy9#kLm2", description: "Account password" },
    ]);
    expect(resPassword.referencedText).toBe("ACCOUNT_PASSWORD");
  });

  it("leaves a reason in the reply for the model to read, rather than hiding it as a secret", () => {
    // A reason is usually an option to pick on the page, and the model cannot pick an option it
    // is only given the name of.
    const res = extractDeterministic("not using this account", "What reason should I pick?");
    expect(res.extracted).toEqual([]);
    expect(res.referencedText).toBe("not using this account");
  });

  it("extracts multiple credentials without overwriting", () => {
    const res = extractDeterministic(
      "phone is 9876543210, password is SecretPass1!, and reason is 'closing'"
    );
    expect(res.extracted).toHaveLength(2);
    expect(res.extracted.find((c) => c.name === "ACCOUNT_PHONE")?.value).toBe("9876543210");
    expect(res.extracted.find((c) => c.name === "ACCOUNT_PASSWORD")?.value).toBe("SecretPass1!");
    expect(res.referencedText).toBe(
      "phone is ACCOUNT_PHONE, password is ACCOUNT_PASSWORD, and reason is 'closing'"
    );
  });
});

describe("the reply the model is given back", () => {
  it("keeps an instruction whole even when the question was about a phone number", () => {
    // Observed: this reply was stored as ACCOUNT_PHONE because the question mentioned a phone,
    // and the session never saw the instruction.
    const text = "use mobile web only\nand\nenter from profile icon only";
    const res = extractDeterministic(text, "Which phone number should I sign in with?");
    expect(res.extracted).toEqual([]);
    expect(res.referencedText).toBe(text);
  });

  it("passes on everything else in a reply that also carries credentials", () => {
    const res = extractDeterministic(
      "phone 1111111170 and otp is 7982, then open it from the profile icon, not the menu",
      "Which account should I use?"
    );
    expect(res.extracted.map((e) => e.name)).toEqual(["ACCOUNT_PHONE", "ACCOUNT_OTP"]);
    expect(res.referencedText).toBe(
      "phone ACCOUNT_PHONE and otp is ACCOUNT_OTP, then open it from the profile icon, not the menu"
    );
  });

  it("does not take ordinary words or numbers in a reply for secrets", () => {
    for (const text of [
      "login from the profile icon as the user is already signed in",
      "name: Priya Sharma",
      "note: tap twice",
      "wait 5000 ms after tapping delete",
    ]) {
      const res = extractDeterministic(text, "Anything else I should know?");
      expect(res.extracted, text).toEqual([]);
      expect(res.referencedText, text).toBe(text);
    }
  });

  it("does not store a one-word plan approval as a secret", () => {
    const res = extractDeterministic("yes", "plan");
    expect(res.extracted).toEqual([]);
    expect(res.referencedText).toBe("yes");
  });

  it("never leaves an extracted value in the text, however it was written", () => {
    const res = extractDeterministic("mobile +91 9876543210");
    const phone = res.extracted.find((c) => c.name === "ACCOUNT_PHONE");
    expect(phone).toBeDefined();
    expect(res.referencedText).not.toContain("9876543210");
  });
});

describe("extractCredentials with LLM", () => {
  it("uses LLM response when provider is available", async () => {
    const mockProvider: LlmProvider = {
      complete: async () =>
        ({
          rawText: JSON.stringify([
            { name: "SIGN_IN_PHONE", value: "1111111170", description: "Test mobile number" },
            { name: "SIGN_IN_OTP", value: "7982", description: "One-time verification code" },
          ]),
          raw: {},
        }) as LlmResponse,
    } as unknown as LlmProvider;

    const res = await extractCredentials("my test mobile 1111111170 and otp 7982", {
      llmProvider: mockProvider,
    });
    expect(res.extracted).toEqual([
      { name: "SIGN_IN_PHONE", value: "1111111170", description: "Test mobile number" },
      { name: "SIGN_IN_OTP", value: "7982", description: "One-time verification code" },
    ]);
    expect(res.referencedText).toBe("my test mobile SIGN_IN_PHONE and otp SIGN_IN_OTP");
  });

  it("drops a value the model proposed that the operator never typed", async () => {
    const mockProvider: LlmProvider = {
      complete: async () =>
        ({
          rawText: JSON.stringify([
            { name: "SIGN_IN_PHONE", value: "1111111170", description: "Test mobile number" },
            { name: "SIGN_IN_OTP", value: "0000", description: "Invented code" },
          ]),
          raw: {},
        }) as LlmResponse,
    } as unknown as LlmProvider;

    const res = await extractCredentials("my test mobile 1111111170", {
      llmProvider: mockProvider,
    });
    expect(res.extracted.map((e) => e.name)).toEqual(["SIGN_IN_PHONE"]);
  });

  it("falls back to deterministic if LLM throws", async () => {
    const failingProvider: LlmProvider = {
      complete: async () => {
        throw new Error("network timeout");
      },
    } as unknown as LlmProvider;

    const res = await extractCredentials("phone: 9876543210", {
      llmProvider: failingProvider,
    });
    expect(res.extracted).toEqual([
      { name: "ACCOUNT_PHONE", value: "9876543210", description: "Phone number" },
    ]);
  });
});
