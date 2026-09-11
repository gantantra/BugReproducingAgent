import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { canonicalJson, fail, sha256Prefixed, type ModelAlias } from "@investigator/core";
import type { LlmProvider, LlmRequest, LlmResponse, ModelCapabilities } from "./index.js";
import { requestContentHash } from "./deepseek.js";

/**
 * `RecordedProvider` — the test double that makes AI behaviour testable without a network.
 *
 * Playwright produces evidence. Deterministic software normalizes and measures evidence. DeepSeek interprets and prioritizes evidence. Humans authorize consequential transitions.
 *
 * Three modes:
 *
 *  - `replay`  reads a recorded response for the exact request. An unrecorded request is a hard
 *              failure, never a live call: a replay suite that silently reaches the network is
 *              not a replay suite, and would make CI depend on a credential and a third party.
 *  - `record`  delegates to a real provider and writes the exchange to disk. Refreshing fixtures
 *              after a deliberate prompt change is therefore a visible commit.
 *  - `scripted` returns responses supplied in code, for unit tests that do not want files.
 *
 * Fixtures are keyed by the content hash of the request, so a prompt change invalidates its own
 * fixture rather than silently replaying an answer to a different question.
 */

export interface RecordedExchange {
  key: string;
  /** What was asked, for human review of the fixture. Never used for matching. */
  summary: { alias: ModelAlias; systemPreview: string; messageCount: number };
  response: LlmResponse;
  /** Set when the recorded outcome was a failure rather than a response. */
  failure?: { errorClass: string; status: number; detail: string };
}

export type RecordedMode = "replay" | "record" | "scripted";

export interface RecordedProviderOptions {
  mode: RecordedMode;
  /** Directory of `<key>.json` fixtures. Required for replay and record. */
  cassetteDir?: string;
  /** Delegate for record mode. */
  live?: LlmProvider;
  /** For scripted mode: responses returned in order, or a function of the request. */
  scripted?: LlmResponse[] | ((req: LlmRequest) => LlmResponse);
  capabilities?: ModelCapabilities;
}

const DEFAULT_CAPABILITIES: ModelCapabilities = {
  jsonMode: "supported",
  toolCalls: "supported",
  thinkingMode: "unknown",
  contextWindow: 64_000,
  maxOutputTokens: 8_192,
};

export function cassetteKey(req: LlmRequest): string {
  // The requestId deliberately does NOT participate: it embeds an attempt index, and a retry of
  // the identical request must replay the identical fixture.
  return requestContentHash(req).replace("sha256:", "").slice(0, 32);
}

export class RecordedProvider implements LlmProvider {
  private scriptedIndex = 0;
  readonly recordedKeys: string[] = [];

  constructor(private readonly opts: RecordedProviderOptions) {
    if ((opts.mode === "replay" || opts.mode === "record") && !opts.cassetteDir) {
      fail("INPUT_INVALID", `RecordedProvider in ${opts.mode} mode needs a cassetteDir`);
    }
    if (opts.mode === "record" && !opts.live) {
      fail("INPUT_INVALID", "RecordedProvider in record mode needs a live provider to delegate to");
    }
  }

  async capabilities(_alias: ModelAlias): Promise<ModelCapabilities> {
    return this.opts.capabilities ?? { ...DEFAULT_CAPABILITIES };
  }

  private pathFor(key: string): string {
    return join(this.opts.cassetteDir!, `${key}.json`);
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    if (this.opts.mode === "scripted") {
      const s = this.opts.scripted;
      if (typeof s === "function") return s(req);
      const next = s?.[this.scriptedIndex++];
      if (!next) {
        fail(
          "INTERNAL",
          `Scripted provider ran out of responses at index ${this.scriptedIndex - 1}`
        );
      }
      return next;
    }

    const key = cassetteKey(req);

    if (this.opts.mode === "replay") {
      const path = this.pathFor(key);
      if (!existsSync(path)) {
        // Deliberately fatal. Falling back to a live call would make an offline suite quietly
        // depend on a credential, and a missing fixture usually means the prompt changed.
        fail(
          "AI_PROVIDER_UNAVAILABLE",
          `No recorded exchange for this request (key ${key}). ` +
            `Re-record with the eval harness in record mode if the prompt changed deliberately.`,
          { context: { key, cassetteDir: this.opts.cassetteDir ?? "" } }
        );
      }
      const exchange = JSON.parse(readFileSync(path, "utf8")) as RecordedExchange;
      if (exchange.failure) {
        fail("AI_PROVIDER_UNAVAILABLE", `Recorded failure: ${exchange.failure.detail}`, {
          context: { errorClass: exchange.failure.errorClass, status: exchange.failure.status },
        });
      }
      this.recordedKeys.push(key);
      return exchange.response;
    }

    // record
    const response = await this.opts.live!.complete(req);
    const exchange: RecordedExchange = {
      key,
      summary: {
        alias: req.alias,
        systemPreview: req.system.slice(0, 200),
        messageCount: req.messages.length,
      },
      response,
    };
    const path = this.pathFor(key);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, canonicalJson(exchange), "utf8");
    this.recordedKeys.push(key);
    return response;
  }
}

/** Build a replayable response without a network, for tests and for seeding fixtures. */
export function syntheticResponse(args: {
  content: string;
  modelId?: string;
  promptTokens?: number;
  completionTokens?: number;
  toolCalls?: LlmResponse["toolCalls"];
  finishReason?: string;
  warnings?: string[];
}): LlmResponse {
  const promptTokens = args.promptTokens ?? 100;
  const completionTokens = args.completionTokens ?? Math.ceil(args.content.length / 4);
  return {
    rawText: args.content,
    ...(args.toolCalls ? { toolCalls: args.toolCalls } : {}),
    usage: { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens },
    provider: "recorded",
    modelId: args.modelId ?? "recorded-model",
    modelVersion: sha256Prefixed(args.content).slice(0, 16),
    inferenceMode: "non-thinking",
    latencyMs: 0,
    finishReason: args.finishReason ?? "stop",
    warnings: args.warnings ?? [],
  };
}
