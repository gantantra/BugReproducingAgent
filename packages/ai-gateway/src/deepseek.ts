import { fail, sha256Prefixed, type ModelAlias, type Secret } from "@investigator/core";
import type { SecretStore } from "@investigator/storage";
import type { LlmProvider, LlmRequest, LlmResponse, ModelCapabilities, ToolCall } from "./index.js";
import { classifyProviderFailure, type Classification } from "./errors.js";

/**
 * DeepSeek adapter (ADR-0009, docs/architecture/deepseek-adapter.md).
 *
 * Playwright produces evidence. Deterministic software normalizes and measures evidence. DeepSeek interprets and prioritizes evidence. Humans authorize consequential transitions.
 *
 * `fetch` only, no SDK. An SDK would bring its own retry policy, its own error taxonomy and its
 * own idea of what a timeout is, and every one of those is specified here — ADR-0009 requires the
 * policy to be ours and legible, not inherited.
 *
 * Secret handling, which is the part worth reading twice:
 *
 *  - The key is read from the `SecretStore` at the moment of dispatch and bound into a single
 *    header object. It is never stored on the instance, never interpolated into a URL, never
 *    placed in an error, and never returned.
 *  - Every error path constructs its message from the STATUS and a truncated body that has been
 *    scrubbed of anything key-shaped, because providers do sometimes echo a credential back.
 *  - Nothing here logs. The caller records a ledger row from typed fields only.
 *
 * Model IDs and the base URL are config-driven and resolved by the caller; this adapter never
 * guesses a model name or an endpoint (ADR-0009, and a hard rule in CLAUDE.md).
 */

export interface DeepSeekAdapterOptions {
  /** Fully resolved. The adapter never constructs or defaults an endpoint. */
  baseUrl: string;
  apiKeyEnv: string;
  secrets: SecretStore;
  /** alias -> concrete model id, already resolved from config. */
  models: Record<ModelAlias, { modelId: string; inferenceMode: string }>;
  /** Injected so tests drive the transport without a network. */
  fetchImpl?: typeof fetch;
  /** Capabilities supplied by the caller (probe result plus config narrowing). */
  capabilityLookup?: (alias: ModelAlias) => Promise<ModelCapabilities>;
  adapterVersion?: string;
}

export class ProviderCallError extends Error {
  constructor(
    readonly classification: Classification,
    readonly status: number,
    readonly attemptBody: string
  ) {
    super(`${classification.errorClass}: ${classification.detail}`);
    this.name = "ProviderCallError";
  }
}

/** Anything that looks like a credential is removed before a body is ever quoted back. */
export function scrubBody(body: string, maxLength = 600): string {
  return body
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, "sk-[redacted]")
    .replace(/Bearer\s+[A-Za-z0-9._-]{8,}/gi, "Bearer [redacted]")
    .replace(/"(api_?key|authorization|token|secret)"\s*:\s*"[^"]*"/gi, '"$1":"[redacted]"')
    .slice(0, maxLength);
}

export const DEFAULT_CAPABILITIES: ModelCapabilities = {
  jsonMode: "unknown",
  toolCalls: "unknown",
  thinkingMode: "unknown",
  // Conservative documented-unknown defaults. Budgets are enforced by our own token accounting
  // rather than by trusting a limit we never verified.
  contextWindow: 32_000,
  maxOutputTokens: 4_096,
};

interface ChatCompletionChoice {
  message?: {
    content?: string | null;
    tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>;
  };
  finish_reason?: string;
}

interface ChatCompletionBody {
  model?: string;
  choices?: ChatCompletionChoice[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  system_fingerprint?: string;
}

export class DeepSeekProvider implements LlmProvider {
  readonly providerName = "deepseek";
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: DeepSeekAdapterOptions) {
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    if (!this.fetchImpl) {
      fail("INTERNAL", "No fetch implementation available for the DeepSeek adapter");
    }
  }

  modelFor(alias: ModelAlias): { modelId: string; inferenceMode: string } {
    const entry = this.opts.models[alias];
    if (!entry?.modelId) {
      // Never substitute. A missing alias is a configuration error, not an invitation to pick.
      fail("CONFIG_INVALID", `Model alias ${alias} is not configured`, { context: { alias } });
    }
    return entry;
  }

  async capabilities(alias: ModelAlias): Promise<ModelCapabilities> {
    if (this.opts.capabilityLookup) return this.opts.capabilityLookup(alias);
    return { ...DEFAULT_CAPABILITIES };
  }

