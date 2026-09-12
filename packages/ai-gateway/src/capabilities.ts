import { fail, type ModelAlias } from "@investigator/core";
import type { CapabilitySupport, LlmProvider, ModelCapabilities } from "./index.js";

/**
 * Capability probing, the TTL cache, and the degradation matrix
 * (docs/architecture/llm-provider-contract.md).
 *
 * Playwright produces evidence. Deterministic software normalizes and measures evidence. DeepSeek interprets and prioritizes evidence. Humans authorize consequential transitions.
 *
 * The rule that matters most: a probe that FAILS yields `unknown`, never `unsupported`.
 *
 * The distinction is not pedantry. `unsupported` is a statement about the model; `unknown` is a
 * statement about our information. Recording a rate-limited probe as `unsupported` would silently
 * and permanently disable tool-using flows because the provider was briefly busy — and the cache
 * would then make that wrong answer sticky.
 *
 * Config may only NARROW an observed capability, never widen it. A config claiming `supported`
 * against an observed `unsupported` is rejected rather than trusted: the observation is evidence,
 * the config is an assertion, and evidence wins.
 */

export interface CapabilityProbeResult {
  capability: "jsonMode" | "toolCalls" | "thinkingMode";
  support: CapabilitySupport;
  /** Recorded verbatim so a later behaviour change is diagnosable. */
  observation: string;
}

export interface CapabilityCacheEntry {
  key: string;
  capabilities: ModelCapabilities;
  storedAtMs: number;
}

export interface CapabilityCache {
  get(key: string): Promise<CapabilityCacheEntry | null>;
  put(entry: CapabilityCacheEntry): Promise<void>;
}

/** In-memory cache. The CLI supplies a metadata-store-backed one so a fresh process re-uses it. */
export class MemoryCapabilityCache implements CapabilityCache {
  private readonly entries = new Map<string, CapabilityCacheEntry>();
  async get(key: string): Promise<CapabilityCacheEntry | null> {
    return this.entries.get(key) ?? null;
  }
  async put(entry: CapabilityCacheEntry): Promise<void> {
    this.entries.set(entry.key, entry);
  }
}

export function cacheKey(args: {
  provider: string;
  modelId: string;
  inferenceMode: string;
  adapterVersion: string;
}): string {
  return `${args.provider}|${args.modelId}|${args.inferenceMode}|${args.adapterVersion}`;
}

export interface ProbeOptions {
  provider: LlmProvider;
  alias: ModelAlias;
  modelId: string;
  inferenceMode: string;
  providerName: string;
  adapterVersion: string;
  cache: CapabilityCache;
  ttlSeconds: number;
  nowMs: number;
  /** Declared capabilities from config. May only narrow what was observed. */
  declared?: Partial<ModelCapabilities>;
  /** Hard ceiling per probe. */
  probeTimeoutMs?: number;
}

const PROBE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["ok", "n"],
  properties: { ok: { type: "boolean" }, n: { type: "integer" } },
};

const NOOP_TOOL = {
  name: "noop",
  description: "A no-op probe tool. Returns nothing and changes nothing.",
  parameters: { type: "object", additionalProperties: false, properties: {} },
};

/**
 * Run the bounded probes, at most once per cache miss per capability.
 *
 * `contextWindow` and `maxOutputTokens` are deliberately NOT probed: discovering a context window
 * empirically means deliberately overflowing it, which costs real money to learn something the
 * config can simply state. They come from config when declared, and otherwise stay at the
 * adapter's conservative defaults with a `CAPABILITY_UNKNOWN` warning, with budgets enforced by
 * our own token accounting rather than by trusting an unverified limit.
 */
