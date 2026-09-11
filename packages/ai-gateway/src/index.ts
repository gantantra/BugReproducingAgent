import type { ModelAlias } from "@investigator/core";

/**
 * @investigator/ai-gateway
 *
 * Playwright produces evidence. Deterministic software normalizes and measures evidence. DeepSeek interprets and prioritizes evidence. Humans authorize consequential transitions.
 *
 * M1 SCOPE: the contract only. No adapter, no transport, no provider call, no key access.
 * The interface exists now so that `execution` and `evidence` can be proven — by the
 * import-graph test — to be unable to reach it (ADR-0006), and so the M3 adapter has a fixed
 * target rather than a moving one.
 *
 * Implementation arrives in M3, which is defined as "pass the eval harness for intake_to_flow
 * and propose_experiments", not as "integrate DeepSeek".
 */

export type CapabilitySupport = "supported" | "unsupported" | "unknown";

export interface ModelCapabilities {
  jsonMode: CapabilitySupport;
  toolCalls: CapabilitySupport;
  thinkingMode: CapabilitySupport;
  contextWindow: number;
  maxOutputTokens: number;
}

export interface LlmMessage {
  role: "user" | "assistant" | "tool";
  content: string;
  toolCallId?: string;
  name?: string;
}

export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface LlmRequest {
  alias: ModelAlias;
  system: string;
  messages: LlmMessage[];
  responseSchema?: Record<string, unknown>;
  tools?: ToolSpec[];
  maxTokens: number;
  temperature: number;
  timeoutMs: number;
  requestId: string;
}

export interface LlmResponse {
  rawText: string;
  parsed?: unknown;
  toolCalls?: ToolCall[];
  usage: { promptTokens: number; completionTokens: number; totalTokens: number };
  provider: string;
  modelId: string;
  modelVersion?: string;
  inferenceMode?: string;
  latencyMs: number;
  finishReason: string;
  warnings: string[];
}

export interface LlmProvider {
  complete(req: LlmRequest): Promise<LlmResponse>;
  capabilities(alias: ModelAlias): Promise<ModelCapabilities>;
}

/** Typed error classes the adapter maps provider failures onto (ADR-0009). */
export const LLM_ERROR_CLASSES = [
  "AUTH",
  "RATE_LIMIT",
  "TIMEOUT",
  "INVALID_OUTPUT",
  "SCHEMA_MISMATCH",
  "REFERENCE_MISMATCH",
  "PROVIDER_UNAVAILABLE",
  "COST_EXCEEDED",
] as const;

export type LlmErrorClass = (typeof LLM_ERROR_CLASSES)[number];

/** Budget exhaustion returns a typed partial or inconclusive result, never a silent truncation. */
export type FlowResult<T> =
  | { status: "complete"; value: T; warnings: string[] }
  | {
      status: "partial";
      value: Partial<T>;
      completedUnits: number;
      totalUnits: number;
      stopReason:
        "BUDGET_TOKENS" | "BUDGET_COST" | "BUDGET_TURNS" | "BUDGET_WALLCLOCK" | "BUDGET_TOOL_CALLS";
      warnings: string[];
    }
  | { status: "inconclusive"; reason: string; warnings: string[] };

export const PACKAGE_NAME = "@investigator/ai-gateway";

export * from "./errors.js";
export * from "./retry.js";
export * from "./budget.js";
export * from "./deepseek.js";
export * from "./recorded.js";
export * from "./gateway.js";
export * from "./validate.js";
export * from "./capabilities.js";
