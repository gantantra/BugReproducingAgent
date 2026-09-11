import type { JsonPrimitive } from "./types.js";

/**
 * Typed error taxonomy (docs/architecture/error-taxonomy.md).
 *
 * The critical design property is `context`: it accepts ONLY JSON primitives, by type signature.
 * That closes the most common accidental-leak path in an evidence-handling system — dumping a
 * request object, a header map, a buffer, or a provider response into an error and having it
 * reach a log line. See ADR-0008.
 */

export const ERROR_CODES = [
  // Configuration and usage
  "CONFIG_INVALID",
  "CONFIG_ENV_UNRESOLVED",
  "WORKSPACE_NOT_FOUND",
  "WORKSPACE_VERSION_MISMATCH",
  "INPUT_INVALID",
  "INTERNAL",
  "NOT_IMPLEMENTED",
  // Approvals
  "GATE_REQUIRED",
  "GATE_ALREADY_APPROVED",
  "GATE_CHECKSUM_MISMATCH",
  "GATE_PROPOSAL_STALE",
  "GATE_APPROVAL_EXPIRED",
  "GATE_EDIT_OUT_OF_SURFACE",
  "GATE_REFERENCE_UNKNOWN",
  // AI
  "AI_AUTH",
  "AI_RATE_LIMIT",
  "AI_TIMEOUT",
  "AI_PROVIDER_UNAVAILABLE",
  "AI_INVALID_OUTPUT",
  "AI_SCHEMA_MISMATCH",
  "AI_REFERENCE_MISMATCH",
  "AI_UNSUPPORTED_ACTION",
  "AI_CLAIM_UNSUPPORTED",
  "AI_CAPABILITY_MISSING",
  "AI_BUDGET_EXCEEDED",
  "AI_TOOL_NOT_ALLOWED",
  "TOOL_RESULT_UNSAFE",
  "TOOL_RESULT_TOO_LARGE",
  // Execution
  "EXEC_BROWSER_LAUNCH_FAILED",
  "EXEC_TARGET_UNREACHABLE",
  "EXEC_ORIGIN_NOT_ALLOWED",
  "EXEC_ACTION_FAILED",
  "EXEC_DESTRUCTIVE_BLOCKED",
  "EXEC_RUN_BUDGET_EXCEEDED",
  "EXEC_INVESTIGATION_LIMIT",
  "EXEC_INTERRUPTED",
  "EXEC_PRODUCTION_GUARD",
  // Evidence and integrity
  "EVIDENCE_CATEGORY_MISSING",
  "EVIDENCE_CORRUPTED",
  "ARTIFACT_HASH_MISMATCH",
  "MANIFEST_SEAL_INVALID",
  "MANIFEST_IMMUTABLE",
  "REDACTION_POLICY_MISSING",
  "REDACTION_NOT_APPLIED",
  // Storage
  "STORE_BUSY",
  "STORE_APPEND_ONLY_VIOLATION",
  "STORE_DISK_FULL",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/** CLI exit codes are part of the contract (docs/architecture/cli-contract.md). */
export const EXIT = {
  OK: 0,
  USAGE: 1,
  GATE_REQUIRED: 2,
  GATE_CHECKSUM_MISMATCH: 3,
  AI_INVALID_OUTPUT: 4,
  BUDGET_EXCEEDED: 5,
  PROVIDER_UNAVAILABLE: 6,
  EXECUTION_FAILED: 7,
  EVIDENCE_INCOMPLETE: 8,
  INTEGRITY_FAILED: 9,
  INCONCLUSIVE: 10,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

interface CodeSpec {
  exitCode: ExitCode;
  retryable: boolean;
}

const SPEC: Readonly<Record<ErrorCode, CodeSpec>> = {
  CONFIG_INVALID: { exitCode: EXIT.USAGE, retryable: false },
  CONFIG_ENV_UNRESOLVED: { exitCode: EXIT.USAGE, retryable: false },
  WORKSPACE_NOT_FOUND: { exitCode: EXIT.USAGE, retryable: false },
  WORKSPACE_VERSION_MISMATCH: { exitCode: EXIT.USAGE, retryable: false },
  INPUT_INVALID: { exitCode: EXIT.USAGE, retryable: false },
  INTERNAL: { exitCode: EXIT.USAGE, retryable: false },
  NOT_IMPLEMENTED: { exitCode: EXIT.USAGE, retryable: false },

  GATE_REQUIRED: { exitCode: EXIT.GATE_REQUIRED, retryable: false },
  GATE_ALREADY_APPROVED: { exitCode: EXIT.GATE_REQUIRED, retryable: false },
  GATE_CHECKSUM_MISMATCH: { exitCode: EXIT.GATE_CHECKSUM_MISMATCH, retryable: false },
  GATE_PROPOSAL_STALE: { exitCode: EXIT.GATE_CHECKSUM_MISMATCH, retryable: false },
  GATE_APPROVAL_EXPIRED: { exitCode: EXIT.GATE_REQUIRED, retryable: false },
  GATE_EDIT_OUT_OF_SURFACE: { exitCode: EXIT.USAGE, retryable: false },
  GATE_REFERENCE_UNKNOWN: { exitCode: EXIT.USAGE, retryable: false },

  AI_AUTH: { exitCode: EXIT.PROVIDER_UNAVAILABLE, retryable: false },
  AI_RATE_LIMIT: { exitCode: EXIT.PROVIDER_UNAVAILABLE, retryable: true },
  AI_TIMEOUT: { exitCode: EXIT.PROVIDER_UNAVAILABLE, retryable: true },
  AI_PROVIDER_UNAVAILABLE: { exitCode: EXIT.PROVIDER_UNAVAILABLE, retryable: true },
  AI_INVALID_OUTPUT: { exitCode: EXIT.AI_INVALID_OUTPUT, retryable: false },
  AI_SCHEMA_MISMATCH: { exitCode: EXIT.AI_INVALID_OUTPUT, retryable: false },
  AI_REFERENCE_MISMATCH: { exitCode: EXIT.AI_INVALID_OUTPUT, retryable: false },
  AI_UNSUPPORTED_ACTION: { exitCode: EXIT.AI_INVALID_OUTPUT, retryable: false },
  AI_CLAIM_UNSUPPORTED: { exitCode: EXIT.AI_INVALID_OUTPUT, retryable: false },
  AI_CAPABILITY_MISSING: { exitCode: EXIT.PROVIDER_UNAVAILABLE, retryable: false },
  AI_BUDGET_EXCEEDED: { exitCode: EXIT.BUDGET_EXCEEDED, retryable: false },
  AI_TOOL_NOT_ALLOWED: { exitCode: EXIT.AI_INVALID_OUTPUT, retryable: false },
  // A tool result that would put raw bytes or unredacted content in front of the provider is a
  // redaction-boundary failure, so it exits with the integrity code rather than a usage code.
  TOOL_RESULT_UNSAFE: { exitCode: EXIT.INTEGRITY_FAILED, retryable: false },
  TOOL_RESULT_TOO_LARGE: { exitCode: EXIT.AI_INVALID_OUTPUT, retryable: false },

  EXEC_BROWSER_LAUNCH_FAILED: { exitCode: EXIT.EXECUTION_FAILED, retryable: true },
  EXEC_TARGET_UNREACHABLE: { exitCode: EXIT.EXECUTION_FAILED, retryable: true },
  EXEC_ORIGIN_NOT_ALLOWED: { exitCode: EXIT.EXECUTION_FAILED, retryable: false },
  EXEC_ACTION_FAILED: { exitCode: EXIT.EXECUTION_FAILED, retryable: false },
  EXEC_DESTRUCTIVE_BLOCKED: { exitCode: EXIT.EXECUTION_FAILED, retryable: false },
  EXEC_RUN_BUDGET_EXCEEDED: { exitCode: EXIT.EXECUTION_FAILED, retryable: false },
  EXEC_INVESTIGATION_LIMIT: { exitCode: EXIT.EXECUTION_FAILED, retryable: false },
  EXEC_INTERRUPTED: { exitCode: EXIT.EXECUTION_FAILED, retryable: true },
  EXEC_PRODUCTION_GUARD: { exitCode: EXIT.USAGE, retryable: false },

  EVIDENCE_CATEGORY_MISSING: { exitCode: EXIT.EVIDENCE_INCOMPLETE, retryable: false },
  EVIDENCE_CORRUPTED: { exitCode: EXIT.INTEGRITY_FAILED, retryable: false },
  ARTIFACT_HASH_MISMATCH: { exitCode: EXIT.INTEGRITY_FAILED, retryable: false },
  MANIFEST_SEAL_INVALID: { exitCode: EXIT.INTEGRITY_FAILED, retryable: false },
  MANIFEST_IMMUTABLE: { exitCode: EXIT.INTEGRITY_FAILED, retryable: false },
  REDACTION_POLICY_MISSING: { exitCode: EXIT.USAGE, retryable: false },
  REDACTION_NOT_APPLIED: { exitCode: EXIT.INTEGRITY_FAILED, retryable: false },

  STORE_BUSY: { exitCode: EXIT.EXECUTION_FAILED, retryable: true },
  STORE_APPEND_ONLY_VIOLATION: { exitCode: EXIT.INTEGRITY_FAILED, retryable: false },
  STORE_DISK_FULL: { exitCode: EXIT.EXECUTION_FAILED, retryable: false },
};

/** `context` is primitives-only by design. Do not widen this type. */
export type ErrorContext = Record<string, JsonPrimitive | undefined>;

export interface InvestigatorErrorOptions {
  subReason?: string;
  context?: ErrorContext;
  cause?: unknown;
}

export class InvestigatorError extends Error {
  readonly code: ErrorCode;
  readonly subReason?: string;
  readonly retryable: boolean;
  readonly exitCode: ExitCode;
  readonly context: ErrorContext;
  override readonly cause?: unknown;

  constructor(code: ErrorCode, message: string, opts: InvestigatorErrorOptions = {}) {
    super(message);
    this.name = "InvestigatorError";
    this.code = code;
    const spec = SPEC[code];
    this.retryable = spec.retryable;
    this.exitCode = spec.exitCode;
    if (opts.subReason !== undefined) this.subReason = opts.subReason;
    this.context = opts.context ?? {};
    if (opts.cause !== undefined) this.cause = opts.cause;
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      subReason: this.subReason,
      retryable: this.retryable,
      exitCode: this.exitCode,
      context: this.context,
    };
  }
}

export function isInvestigatorError(e: unknown): e is InvestigatorError {
  return e instanceof InvestigatorError;
}

export function fail(code: ErrorCode, message: string, opts: InvestigatorErrorOptions = {}): never {
  throw new InvestigatorError(code, message, opts);
}

/**
 * Wrap anything that escaped as a bare Error. A bare Error reaching the CLI boundary is itself a
 * bug; wrapping it as INTERNAL makes that visible rather than printing a stack and exiting 1.
 */
export function toInvestigatorError(e: unknown): InvestigatorError {
  if (isInvestigatorError(e)) return e;
  const message = e instanceof Error ? e.message : String(e);
  return new InvestigatorError("INTERNAL", message, { cause: e });
}

export function exitCodeFor(e: unknown): ExitCode {
  return toInvestigatorError(e).exitCode;
}

export const ERROR_SPEC = SPEC;
