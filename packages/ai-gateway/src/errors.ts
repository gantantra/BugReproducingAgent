import type { LlmErrorClass } from "./index.js";

/**
 * Provider failure classification (ADR-0009, docs/architecture/llm-provider-contract.md).
 *
 * Playwright produces evidence. Deterministic software normalizes and measures evidence. DeepSeek interprets and prioritizes evidence. Humans authorize consequential transitions.
 *
 * TABLE-DRIVEN on purpose. Classification decides whether we retry, how long we wait, and whether
 * the circuit breaker trips, so "a 400 is a 400" is not good enough: a context-length 400 is a
 * permanent input problem, and an auth failure returned with a 200 body must never be classified
 * retryable — retrying an auth failure is how a key gets locked out.
 *
 * A response the table does not recognise is classified `PROVIDER_UNAVAILABLE` and carries the
 * unmatched signature in its detail, so an unknown failure is visible rather than silently
 * treated as a generic error.
 */

export interface ProviderFailure {
  /** HTTP status, or 0 for a transport/connect failure. */
  status: number;
  /** Response body, already truncated by the caller. Never contains a key (the adapter strips). */
  body?: string;
  /** Node/undici error code for transport failures: ECONNREFUSED, ETIMEDOUT, ABORT_ERR. */
  code?: string;
  headers?: Record<string, string>;
}

export interface Classification {
  errorClass: LlmErrorClass;
  retryable: boolean;
  /** Seconds the provider asked us to wait, when it said so. */
  retryAfterSeconds: number | null;
  /** Short, safe explanation. Never includes credential material. */
  detail: string;
  /** True when the input itself is at fault, so retrying the same request is pointless. */
  permanentInputProblem: boolean;
}

/** Body fragments that mean "the input was too long", whatever status they arrive with. */
const CONTEXT_LENGTH_MARKERS = [
  "context_length_exceeded",
  "context length",
  "maximum context",
  "too many tokens",
  "reduce the length",
  "string too long",
];

/** Body fragments that mean "your credentials are wrong", whatever status they arrive with. */
const AUTH_MARKERS = [
  "invalid_api_key",
  "invalid api key",
  "incorrect api key",
  "authentication_error",
  "unauthorized",
  "insufficient_quota",
  "insufficient balance",
];

const RATE_LIMIT_MARKERS = ["rate_limit", "rate limit", "too many requests", "quota exceeded"];

function parseRetryAfter(headers: Record<string, string> | undefined): number | null {
  const raw = headers?.["retry-after"] ?? headers?.["Retry-After"];
  if (!raw) return null;
  const seconds = Number.parseInt(raw, 10);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds;
  // HTTP-date form.
  const at = Date.parse(raw);
  if (Number.isFinite(at)) return Math.max(0, Math.round((at - Date.now()) / 1000));
  return null;
}

function contains(haystack: string, needles: string[]): boolean {
  const lower = haystack.toLowerCase();
  return needles.some((n) => lower.includes(n));
}

export function classifyProviderFailure(failure: ProviderFailure): Classification {
  const body = failure.body ?? "";
  const retryAfterSeconds = parseRetryAfter(failure.headers);

  // Transport-level: no HTTP response at all.
  if (failure.status === 0) {
    const code = failure.code ?? "";
    if (code === "ABORT_ERR" || code === "ETIMEDOUT" || code === "UND_ERR_HEADERS_TIMEOUT") {
      return {
        errorClass: "TIMEOUT",
        retryable: true,
        retryAfterSeconds,
        detail: `request timed out (${code || "no code"})`,
        permanentInputProblem: false,
      };
    }
    return {
      errorClass: "PROVIDER_UNAVAILABLE",
      retryable: true,
      retryAfterSeconds,
      detail: `transport failure (${code || "no code"})`,
      permanentInputProblem: false,
    };
  }

  // An auth failure can arrive with almost any status, including 200 with an error body. It is
  // checked FIRST and is never retryable: repeated auth attempts get keys disabled.
  if (failure.status === 401 || failure.status === 403 || contains(body, AUTH_MARKERS)) {
    return {
      errorClass: "AUTH",
      retryable: false,
      retryAfterSeconds: null,
      detail: `authentication rejected (status ${failure.status})`,
      permanentInputProblem: true,
    };
  }

  // A context-length 400 is a permanent input problem, not a transport hiccup. Retrying the same
  // oversized request wastes budget and never succeeds.
  if (contains(body, CONTEXT_LENGTH_MARKERS)) {
    return {
      errorClass: "SCHEMA_MISMATCH",
      retryable: false,
      retryAfterSeconds: null,
      detail: "request exceeded the model's context window",
      permanentInputProblem: true,
    };
  }

  if (failure.status === 429 || contains(body, RATE_LIMIT_MARKERS)) {
    return {
      errorClass: "RATE_LIMIT",
      retryable: true,
      retryAfterSeconds,
      detail: "rate limited by the provider",
      permanentInputProblem: false,
    };
  }

  if (failure.status === 408 || failure.status === 504) {
    return {
      errorClass: "TIMEOUT",
      retryable: true,
      retryAfterSeconds,
      detail: `provider timed out (status ${failure.status})`,
      permanentInputProblem: false,
    };
  }

  if (failure.status >= 500) {
    return {
      errorClass: "PROVIDER_UNAVAILABLE",
      retryable: true,
      retryAfterSeconds,
      detail: `provider error (status ${failure.status})`,
      permanentInputProblem: false,
    };
  }

  if (failure.status >= 400) {
    // A 4xx that is not auth, not rate limit and not context length is a malformed request on our
    // side. Retrying an identical bad request is pointless.
    return {
      errorClass: "SCHEMA_MISMATCH",
      retryable: false,
      retryAfterSeconds: null,
      detail: `request rejected (status ${failure.status})`,
      permanentInputProblem: true,
    };
  }

  return {
    errorClass: "PROVIDER_UNAVAILABLE",
    retryable: true,
    retryAfterSeconds,
    detail: `unrecognised provider response (status ${failure.status})`,
    permanentInputProblem: false,
  };
}

/** Attempt ceilings per class, from the frozen retry table. */
export const MAX_ATTEMPTS: Record<LlmErrorClass, number> = {
  AUTH: 1,
  RATE_LIMIT: 4,
  TIMEOUT: 2,
  PROVIDER_UNAVAILABLE: 3,
  INVALID_OUTPUT: 1,
  SCHEMA_MISMATCH: 1,
  REFERENCE_MISMATCH: 1,
  COST_EXCEEDED: 1,
};
