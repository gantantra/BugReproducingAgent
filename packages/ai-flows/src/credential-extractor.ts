import type { LlmProvider } from "@investigator/ai-gateway";
import type { ModelAlias } from "@investigator/core";
import { randomUUID } from "node:crypto";

export interface ExtractedCredential {
  name: string;
  value: string;
  description: string;
}

export interface ExtractionResult {
  extracted: ExtractedCredential[];
  remainingText: string;
  /**
   * The operator's whole message with each extracted value replaced by its key name.
   *
   * This, not a list of what was extracted, is what the model is given. A reply routinely carries
   * more than the one value that was asked for -- the OTP along with the phone number, where to
   * find the control, a correction to the plan -- and none of it may be lost on the way. A real
   * session lost "use mobile web only / enter from profile icon only" that way.
   */
  referencedText: string;
}

const CREDENTIAL_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;

type Span = { raw: string; name: string };

/** Replace every extracted value, as it appeared and as it was stored, with its key name. */
function referenceValues(text: string, spans: readonly Span[]): string {
  return [...spans]
    .filter((s) => s.raw.length > 0)
    .sort((a, b) => b.raw.length - a.raw.length)
    .reduce((acc, s) => acc.split(s.raw).join(s.name), text);
}

/**
 * Extract credentials and test parameters from user input.
 * Attempts LLM-based structured extraction first, and falls back to robust deterministic parsing.
 */
export async function extractCredentials(
  text: string,
  context?: {
    question?: string;
    llmProvider?: LlmProvider;
    modelAlias?: ModelAlias;
  }
): Promise<ExtractionResult> {
  const trimmed = (text || "").trim();
  if (!trimmed) {
    return { extracted: [], remainingText: "", referencedText: "" };
  }

  // If an LLM provider is available, attempt dynamic structured extraction
  if (context?.llmProvider) {
    try {
      const llmResult = await extractWithLlm(
        trimmed,
        context.question,
        context.llmProvider,
        context.modelAlias
      );
      if (llmResult.extracted.length > 0) {
        return llmResult;
      }
    } catch {
      // Fall through to deterministic extraction on LLM failure or timeout
    }
  }

  return extractDeterministic(trimmed, context?.question);
}

/**
 * Structured LLM extraction for natural language responses containing credentials.
 */
