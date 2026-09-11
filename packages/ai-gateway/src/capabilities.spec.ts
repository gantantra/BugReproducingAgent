import { describe, it, expect } from "vitest";
import { InvestigatorError, isInvestigatorError } from "@investigator/core";
import {
  MemoryCapabilityCache,
  applyDeclaration,
  cacheKey,
  decideDegradation,
  probeCapabilities,
} from "./capabilities.js";
import type { LlmProvider, LlmResponse, ModelCapabilities } from "./index.js";
import { syntheticResponse } from "./recorded.js";

/**
 * M3 exit criterion 5: probes run at most once per cache miss per capability, cache in the store,
 * and yield `unknown` (not `unsupported`) on transport failure. The degradation matrix is
 * exercised in all four quadrants.
 */

function provider(behaviour: (n: number) => LlmResponse | Error): LlmProvider & { calls: number } {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    async complete() {
      const r = behaviour(++calls);
      if (r instanceof Error) throw r;
      return r;
    },
    async capabilities(): Promise<ModelCapabilities> {
      return {
        jsonMode: "unknown",
        toolCalls: "unknown",
        thinkingMode: "unknown",
        contextWindow: 1,
        maxOutputTokens: 1,
      };
    },
  } as LlmProvider & { calls: number };
}

const base = {
  alias: "FAST_MODEL" as const,
  modelId: "m1",
  inferenceMode: "non-thinking",
  providerName: "deepseek",
  adapterVersion: "0.1.0",
  ttlSeconds: 3600,
  nowMs: 1_000_000,
};

describe("capability probing", () => {
  it("probes each capability once and caches the result", async () => {
    const cache = new MemoryCapabilityCache();
    const p = provider(() => syntheticResponse({ content: '{"ok":true,"n":1}' }));

    const first = await probeCapabilities({ ...base, provider: p, cache });
    expect(first.capabilities.jsonMode).toBe("supported");
    expect(first.probes).toHaveLength(3);
    expect(p.calls, "one call per capability, no more").toBe(3);

    // A second resolution inside the TTL must not probe again.
    const second = await probeCapabilities({
      ...base,
      provider: p,
      cache,
      nowMs: base.nowMs + 1000,
    });
    expect(p.calls).toBe(3);
    expect(second.probes).toHaveLength(0);
    expect(second.capabilities).toEqual(first.capabilities);
  });

  it("re-probes after the TTL expires", async () => {
    const cache = new MemoryCapabilityCache();
    const p = provider(() => syntheticResponse({ content: "{}" }));
    await probeCapabilities({ ...base, provider: p, cache });
    await probeCapabilities({ ...base, provider: p, cache, nowMs: base.nowMs + 3_600_001 });
    expect(p.calls).toBe(6);
  });

  it("a transient failure yields unknown, NOT unsupported", async () => {
    // The distinction is load-bearing: recording a rate-limited probe as `unsupported` would
    // permanently disable tool-using flows because the provider was briefly busy.
    const cache = new MemoryCapabilityCache();
    const p = provider(() => new InvestigatorError("AI_RATE_LIMIT", "busy"));

    const r = await probeCapabilities({ ...base, provider: p, cache });
    expect(r.capabilities.jsonMode).toBe("unknown");
    expect(r.capabilities.toolCalls).toBe("unknown");
    expect(r.probes.every((x) => x.support === "unknown")).toBe(true);
  });

  it("a non-transient failure yields unsupported", async () => {
    const cache = new MemoryCapabilityCache();
    const p = provider(() => new InvestigatorError("AI_CAPABILITY_MISSING", "no tools here"));
    const r = await probeCapabilities({ ...base, provider: p, cache });
    expect(r.capabilities.toolCalls).toBe("unsupported");
  });

  it("records the observation verbatim so a later behaviour change is diagnosable", async () => {
    const cache = new MemoryCapabilityCache();
    const p = provider(() => syntheticResponse({ content: "{}", finishReason: "length" }));
    const r = await probeCapabilities({ ...base, provider: p, cache });
    expect(r.probes[0]?.observation).toContain("finishReason=length");
  });

  it("keys the cache by provider, model, inference mode and adapter version", () => {
    const a = cacheKey({
      provider: "deepseek",
      modelId: "m1",
      inferenceMode: "thinking",
      adapterVersion: "1",
    });
    const b = cacheKey({
      provider: "deepseek",
      modelId: "m1",
      inferenceMode: "non-thinking",
      adapterVersion: "1",
    });
    const c = cacheKey({
      provider: "deepseek",
      modelId: "m1",
      inferenceMode: "thinking",
      adapterVersion: "2",
    });
    expect(new Set([a, b, c]).size, "each dimension must change the key").toBe(3);
  });

  it("warns CAPABILITY_UNKNOWN when the context window was never declared", async () => {
    const cache = new MemoryCapabilityCache();
    const p = provider(() => syntheticResponse({ content: "{}" }));
    const r = await probeCapabilities({ ...base, provider: p, cache });
    expect(r.warnings).toContain("CAPABILITY_UNKNOWN");
  });
});