export async function probeCapabilities(opts: ProbeOptions): Promise<{
  capabilities: ModelCapabilities;
  probes: CapabilityProbeResult[];
  warnings: string[];
}> {
  const key = cacheKey({
    provider: opts.providerName,
    modelId: opts.modelId,
    inferenceMode: opts.inferenceMode,
    adapterVersion: opts.adapterVersion,
  });

  const cached = await opts.cache.get(key);
  if (cached && opts.nowMs - cached.storedAtMs < opts.ttlSeconds * 1000) {
    return { capabilities: cached.capabilities, probes: [], warnings: [] };
  }

  const warnings: string[] = [];
  const probes: CapabilityProbeResult[] = [];
  const timeoutMs = opts.probeTimeoutMs ?? 15_000;

  const attempt = async (
    capability: CapabilityProbeResult["capability"],
    build: () => Parameters<LlmProvider["complete"]>[0]
  ): Promise<CapabilitySupport> => {
    try {
      const res = await opts.provider.complete(build());
      probes.push({
        capability,
        support: "supported",
        observation: `finishReason=${res.finishReason} bytes=${res.rawText.length}`,
      });
      return "supported";
    } catch (e) {
      const err = e as { code?: string; classification?: { errorClass?: string } };
      const cls = err.classification?.errorClass ?? err.code ?? "unknown";
      // A transient failure says nothing about the capability. `unknown` keeps the door open;
      // `unsupported` would nail it shut on the strength of a busy minute.
      const transient = [
        "TIMEOUT",
        "RATE_LIMIT",
        "PROVIDER_UNAVAILABLE",
        "AI_PROVIDER_UNAVAILABLE",
        "AI_TIMEOUT",
        "AI_RATE_LIMIT",
      ];
      const support: CapabilitySupport = transient.includes(String(cls))
        ? "unknown"
        : "unsupported";
      probes.push({ capability, support, observation: `error=${String(cls)}` });
      return support;
    }
  };

  const baseReq = {
    alias: opts.alias,
    system: "Reply with the smallest valid answer. This is a capability probe.",
    messages: [{ role: "user" as const, content: '{"probe":true}' }],
    maxTokens: 64,
    temperature: 0,
    timeoutMs,
    requestId: `probe-${key}`,
    // Tells the adapter to send the feature under test rather than refuse it for being unproven.
    probe: true,
  };

  const jsonMode = await attempt("jsonMode", () => ({ ...baseReq, responseSchema: PROBE_SCHEMA }));
  const toolCalls = await attempt("toolCalls", () => ({ ...baseReq, tools: [NOOP_TOOL] }));
  const thinkingMode = await attempt("thinkingMode", () => ({ ...baseReq }));

  const observed: ModelCapabilities = {
    jsonMode,
    toolCalls,
    thinkingMode,
    contextWindow: opts.declared?.contextWindow ?? 32_000,
    maxOutputTokens: opts.declared?.maxOutputTokens ?? 4_096,
  };
  if (opts.declared?.contextWindow === undefined) warnings.push("CAPABILITY_UNKNOWN");

  const capabilities = applyDeclaration(observed, opts.declared);
  await opts.cache.put({ key, capabilities, storedAtMs: opts.nowMs });
  return { capabilities, probes, warnings };
}

const RANK: Record<CapabilitySupport, number> = { unsupported: 0, unknown: 1, supported: 2 };

/**
 * Config may narrow, never widen.
 *
 * Rejecting the widening case loudly is the point: silently trusting a config that claims a
 * capability the model demonstrably lacks would produce requests the provider rejects, and the
 * operator would have no way to tell that their own config caused it.
 */
export function applyDeclaration(
  observed: ModelCapabilities,
  declared?: Partial<ModelCapabilities>
): ModelCapabilities {
  if (!declared) return observed;
  const out = { ...observed };
  for (const cap of ["jsonMode", "toolCalls", "thinkingMode"] as const) {
    const claim = declared[cap];
    if (!claim) continue;
    if (RANK[claim] > RANK[observed[cap]]) {
      fail(
        "CONFIG_INVALID",
        `Config declares ${cap}=${claim} but the probe observed ${observed[cap]}. ` +
          `Configuration may narrow an observed capability, never widen it.`,
        { context: { capability: cap, declared: claim, observed: observed[cap] } }
      );
    }
    out[cap] = claim;
  }
  if (declared.contextWindow !== undefined) out.contextWindow = declared.contextWindow;
  if (declared.maxOutputTokens !== undefined) out.maxOutputTokens = declared.maxOutputTokens;
  return out;
}

export interface FlowRequirements {
  /** 0 means the flow never calls a tool. */
  maxToolCalls: number;
  requiresStructuredOutput: boolean;
  /** Single-shot flows can run in the most degraded quadrant. */
  singleShot: boolean;
}

export interface DegradationDecision {
  allowed: boolean;
  /** Set when the flow may run but with reduced guarantees. */
  warnings: string[];
  reason: string;
}

/**
 * The degradation matrix. Disabling is EXPLICIT and visible; the agent never pretends a
 * capability exists.
 */
export function decideDegradation(
  capabilities: ModelCapabilities,
  flow: FlowRequirements
): DegradationDecision {
  const json = capabilities.jsonMode;
  const tools = capabilities.toolCalls;
  const warnings: string[] = [];

  const toolsUsable = tools === "supported";
  const needsTools = flow.maxToolCalls > 0;

  if (json === "supported" && toolsUsable) {
    return { allowed: true, warnings, reason: "full path: structured output plus tool loop" };
  }

  if (json === "supported" && !toolsUsable) {
    if (needsTools) {
      return {
        allowed: false,
        warnings,
        reason: `tool calling is ${tools}; a tool-using flow cannot run (AI_CAPABILITY_MISSING)`,
      };
    }
    return { allowed: true, warnings, reason: "structured output only; this flow needs no tools" };
  }

  // json is unsupported or unknown.
  warnings.push("JSON_MODE_UNAVAILABLE");

  if (json === "unsupported" && tools === "unsupported") {
    if (!flow.singleShot) {
      return {
        allowed: false,
        warnings,
        reason: "neither structured output nor tools are supported; only single-shot flows run",
      };
    }
    return { allowed: true, warnings, reason: "single-shot flow under the most degraded quadrant" };
  }

  if (needsTools && !toolsUsable) {
    return {
      allowed: false,
      warnings,
      reason: `tool calling is ${tools}; a tool-using flow cannot run (AI_CAPABILITY_MISSING)`,
    };
  }

  return {
    allowed: true,
    warnings,
    reason:
      "structured output requested by prompt contract, extracted strictly and schema-validated",
  };
}
