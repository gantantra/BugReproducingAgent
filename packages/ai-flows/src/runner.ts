import { canonicalJson, fail, schemaRegistry, systemClock, type Clock } from "@investigator/core";
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

/**
 * A compact outline of the required shape of a flow's output, generated from the schemas.
 *
 * The system prompt tells a model to produce "a single JSON object matching the output schema"
 * and then never shows it the schema. Few-shot examples demonstrate the shape but do not state
 * it, so a model reproduces what it noticed: live calls came back missing one required field at
 * a time, each repair fixing the previous omission and revealing the next.
 *
 * Generated rather than written by hand so it cannot drift from the schema it describes, and
 * deliberately an OUTLINE rather than the full document -- resolving every $ref would cost more
 * input budget than the evidence being reasoned about.
 */
function requiredShape(schemaName: string, depth = 0, seen = new Set<string>()): string[] {
  if (depth > 2 || seen.has(schemaName)) return [];
  seen.add(schemaName);

  const registry = schemaRegistry();
  if (!registry.has(schemaName)) return [];
  const doc = registry.raw(schemaName) as Record<string, unknown> | null;
  if (!doc) return [];

  const lines: string[] = [];
  const pad = "  ".repeat(depth);
  const required = (doc["required"] as string[] | undefined) ?? [];
  const props = (doc["properties"] as Record<string, Record<string, unknown>>) ?? {};

  if (required.length) lines.push(`${pad}${schemaName} requires: ${required.join(", ")}`);

  for (const key of required) {
    const prop = props[key];
    if (!prop) continue;
    const ref = typeof prop["$ref"] === "string" ? (prop["$ref"] as string) : null;
    const itemRef =
      prop["type"] === "array" &&
      typeof (prop["items"] as Record<string, unknown>)?.["$ref"] === "string"
        ? ((prop["items"] as Record<string, unknown>)["$ref"] as string)
        : null;
    const target = ref ?? itemRef;
    if (target && target.endsWith(".json")) {
      lines.push(...requiredShape(target, depth + 1, seen));
    }
  }

  lines.push(...conditionalShape(doc, pad));
  return lines;
}

/** Resolve an in-document pointer such as `#/$defs/assertion`. */
function localRef(doc: Record<string, unknown>, ref: string): Record<string, unknown> | null {
  if (!ref.startsWith("#/")) return null;
  let node: unknown = doc;
  for (const part of ref.slice(2).split("/")) {
    node = (node as Record<string, unknown> | undefined)?.[part];
    if (node === undefined) return null;
  }
  return (node ?? null) as Record<string, unknown> | null;
}

/** `["string","null"]` is the schema's way of saying a value may be explicitly absent. */
function nullableNote(prop: Record<string, unknown>): string {
  const t = prop["type"];
  return Array.isArray(t) && t.includes("null") ? " (may be null)" : "";
}

/**
 * Describe `allOf`/`if`/`then` branches and in-document `$defs`.
 *
 * Without this the outline said only "action requires actionId, type" and stopped, so the model
 * never learned that a `goto` also requires `url`, or that an `assert` requires an `assertion`
 * OBJECT. Three separate live failures came from exactly that gap — a dropped `url` key, an
 * `assertion` sent as a string, and an extra field on a nested object — each of which looked like
 * a different bug and was the same missing sentence.
 */
function conditionalShape(doc: Record<string, unknown>, pad: string): string[] {
  const branches = doc["allOf"];
  if (!Array.isArray(branches)) return [];

  const lines: string[] = [];
  for (const raw of branches) {
    const branch = raw as Record<string, unknown>;
    const cond = branch["if"] as Record<string, unknown> | undefined;
    const then = branch["then"] as Record<string, unknown> | undefined;
    if (!cond || !then) continue;

    const condProps = (cond["properties"] as Record<string, Record<string, unknown>>) ?? {};
    const label = Object.entries(condProps)
      .map(([key, value]) => {
        const options = value["enum"];
        return `${key}=${Array.isArray(options) ? options.join("|") : "?"}`;
      })
      .join(" and ");

    const required = (then["required"] as string[] | undefined) ?? [];
    const thenProps = (then["properties"] as Record<string, Record<string, unknown>>) ?? {};
    if (!label || required.length === 0) continue;

    const detail = required.map((key) => {
      const prop = thenProps[key];
      if (!prop) return key;
      const ref = typeof prop["$ref"] === "string" ? (prop["$ref"] as string) : null;
      const resolved = ref ? localRef(doc, ref) : null;
      if (resolved) {
        const inner = (resolved["required"] as string[] | undefined) ?? [];
        if (inner.length) return `${key} (an object requiring: ${inner.join(", ")})`;
        // A $def with no declared shape adds nothing but noise: name the field and stop.
        const kind = resolved["type"];
        return typeof kind === "string" ? `${key} (a ${kind})` : key;
      }
      return `${key}${nullableNote(prop)}`;
    });

    lines.push(`${pad}  when ${label}: also requires ${detail.join("; ")}`);
  }
  return lines;
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

  const shape = requiredShape(def.outputSchema.replace(/^schemas\//, ""));
  const systemWithShape =
    shape.length === 0
      ? flow.system
      : [
          flow.system,
          "",
          "## Required output shape",
          "",
          "Generated from the schema your output is validated against. Every field listed is",
          'mandatory; an empty array or an explicit null is how you say "none", never omission.',
          "",
          ...shape,
        ].join("\n");

  const budget = new BudgetTracker(budgetLimits(flow), clock.nowMs());

  // The few-shot examples are SENT, not merely hashed.
  //
  // They were loaded and folded into `flowHash` but never placed in the prompt, so the model was
  // asked for "a single JSON object matching the output schema" and shown neither the schema nor
  // an example of it. Every live call failed validation on a missing top-level field, which is
  // the correct refusal to persist invalid output and a useless way to run a flow.
  //
  // They go in as user/assistant pairs rather than prose: the shape of a reply is taught far more
  // reliably by a reply than by a description of one. Provenance is unaffected because
  // examples.jsonl is already inside `flowHash`.
  const messages: LlmMessage[] = [];
  for (const example of flow.examples) {
    const input = example["input"];
    const output = example["output"];
    if (input === undefined || output === undefined) continue;
    messages.push({ role: "user", content: canonicalJson(input) });
    messages.push({ role: "assistant", content: canonicalJson(output) });
  }
  messages.push({ role: "user", content: invocation.userContent });
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
        system: systemWithShape,
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
      // The assistant turn that ASKED for these tools has to go into the history before the
      // replies do. A `tool` message is only meaningful as a response to a preceding assistant
      // message carrying the matching `tool_call_id`, and the provider rejects the request
      // outright when that message is absent — which is what made every tool-using flow fail.
      messages.push({
        role: "assistant",
        content: call.response.rawText ?? "",
        toolCalls,
      });

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
      // No fabricated assistant turn here. It was compensating for the missing tool_calls message
      // above, and an assistant message straight after a tool reply is not a shape the model ever
      // produced: with a well-formed history the next turn is simply the model's own answer.
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
