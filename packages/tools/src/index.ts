import { canonicalJson, fail } from "@investigator/core";
import type { RedactionStamp } from "@investigator/core";

/**
 * @investigator/tools — read-only projections over normalized evidence (ADR-0011).
 *
 * Playwright produces evidence. Deterministic software normalizes and measures evidence. DeepSeek interprets and prioritizes evidence. Humans authorize consequential transitions.
 *
 * A tool is the ONLY way a model sees evidence, so the shape of a tool result is a security
 * boundary, not a convenience:
 *
 *  - It returns fixed-field structured FACTS, never free prose and never raw bytes. A model that
 *    can only receive typed fields cannot be talked into acting on instructions hidden inside a
 *    page's text (risk R27).
 *  - Every citable datum carries an id, so a claim about it can be reference-validated. A datum
 *    with no id could be cited but never checked.
 *  - Truncation is explicit. Silent truncation would let a model conclude "there were no other
 *    errors" from a window that simply ended.
 *  - Tools are read-only and cannot reach the executor, a browser, or a provider. Enforced by the
 *    import boundary and by a contract test that runs each tool with network stubbed to throw.
 */

export type ToolErrorCode =
  "NOT_FOUND" | "NOT_READY" | "OUT_OF_SCOPE" | "EVIDENCE_UNUSABLE" | "INPUT_INVALID";

export interface ToolProvenance {
  investigationId: string;
  runIds: string[];
  normalizerVersion: string;
  extractorVersion: string;
  redaction: RedactionStamp;
  captureStatusSlice: Record<string, string>;
}

export interface ToolTruncation {
  truncated: true;
  omittedCount: number;
  reason: "MAX_EVIDENCE_BYTES" | "MAX_ITEMS";
}

export interface ToolResult<T> {
  toolId: string;
  toolVersion: string;
  ok: boolean;
  data?: T;
  error?: { code: ToolErrorCode; message: string };
  provenance: ToolProvenance;
  truncation?: ToolTruncation;
}

export interface ToolContext {
  investigationId: string;
  normalizerVersion: string;
  extractorVersion: string;
  redaction: RedactionStamp;
  /** Category -> capture status, for every category the tool read. */
  captureStatus: Record<string, string>;
  maxItems?: number;
  maxBytes?: number;
}

export interface Tool<I, O> {
  readonly id: string;
  readonly version: string;
  /** JSON Schema for the input, published to the model as the tool spec. */
  readonly inputSchema: Record<string, unknown>;
  readonly description: string;
  run(input: I, ctx: ToolContext): Promise<ToolResult<O>>;
}

export const DEFAULT_MAX_ITEMS = 200;
export const DEFAULT_MAX_BYTES = 64 * 1024;

export function toolOk<T>(
  tool: { id: string; version: string },
  data: T,
  ctx: ToolContext,
  runIds: string[],
  truncation?: ToolTruncation
): ToolResult<T> {
  return {
    toolId: tool.id,
    toolVersion: tool.version,
    ok: true,
    data,
    provenance: {
      investigationId: ctx.investigationId,
      runIds,
      normalizerVersion: ctx.normalizerVersion,
      extractorVersion: ctx.extractorVersion,
      redaction: ctx.redaction,
      captureStatusSlice: ctx.captureStatus,
    },
    ...(truncation ? { truncation } : {}),
  };
}

export function toolError<T>(
  tool: { id: string; version: string },
  code: ToolErrorCode,
  message: string,
  ctx: ToolContext
): ToolResult<T> {
  return {
    toolId: tool.id,
    toolVersion: tool.version,
    ok: false,
    error: { code, message },
    provenance: {
      investigationId: ctx.investigationId,
      runIds: [],
      normalizerVersion: ctx.normalizerVersion,
      extractorVersion: ctx.extractorVersion,
      redaction: ctx.redaction,
      captureStatusSlice: ctx.captureStatus,
    },
  };
}

/** Cap a list, reporting the omission rather than hiding it. */
export function capItems<T>(
  items: readonly T[],
  max: number
): { items: T[]; truncation?: ToolTruncation } {
  if (items.length <= max) return { items: [...items] };
  return {
    items: items.slice(0, max),
    truncation: { truncated: true, omittedCount: items.length - max, reason: "MAX_ITEMS" },
  };
}

/**
 * Verify a tool result before it is handed to a model.
 *
 * Called by the flow layer on EVERY result, not only in tests: a tool that regressed into
 * emitting raw bytes would otherwise put unredacted evidence in front of the provider, which is
 * precisely what ADR-0008 forbids.
 */
export function assertToolResultSafe(
  result: ToolResult<unknown>,
  maxBytes = DEFAULT_MAX_BYTES
): void {
  const serialized = canonicalJson(result);

  if (serialized.length > maxBytes) {
    fail(
      "TOOL_RESULT_TOO_LARGE",
      `Tool ${result.toolId} produced ${serialized.length} bytes, over the ${maxBytes} ceiling`,
      { context: { toolId: result.toolId, bytes: serialized.length, ceiling: maxBytes } }
    );
  }

  // Base64 blobs and data URIs are how raw artifact bytes would sneak into a "structured" result.
  if (/data:[a-z]+\/[a-z0-9.+-]+;base64,/i.test(serialized)) {
    fail("TOOL_RESULT_UNSAFE", `Tool ${result.toolId} embedded a data: URI`, {
      context: { toolId: result.toolId },
    });
  }
  if (/"[A-Za-z0-9+/]{512,}={0,2}"/.test(serialized)) {
    fail("TOOL_RESULT_UNSAFE", `Tool ${result.toolId} embedded what looks like a base64 blob`, {
      context: { toolId: result.toolId },
    });
  }

  if (!result.provenance?.redaction?.policyId) {
    fail("TOOL_RESULT_UNSAFE", `Tool ${result.toolId} returned no redaction stamp`, {
      context: { toolId: result.toolId },
    });
  }
}

export const PACKAGE_NAME = "@investigator/tools";
export const TOOLS_VERSION = "0.1.0";

export * from "./read-tools.js";
export * from "./analysis-tools.js";
