import { canonicalJson, fail, systemClock, type Clock } from "@investigator/core";
import {
  BudgetTracker,
  decideDegradation,
  parseStrictJson,
  validateAgainstSchema,
  type FlowResult,
  type LlmGateway,
  type LlmMessage,
  type ModelCapabilities,
  type ValidationReport,
} from "@investigator/ai-gateway";
import { assertToolResultSafe, type Tool, type ToolContext } from "@investigator/tools";
import { requiredCapabilities, type LoadedFlow } from "./loader.js";

/**
 * The flow turn loop (ADR-0010, ADR-0011).
 *
 * Playwright produces evidence. Deterministic software normalizes and measures evidence. DeepSeek interprets and prioritizes evidence. Humans authorize consequential transitions.
 *
 * The loop's job is to be boring and strict:
 *
 *  - DOUBLE allowlist enforcement. The tool registry is filtered to the flow's allowlist before
 *    the model is told what exists, AND every call is checked again at dispatch. The first stops
 *    the model being tempted; the second stops a model that invented a name anyway. One without
 *    the other is not enforcement.
 *  - An out-of-allowlist call is refused, CHARGED, warned, and raised at flow completion — not
 *    silently ignored, which would hide a model probing for capabilities it should not have.
 *  - Exactly one repair attempt, and only one, per turn.
 *  - A budget stop yields `partial` only for a flow declared `partialCapable`; otherwise
 *    `inconclusive`. A flow that cannot meaningfully half-finish must not report a half answer.
 */

export interface FlowRunContext {
  investigationId: string;
  gateway: LlmGateway;
  capabilities: ModelCapabilities;
  /** Every tool the process knows about. Filtered here to the flow's allowlist. */
  registry: Map<string, Tool<never, unknown>>;
  toolContext: ToolContext;
  clock?: Clock;
  /** Extra validation beyond the schema, e.g. reference checks. */
  extraValidation?: (output: unknown) => ValidationReport;
}

export interface FlowInvocation {
  flow: LoadedFlow;
  input: unknown;
  /** Rendered into the first user message. */
  userContent: string;
}

export interface FlowRunRecord {
  turns: number;
  toolCalls: Array<{ name: string; allowed: boolean; ok: boolean }>;
  repairs: number;
  aiRequestIds: string[];
}

export type FlowRunResult<T> = FlowResult<T> & { record: FlowRunRecord };

function budgetLimits(flow: LoadedFlow) {
  const b = flow.definition.budget;
  return {
    maxTotalTokens: b.maxInputTokens + b.maxOutputTokens,
    maxUsd: b.maxCostUsd,
    maxTurns: b.maxTurns,
    maxWallClockMs: b.maxWallClockMs,
    maxToolCalls: b.maxToolCalls,
    maxRepairs: flow.definition.validation.repairAttempts,
  };
}