  /**
   * One attempt. Retries, backoff and the breaker live in the gateway, so that the policy applies
   * identically to every provider rather than being reimplemented per adapter.
   */
  async complete(req: LlmRequest): Promise<LlmResponse> {
    const { modelId, inferenceMode } = this.modelFor(req.alias);
    const capabilities = await this.capabilities(req.alias);
    const warnings: string[] = [];

    const body: Record<string, unknown> = {
      model: modelId,
      messages: [
        { role: "system", content: req.system },
        ...req.messages.map((m) => ({
          role: m.role,
          content: m.content,
          ...(m.toolCallId ? { tool_call_id: m.toolCallId } : {}),
          ...(m.name ? { name: m.name } : {}),
        })),
      ],
      max_tokens: req.maxTokens,
      temperature: req.temperature,
      stream: false,
    };

    // Structured output is requested only where the capability is actually supported. Where it is
    // not, the prompt contract carries the requirement and the response is extracted strictly --
    // the agent never pretends a capability exists (the degradation matrix).
    if (req.responseSchema) {
      if (capabilities.jsonMode === "supported") {
        body["response_format"] = { type: "json_object" };
      } else {
        warnings.push("JSON_MODE_UNAVAILABLE");
      }
    }

    if (req.tools?.length) {
      // A probe is the one request that must send tools without knowing whether they work: that
      // is the observation it exists to make. Gating it on the answer made the question
      // unanswerable, and left every tool-using flow permanently refused.
      if (capabilities.toolCalls === "supported" || req.probe === true) {
        body["tools"] = req.tools.map((t) => ({
          type: "function",
          function: { name: t.name, description: t.description, parameters: t.parameters },
        }));
      } else {
        // Refusing is correct: silently dropping the tools would make the model answer from
        // nothing and look like it had consulted evidence.
        fail(
          "AI_CAPABILITY_MISSING",
          `Tool calling is ${capabilities.toolCalls} for ${modelId}; a tool-using flow cannot run`,
          { context: { modelId, toolCalls: capabilities.toolCalls } }
        );
      }
    }

    const key: Secret = await this.opts.secrets.reveal(this.opts.apiKeyEnv);
    const startedAt = Date.now();

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.opts.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          // `use` hands the plaintext to this callback and nowhere else: it is never assigned to
          // a variable that outlives the header object.
          authorization: key.use((k) => `Bearer ${k}`),
          "user-agent": `ReproAgent/${this.opts.adapterVersion ?? "0.1.0"}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(req.timeoutMs),
      });
    } catch (e) {
      const err = e as { name?: string; code?: string };
      throw new ProviderCallError(
        classifyProviderFailure({ status: 0, code: err.code ?? err.name ?? "" }),
        0,
        ""
      );
    }

    const text = await response.text();
    const headers: Record<string, string> = {};
    response.headers.forEach((v, k) => {
      headers[k.toLowerCase()] = v;
    });

    if (!response.ok) {
      throw new ProviderCallError(
        classifyProviderFailure({ status: response.status, body: text, headers }),
        response.status,
        scrubBody(text)
      );
    }

    let parsedBody: ChatCompletionBody;
    try {
      parsedBody = JSON.parse(text) as ChatCompletionBody;
    } catch {
      throw new ProviderCallError(
        {
          errorClass: "INVALID_OUTPUT",
          retryable: false,
          retryAfterSeconds: null,
          detail: "provider returned a body that is not JSON",
          permanentInputProblem: false,
        },
        response.status,
        scrubBody(text)
      );
    }

    // A 200 that carries an auth or rate-limit error in the body is still that error. Classifying
    // on status alone would make it look like a malformed response.
    const bodyClassification = classifyProviderFailure({ status: 200, body: text, headers });
    if (
      bodyClassification.errorClass === "AUTH" ||
      bodyClassification.errorClass === "RATE_LIMIT"
    ) {
      throw new ProviderCallError(bodyClassification, response.status, scrubBody(text));
    }

    const choice = parsedBody.choices?.[0];
    const rawText = choice?.message?.content ?? "";
    const toolCalls: ToolCall[] = (choice?.message?.tool_calls ?? []).map((tc, i) => ({
      id: tc.id ?? `call_${i}`,
      name: tc.function?.name ?? "",
      arguments: safeParseArguments(tc.function?.arguments),
    }));

    return {
      rawText,
      ...(toolCalls.length ? { toolCalls } : {}),
      usage: {
        promptTokens: parsedBody.usage?.prompt_tokens ?? 0,
        completionTokens: parsedBody.usage?.completion_tokens ?? 0,
        totalTokens: parsedBody.usage?.total_tokens ?? 0,
      },
      provider: this.providerName,
      modelId: parsedBody.model ?? modelId,
      ...(parsedBody.system_fingerprint ? { modelVersion: parsedBody.system_fingerprint } : {}),
      inferenceMode,
      latencyMs: Date.now() - startedAt,
      finishReason: choice?.finish_reason ?? "unknown",
      warnings,
    };
  }
}

/**
 * Tool arguments arrive as a JSON STRING. A malformed one is returned as a structured marker
 * rather than thrown: the flow's validation layer rejects it with a typed error and can spend its
 * one repair attempt, which is more useful than a transport-level crash.
 */
function safeParseArguments(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : { __invalid: raw.slice(0, 200) };
  } catch {
    return { __invalid: raw.slice(0, 200) };
  }
}

/** Stable content hash for the ledger, over the request as sent minus anything secret. */
export function requestContentHash(req: LlmRequest): string {
  return sha256Prefixed(
    JSON.stringify({
      alias: req.alias,
      system: req.system,
      messages: req.messages,
      responseSchema: req.responseSchema ?? null,
      tools: req.tools?.map((t) => t.name) ?? [],
      maxTokens: req.maxTokens,
      temperature: req.temperature,
    })
  );
}
