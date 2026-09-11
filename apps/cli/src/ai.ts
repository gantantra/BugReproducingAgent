import { dirname, join, resolve } from "node:path";
import { existsSync } from "node:fs";
import { fail, llmConfigStatus, resolveLlmSettings, systemClock } from "@investigator/core";
import type { ModelAlias } from "@investigator/core";
import {
  DeepSeekProvider,
  LlmGateway,
  MemoryCapabilityCache,
  RecordedProvider,
  probeCapabilities,
  type LlmProvider,
  type ModelCapabilities,
} from "@investigator/ai-gateway";
import { loadFlow, type LoadedFlow } from "@investigator/ai-flows";
import type { Runtime } from "./runtime.js";

/**
 * Wiring the AI path into the CLI.
 *
 * Playwright produces evidence. Deterministic software normalizes and measures evidence. DeepSeek interprets and prioritizes evidence. Humans authorize consequential transitions.
 *
 * Everything here is reached ONLY from an AI-dependent command. That is the whole shape of
 * decision 6: `init`, `run`, `doctor` and `suite generate` never touch this file, so a missing or
 * broken DeepSeek configuration cannot stop deterministic work. When an AI command does run and
 * the configuration is absent, it fails with a typed error naming the missing variables — never
 * with a degraded guess.
 */

/**
 * Walk upward for the repository `ai/flows` directory.
 *
 * Mirrors how the schema registry finds `schemas/`: resolving from `process.cwd()` would break
 * the moment an operator runs the CLI from anywhere but the repository root, which is the normal
 * case once a workspace lives elsewhere.
 */
export function resolveFlowsRoot(startDir: string = __dirname): string {
  let dir = resolve(startDir);
  for (let i = 0; i < 12; i++) {
    const candidate = join(dir, "ai", "flows");
    if (existsSync(join(candidate, "intake_to_flow", "flow.yaml"))) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  fail("CONFIG_INVALID", "Could not locate the ai/flows directory", {
    context: { startDir },
  });
}

export interface AiSession {
  provider: LlmProvider;
  gateway: LlmGateway;
  capabilities: ModelCapabilities;
  flow: LoadedFlow;
  warnings: string[];
}

export interface OpenAiSessionArgs {
  rt: Runtime;
  investigationId: string;
  flowId: string;
  /** Replay fixtures instead of calling a provider. Used by the eval harness and by tests. */
  replayDir?: string;
}

/**
 * Resolve AI configuration and open a session.
 *
 * The resolution happens HERE, at the point of use, not at config load. A deterministic command
 * that never reaches this function never needs a DeepSeek variable.
 */
export async function openAiSession(args: OpenAiSessionArgs): Promise<AiSession> {
  const { rt } = args;
  const flow = loadFlow(args.flowId, { flowsRoot: resolveFlowsRoot() });
  const warnings: string[] = [];

  if (args.replayDir) {
    // Replay needs no credential at all, which is what lets the eval gate block CI honestly.
    const provider = new RecordedProvider({ mode: "replay", cassetteDir: args.replayDir });
    return {
      provider,
      gateway: new LlmGateway({
        provider,
        metadata: rt.metadata,
        investigationId: args.investigationId,
        clock: systemClock,
      }),
      capabilities: await provider.capabilities("FAST_MODEL"),
      flow,
      warnings,
    };
  }

  const status = llmConfigStatus(rt.config);
  if (status.state !== "configured") {
    // Typed, and naming only variable NAMES. This is the ONLY operation class that needs them.
    fail(
      "AI_PROVIDER_UNAVAILABLE",
      `This step needs AI configuration, which is not set: ${status.missingVars.join(", ")}. ` +
        `Deterministic commands (init, run, doctor, suite generate) do not need it.`,
      { context: { missingVariables: status.missingVars.join(","), flowId: args.flowId } }
    );
  }

  const llm = resolveLlmSettings(rt.config);
  const models = Object.fromEntries(
    (["FAST_MODEL", "REASONING_MODEL", "FALLBACK_MODEL"] as ModelAlias[]).map((alias) => [
      alias,
      {
        modelId: llm.aliases[alias].modelId,
        inferenceMode: llm.aliases[alias].inferenceMode,
      },
    ])
  ) as Record<ModelAlias, { modelId: string; inferenceMode: string }>;

  const provider = new DeepSeekProvider({
    baseUrl: llm.baseUrl,
    apiKeyEnv: llm.apiKeyEnv,
    secrets: rt.secrets,
    models,
  });

  const alias = flow.definition.modelAlias;
  const probe = await probeCapabilities({
    provider,
    alias,
    modelId: models[alias].modelId,
    inferenceMode: models[alias].inferenceMode,
    providerName: "deepseek",
    adapterVersion: "0.1.0",
    cache: new MemoryCapabilityCache(),
    ttlSeconds: llm.capabilitiesCacheTtlSeconds,
    nowMs: systemClock.nowMs(),
  });
  warnings.push(...probe.warnings);

  return {
    provider,
    gateway: new LlmGateway({
      provider,
      metadata: rt.metadata,
      investigationId: args.investigationId,
      clock: systemClock,
      ...(llm.prices ? { prices: llm.prices } : {}),
      investigationUsdCeiling: llm.budgets.perInvestigationUsd,
    }),
    capabilities: probe.capabilities,
    flow,
    warnings,
  };
}