export async function runFlow<T>(
  invocation: FlowInvocation,
  ctx: FlowRunContext
): Promise<FlowRunResult<T>> {
  const clock = ctx.clock ?? systemClock;
  const flow = invocation.flow;
  const def = flow.definition;
  const warnings: string[] = [];
  const record: FlowRunRecord = { turns: 0, toolCalls: [], repairs: 0, aiRequestIds: [] };

  // Capability gate BEFORE any spend. Running a tool-using flow against a model that cannot call
  // tools would produce an answer assembled from nothing.
  const needs = requiredCapabilities(def);
  const degradation = decideDegradation(ctx.capabilities, {
    maxToolCalls: def.budget.maxToolCalls,
    requiresStructuredOutput: needs.needsStructuredOutput,
    singleShot: needs.singleShot,
  });
  warnings.push(...degradation.warnings);
  if (!degradation.allowed) {
    fail("AI_CAPABILITY_MISSING", degradation.reason, {
      context: { flowId: def.id, reason: degradation.reason },
    });
  }

  // The model is only ever told about tools on the allowlist.
  const allowed = new Map<string, Tool<never, unknown>>();
  for (const name of def.tools) {
    const tool = ctx.registry.get(name);
    if (!tool) {
      fail("CONFIG_INVALID", `Flow ${def.id} allows tool ${name}, which is not registered`, {
        context: { flowId: def.id, tool: name },
      });
    }
    allowed.set(name, tool);
  }

  const budget = new BudgetTracker(budgetLimits(flow), clock.nowMs());
  const messages: LlmMessage[] = [{ role: "user", content: invocation.userContent }];
  const outputSchemaName = def.outputSchema.replace(/^schemas\//, "");
  let illegalToolAttempt: string | null = null;

  const inconclusive = (reason: string): FlowRunResult<T> => ({
    status: "inconclusive",
    reason,
    warnings,
    record,
  });

  for (;;) {
    const stop = budget.exhausted(clock.nowMs());
    if (stop) {
      // `partial` is only honest for a flow whose output is a list of independently valid units.
      if (def.partialCapable && def.unitField) {
        return {
          status: "partial",
          value: {} as Partial<T>,
          completedUnits: 0,
          totalUnits: 0,
          stopReason: stop as never,
          warnings,
          record,
        };
      }
      return inconclusive(`budget exhausted: ${stop}`);
    }

    const call = await ctx.gateway.call(
      {
        alias: def.modelAlias,
        system: flow.system,
        messages,
        responseSchema: { $ref: outputSchemaName },
        ...(allowed.size
          ? {
              tools: [...allowed.values()].map((t) => ({
                name: t.id,
                description: t.description,
                parameters: t.inputSchema,
              })),
            }
          : {}),
        maxTokens: def.budget.maxOutputTokens,
        temperature: def.temperature ?? 0,
        timeoutMs: Math.min(def.budget.maxWallClockMs, 120_000),
        requestId: "",
      },
      {
        budget,
        flowId: def.id,
        flowVersion: def.version,
        flowHash: flow.flowHash,
        promptVersion: flow.promptVersion,
        turnIndex: record.turns,
      }
    );
    record.turns++;
    record.aiRequestIds.push(call.requestId);
    warnings.push(...call.warnings);

    const toolCalls = call.response.toolCalls ?? [];
    if (toolCalls.length > 0) {
      for (const tc of toolCalls) {
        budget.chargeToolCall(clock.nowMs());

        const tool = allowed.get(tc.name);
        if (!tool) {
          // Refused, charged, warned — and remembered, so it raises at completion.
          record.toolCalls.push({ name: tc.name, allowed: false, ok: false });
          illegalToolAttempt = tc.name;
          warnings.push(`AI_TOOL_NOT_ALLOWED:${tc.name}`);
          messages.push({
            role: "tool",
            toolCallId: tc.id,
            name: tc.name,
            content: canonicalJson({
              ok: false,
              error: {
                code: "OUT_OF_SCOPE",
                message: `Tool ${tc.name} is not on this flow's allowlist.`,
              },
            }),
          });
          continue;
        }

        const result = await tool.run(tc.arguments as never, ctx.toolContext);
        // Verified on EVERY result, not only in tests: a regressed tool would otherwise put raw
        // evidence in front of the provider.
        assertToolResultSafe(result, def.budget.maxEvidenceBytes || undefined);
        record.toolCalls.push({ name: tc.name, allowed: true, ok: result.ok });
        messages.push({
          role: "tool",
          toolCallId: tc.id,
          name: tc.name,
          content: canonicalJson(result),
        });
      }
      messages.push({
        role: "assistant",
        content: "Tool results received. Produce the final JSON answer.",
      });
      continue;
    }

    // No tool calls: this is the answer. Validate it.
    const validated = validateOutput(call.response.rawText, outputSchemaName, ctx);
    if (validated.ok) {
      if (illegalToolAttempt) {
        // Raised at completion rather than mid-loop: the attempt is a finding about the flow, and
        // suppressing it because the final answer happened to validate would hide it.
        fail(
          "AI_TOOL_NOT_ALLOWED",
          `Flow ${def.id} attempted the unallowlisted tool ${illegalToolAttempt}`,
          { context: { flowId: def.id, tool: illegalToolAttempt } }
        );
      }
      return { status: "complete", value: validated.value as T, warnings, record };
    }

    // One repair attempt, and only one.
    if (record.repairs >= def.validation.repairAttempts) {
      return inconclusive(
        `output failed validation after ${record.repairs} repair attempt(s): ` +
          validated.report.issues.map((i) => `${i.path} ${i.message}`).join("; ")
      );
    }

    record.repairs++;
    budget.chargeRepair(clock.nowMs());
    messages.push(
      { role: "assistant", content: call.response.rawText.slice(0, 4000) },
      {
        role: "user",
        content: [
          flow.repairInstruction,
          "",
          "Validation errors:",
          ...validated.report.issues.map((i) => `- ${i.path || "(root)"}: ${i.message}`),
        ].join("\n"),
      }
    );
  }
}

function validateOutput(
  rawText: string,
  schemaName: string,
  ctx: FlowRunContext
): { ok: true; value: unknown } | { ok: false; report: ValidationReport } {
  const parsed = parseStrictJson(rawText);
  if (!parsed.ok) return { ok: false, report: { ok: false, issues: [parsed.issue] } };

  const schemaReport = validateAgainstSchema(schemaName, parsed.value);
  if (!schemaReport.ok) return { ok: false, report: schemaReport };

  // Reference validation runs only AFTER the schema passes: the reference fields themselves would
  // be untrusted in a document that failed its shape.
  if (ctx.extraValidation) {
    const extra = ctx.extraValidation(parsed.value);
    if (!extra.ok) return { ok: false, report: extra };
  }
  return { ok: true, value: parsed.value };
}
