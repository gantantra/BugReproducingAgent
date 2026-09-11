import type { Rng } from "@investigator/core";
import type { LlmErrorClass } from "./index.js";
import { MAX_ATTEMPTS, type Classification } from "./errors.js";

/**
 * Retry policy and circuit breaker (docs/architecture/llm-provider-contract.md).
 *
 * Playwright produces evidence. Deterministic software normalizes and measures evidence. DeepSeek interprets and prioritizes evidence. Humans authorize consequential transitions.
 *
 * Two properties the flow budget depends on:
 *
 *  1. Every retry shares ONE wall-clock deadline derived from the flow budget. A retry that would
 *     land after the deadline is not attempted at all — retries may not extend a flow past its
 *     budget, or the budget is advisory rather than a budget.
 *  2. The breaker is per `(provider, modelId)`. A failing reasoning model must not fast-fail calls
 *     to a healthy fast model.
 */

export interface BackoffPolicy {
  baseMs: number;
  factor: number;
  capMs: number;
}

export const DEFAULT_BACKOFF: BackoffPolicy = { baseMs: 1000, factor: 2, capMs: 30_000 };

/**
 * Full-jitter exponential backoff.
 *
 * Full jitter rather than a fixed schedule: when several calls are rate limited together, an
 * identical schedule makes them retry in lockstep and re-trigger the same limit.
 */
export function backoffMs(
  attempt: number,
  rng: Rng,
  policy: BackoffPolicy = DEFAULT_BACKOFF
): number {
  const exponential = Math.min(policy.capMs, policy.baseMs * Math.pow(policy.factor, attempt - 1));
  return Math.floor(rng.next() * exponential);
}

export interface DelayDecision {
  shouldRetry: boolean;
  delayMs: number;
  reason: string;
}

export interface RetryContext {
  attempt: number;
  classification: Classification;
  /** Absolute epoch ms after which no further attempt may be made. */
  deadlineMs: number;
  nowMs: number;
  rng: Rng;
  policy?: BackoffPolicy;
}

export function nextDelay(ctx: RetryContext): DelayDecision {
  const { classification: c, attempt } = ctx;

  if (!c.retryable) {
    return { shouldRetry: false, delayMs: 0, reason: `${c.errorClass} is not retryable` };
  }
  const limit = MAX_ATTEMPTS[c.errorClass];
  if (attempt >= limit) {
    return {
      shouldRetry: false,
      delayMs: 0,
      reason: `${c.errorClass} exhausted its ${limit} attempt(s)`,
    };
  }

  const computed = backoffMs(attempt, ctx.rng, ctx.policy);
  // Honour Retry-After when the provider asks for LONGER than we computed. Ignoring it invites a
  // harder limit; shortening it on the provider's behalf would be worse.
  const retryAfterMs = (c.retryAfterSeconds ?? 0) * 1000;
  const delayMs = Math.max(computed, retryAfterMs);

  if (ctx.nowMs + delayMs >= ctx.deadlineMs) {
    return {
      shouldRetry: false,
      delayMs: 0,
      reason: "the next attempt would land past the flow wall-clock deadline",
    };
  }

  return {
    shouldRetry: true,
    delayMs,
    reason:
      retryAfterMs > computed
        ? `honouring Retry-After ${c.retryAfterSeconds}s`
        : `backoff attempt ${attempt}`,
  };
}

export type BreakerState = "closed" | "open" | "half-open";

export interface BreakerStatus {
  key: string;
  state: BreakerState;
  consecutiveFailures: number;
  consecutiveAuthFailures: number;
  openedAtMs: number | null;
  openMs: number;
  remainingCooldownMs: number;
}

const OPEN_BASE_MS = 60_000;
const OPEN_CAP_MS = 600_000;
const TRANSPORT_TRIP_AT = 5;
const AUTH_TRIP_AT = 3;

/**
 * Circuit breaker per `(provider, modelId)`.
 *
 * Per-process by design: this is a local single-user tool, and a breaker shared through the
 * database would make one investigation's provider trouble silently fail another's commands.
 * `investigate doctor` reports the live state.
 */
export class CircuitBreaker {
  private readonly entries = new Map<
    string,
    {
      state: BreakerState;
      consecutiveFailures: number;
      consecutiveAuthFailures: number;
      openedAtMs: number | null;
      openMs: number;
    }
  >();

  private entry(key: string) {
    let e = this.entries.get(key);
    if (!e) {
      e = {
        state: "closed",
        consecutiveFailures: 0,
        consecutiveAuthFailures: 0,
        openedAtMs: null,
        openMs: OPEN_BASE_MS,
      };
      this.entries.set(key, e);
    }
    return e;
  }

  /** Whether a call may be dispatched, and why not when it may not. */
  check(
    key: string,
    nowMs: number
  ): { allowed: boolean; state: BreakerState; remainingMs: number } {
    const e = this.entry(key);
    if (e.state === "open") {
      const elapsed = nowMs - (e.openedAtMs ?? nowMs);
      if (elapsed >= e.openMs) {
        // Cooldown elapsed: allow exactly one trial request.
        e.state = "half-open";
        return { allowed: true, state: "half-open", remainingMs: 0 };
      }
      return { allowed: false, state: "open", remainingMs: e.openMs - elapsed };
    }
    return { allowed: true, state: e.state, remainingMs: 0 };
  }

  onSuccess(key: string): void {
    const e = this.entry(key);
    e.state = "closed";
    e.consecutiveFailures = 0;
    e.consecutiveAuthFailures = 0;
    e.openedAtMs = null;
    // A success resets the cooldown too, so a single bad spell does not penalise the next one.
    e.openMs = OPEN_BASE_MS;
  }

  onFailure(key: string, errorClass: LlmErrorClass, retryable: boolean, nowMs: number): void {
    const e = this.entry(key);

    if (e.state === "half-open") {
      // The trial failed: re-open with the cooldown doubled, capped.
      e.state = "open";
      e.openedAtMs = nowMs;
      e.openMs = Math.min(OPEN_CAP_MS, e.openMs * 2);
      return;
    }

    if (errorClass === "AUTH") {
      e.consecutiveAuthFailures++;
      if (e.consecutiveAuthFailures >= AUTH_TRIP_AT) {
        e.state = "open";
        e.openedAtMs = nowMs;
      }
      return;
    }

    if (!retryable) {
      // A permanent input problem says nothing about provider health, so it must not trip the
      // breaker: otherwise one malformed request would block every later call.
      return;
    }

    e.consecutiveFailures++;
    if (e.consecutiveFailures >= TRANSPORT_TRIP_AT) {
      e.state = "open";
      e.openedAtMs = nowMs;
    }
  }

  status(nowMs: number): BreakerStatus[] {
    return [...this.entries.entries()].map(([key, e]) => ({
      key,
      state: e.state,
      consecutiveFailures: e.consecutiveFailures,
      consecutiveAuthFailures: e.consecutiveAuthFailures,
      openedAtMs: e.openedAtMs,
      openMs: e.openMs,
      remainingCooldownMs:
        e.state === "open" && e.openedAtMs !== null
          ? Math.max(0, e.openMs - (nowMs - e.openedAtMs))
          : 0,
    }));
  }
}