async function extractWithLlm(
  text: string,
  question: string | undefined,
  provider: LlmProvider,
  modelAlias?: ModelAlias
): Promise<ExtractionResult> {
  const systemPrompt = [
    "You are a test parameter and credential extractor.",
    "Your job is to identify test account credentials, phone numbers, OTPs, PINs, passwords, usernames, tokens, or custom test inputs from user messages.",
    "Rules:",
    "1. For each value, assign a clean, self-describing UPPER_SNAKE_CASE key name (e.g., SIGN_IN_PHONE, SIGN_IN_OTP, ACCOUNT_PASSWORD).",
    "2. Provide a concise 2-6 word description of what the key represents.",
    "3. Extract the exact value provided by the user, copied verbatim from the message.",
    "4. Instructions, choices, reasons and explanations are not values. Leave them out; they are passed on as written.",
    "5. Return ONLY a valid JSON array of objects with the following schema:",
    '   [ { "name": "KEY_NAME", "value": "raw_value", "description": "purpose" } ]',
    "6. If the input contains no credentials or parameters, return [].",
    "Do not include explanation, markdown formatting, or code fences around the JSON.",
  ].join("\n");

  const userPrompt = [
    question
      ? `Context question asked: "${question}"`
      : "Context: General bug reproduction session",
    `User message: "${text}"`,
  ].join("\n");

  const response = await provider.complete({
    alias: modelAlias ?? "FAST_MODEL",
    system: systemPrompt,
    messages: [{ role: "user", content: userPrompt }],
    temperature: 0.0,
    maxTokens: 1000,
    timeoutMs: 15_000,
    requestId: randomUUID(),
  });

  const raw = (response.rawText || "").trim().replace(/^```json\s*|^```\s*|```$/g, "");
  const parsed = JSON.parse(raw) as unknown;

  if (Array.isArray(parsed)) {
    const valid: ExtractedCredential[] = [];
    let remaining = text;
    for (const item of parsed) {
      if (
        item &&
        typeof item === "object" &&
        typeof item.name === "string" &&
        CREDENTIAL_NAME.test(item.name) &&
        typeof item.value === "string" &&
        item.value.trim().length > 0 &&
        // A value the operator did not type is not theirs to store, whatever the model proposes.
        text.includes(item.value.trim())
      ) {
        valid.push({
          name: item.name,
          value: item.value.trim(),
          description:
            typeof item.description === "string" ? item.description.trim() : "Session parameter",
        });
        remaining = remaining.replace(item.value, " ");
      }
    }
    if (valid.length > 0) {
      return {
        extracted: valid,
        remainingText: remaining.replace(/\s+/g, " ").trim(),
        referencedText: referenceValues(
          text,
          valid.map((v) => ({ raw: v.value, name: v.name }))
        ),
      };
    }
  }

  return { extracted: [], remainingText: text, referencedText: text };
}

/**
 * Deterministic parsing supporting arbitrary phone numbers (including synthetic 10-digit test numbers),
 * OTPs, passwords, labelled tokens, and question context.
 *
 * It errs toward passing text on. Whatever is extracted is hidden from the model behind a key name,
 * so a word wrongly taken for a secret is an instruction the model never reads -- which is worse
 * than a test value it reads in the clear.
 */
export function extractDeterministic(text: string, question?: string): ExtractionResult {
  const found: ExtractedCredential[] = [];
  const spans: Span[] = [];
  let rest = text;
  const q = question || "";

  // 1. Explicitly labelled key-value pairs (e.g. "phone: 1111111170", "password is XYZ", "otp = 7982").
  // Bare "user", "login" and "pass" are ordinary words in a reply ("log in from the profile icon"),
  // so only their unambiguous forms label a value.
  const LABELLED = [
    {
      re: /\b(?:phone|mobile|cell(?:\s*number)?)\b\s*(?:is\b|[:=-])?\s*(\+?\d[\d -]{7,15}\d)/i,
      name: "ACCOUNT_PHONE",
      desc: "Phone number",
    },
    {
      re: /\b(?:otp|one.?time(?:\s*code|\s*pass|\s*password|\s*pin)?|passcode|pin)\b\s*(?:is\b|[:=-])?\s*(\d{4,8})\b/i,
      name: "ACCOUNT_OTP",
      desc: "One-time passcode",
    },
    {
      re: /\b(?:password|pwd)\b\s*(?:is\b|[:=-])?\s*([^\s,;]+)/i,
      name: "ACCOUNT_PASSWORD",
      desc: "Account password",
    },
    {
      re: /\b(?:email|mail)\b\s*(?:is\b|[:=-])?\s*([A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,255}\.[A-Za-z]{2,24})/i,
      name: "ACCOUNT_EMAIL",
      desc: "Account email",
    },
    {
      re: /\b(?:username|user\s*name|user\s*id|login\s*id)\b\s*(?:is\b|[:=-])?\s*([^\s,;]+)/i,
      name: "ACCOUNT_USERNAME",
      desc: "Account username",
    },
  ];

  for (const label of LABELLED) {
    const m = label.re.exec(rest);
    if (m && m[1]) {
      const val = m[1].replace(/^["']|["']$/g, "").trim();
      if (val.length > 0 && !found.some((f) => f.name === label.name)) {
        found.push({ name: label.name, value: val, description: label.desc });
        spans.push({ raw: m[1], name: label.name });
        rest = rest.replace(m[0], " ");
      }
    }
  }

  // 2. Variables the operator named themselves, in capitals (e.g. "TENANT_ID: abc-123", "ACCOUNT_CODE=XYZ").
  // A lowercase "note: tap twice" is prose, not a variable.
  const genericRe = /\b([A-Z][A-Z0-9_]{1,30})\s*[:=]\s*([^\s,;]+)/g;
  let gm: RegExpExecArray | null;
  while ((gm = genericRe.exec(rest)) !== null) {
    const rawKey = gm[1]!;
    const val = gm[2]!.trim();
    if (CREDENTIAL_NAME.test(rawKey) && val.length > 0 && !found.some((f) => f.name === rawKey)) {
      found.push({
        name: rawKey,
        value: val,
        description: `${rawKey.toLowerCase().replace(/_/g, " ")}`,
      });
      spans.push({ raw: gm[2]!, name: rawKey });
      rest = rest.replace(gm[0], " ");
    }
  }

  // 3. Shape recognition: email addresses
  const emailMatch = rest.match(/[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,255}\.[A-Za-z]{2,24}/);
  if (emailMatch && !found.some((f) => f.name === "ACCOUNT_EMAIL")) {
    found.push({ name: "ACCOUNT_EMAIL", value: emailMatch[0], description: "Account email" });
    spans.push({ raw: emailMatch[0], name: "ACCOUNT_EMAIL" });
    rest = rest.replace(emailMatch[0], " ");
  }

  // 4. Shape recognition: phone numbers (ANY 10 consecutive digits, or with country code, e.g. 1111111170)
  const phoneMatch = rest.match(/(?:\+\d{1,3}[- ]?)?\b\d{10}\b/);
  if (phoneMatch && !found.some((f) => f.name === "ACCOUNT_PHONE")) {
    found.push({
      name: "ACCOUNT_PHONE",
      value: phoneMatch[0].replace(/\s+/g, ""),
      description: "Phone number",
    });
    spans.push({ raw: phoneMatch[0], name: "ACCOUNT_PHONE" });
    rest = rest.replace(phoneMatch[0], " ");
  }

  // 5. Shape recognition: OTP / PIN (4 to 8 digits standalone), only when a code was asked for.
  // Otherwise "wait 5000 ms" or "floor 1204" would be hidden from the model as a passcode.
  if (/otp|one.?time|code|pin|passcode/i.test(q)) {
    const otpMatch = rest.match(/(?<!\d)\b\d{4,8}\b(?!\d)/);
    if (otpMatch && !found.some((f) => f.name === "ACCOUNT_OTP")) {
      found.push({ name: "ACCOUNT_OTP", value: otpMatch[0], description: "One-time passcode" });
      spans.push({ raw: otpMatch[0], name: "ACCOUNT_OTP" });
      rest = rest.replace(otpMatch[0], " ");
    }
  }

  // 6. A single bare value answering a question that asked for a credential ("Xy9#kLm2" to
  // "what password?"). Only a single token: a sentence is an answer to read, not a secret to hide,
  // even when the question mentioned a phone.
  const bare = rest.trim();
  if (found.length === 0 && bare.length > 0 && !/\s/.test(bare)) {
    const kind = /phone|mobile/i.test(q)
      ? { name: "ACCOUNT_PHONE", desc: "Phone number" }
      : /otp|one.?time|code|pin/i.test(q)
        ? { name: "ACCOUNT_OTP", desc: "One-time passcode" }
        : /password|passcode|pwd/i.test(q)
          ? { name: "ACCOUNT_PASSWORD", desc: "Account password" }
          : /username|user.?id|login/i.test(q)
            ? { name: "ACCOUNT_USERNAME", desc: "Account username" }
            : /e-?mail/i.test(q)
              ? { name: "ACCOUNT_EMAIL", desc: "Account email" }
              : /secret|token|api.?key|credential/i.test(q)
                ? { name: "ACCOUNT_SECRET", desc: "Session credential" }
                : null;
    if (kind) {
      found.push({ name: kind.name, value: bare, description: kind.desc });
      spans.push({ raw: bare, name: kind.name });
      rest = "";
    }
  }

  return {
    extracted: found,
    remainingText: rest.replace(/\s+/g, " ").trim(),
    referencedText: referenceValues(text, [
      ...spans,
      ...found.map((f) => ({ raw: f.value, name: f.name })),
    ]),
  };
}