describe("config declaration narrows, never widens", () => {
  const observed: ModelCapabilities = {
    jsonMode: "supported",
    toolCalls: "unsupported",
    thinkingMode: "unknown",
    contextWindow: 32_000,
    maxOutputTokens: 4_096,
  };

  it("accepts a narrowing declaration", () => {
    expect(applyDeclaration(observed, { jsonMode: "unsupported" }).jsonMode).toBe("unsupported");
  });

  it("rejects a widening declaration rather than trusting it", () => {
    // Evidence beats assertion: silently trusting this would produce requests the provider
    // rejects, with no way for the operator to see their own config caused it.
    let err: unknown;
    try {
      applyDeclaration(observed, { toolCalls: "supported" });
    } catch (e) {
      err = e;
    }
    expect(isInvestigatorError(err)).toBe(true);
    expect((err as Error).message).toContain("never widen");
  });

  it("lets config supply the unprobeable limits", () => {
    expect(applyDeclaration(observed, { contextWindow: 128_000 }).contextWindow).toBe(128_000);
  });
});

describe("degradation matrix, all four quadrants", () => {
  const caps = (jsonMode: string, toolCalls: string): ModelCapabilities =>
    ({
      jsonMode,
      toolCalls,
      thinkingMode: "unknown",
      contextWindow: 1,
      maxOutputTokens: 1,
    }) as ModelCapabilities;

  const toolFlow = { maxToolCalls: 4, requiresStructuredOutput: true, singleShot: false };
  const singleShot = { maxToolCalls: 0, requiresStructuredOutput: true, singleShot: true };

  it("json supported + tools supported: full path", () => {
    const d = decideDegradation(caps("supported", "supported"), toolFlow);
    expect(d.allowed).toBe(true);
    expect(d.warnings).toEqual([]);
  });

  it("json supported + tools unsupported: tool flows refused, tool-free flows proceed", () => {
    expect(decideDegradation(caps("supported", "unsupported"), toolFlow).allowed).toBe(false);
    expect(decideDegradation(caps("supported", "unsupported"), singleShot).allowed).toBe(true);
    // `unknown` gets the same decision, but is never RECORDED as unsupported.
    expect(decideDegradation(caps("supported", "unknown"), toolFlow).allowed).toBe(false);
  });

  it("json unsupported: prompt-contract extraction with an explicit warning", () => {
    const d = decideDegradation(caps("unknown", "supported"), toolFlow);
    expect(d.allowed).toBe(true);
    expect(d.warnings).toContain("JSON_MODE_UNAVAILABLE");
  });

  it("neither supported: only single-shot flows are attempted", () => {
    expect(decideDegradation(caps("unsupported", "unsupported"), toolFlow).allowed).toBe(false);
    const d = decideDegradation(caps("unsupported", "unsupported"), singleShot);
    expect(d.allowed).toBe(true);
    expect(d.warnings).toContain("JSON_MODE_UNAVAILABLE");
  });

  it("always explains itself, so a disabled capability is visible rather than silent", () => {
    for (const j of ["supported", "unsupported", "unknown"]) {
      for (const t of ["supported", "unsupported", "unknown"]) {
        expect(decideDegradation(caps(j, t), toolFlow).reason.length).toBeGreaterThan(10);
      }
    }
  });
});
