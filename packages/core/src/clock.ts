/**
 * Injected time. ADR-0007 bans ambient `Date.now()` from the execution and evidence paths so the
 * Normalization Plane stays a pure function of its inputs.
 *
 * Two time bases, deliberately separate:
 *  - wall time, for human-readable timestamps and for correlating with external systems
 *  - monotonic time, for durations and for ordering, because wall time can step backwards
 */
export interface Clock {
  /** Milliseconds since the epoch. */
  nowMs(): number;
  /** ISO-8601 with milliseconds, always UTC. */
  nowIso(): string;
  /** Monotonic milliseconds. Comparable only within one process. */
  monotonicMs(): number;
}

export class SystemClock implements Clock {
  nowMs(): number {
    return Date.now();
  }

  nowIso(): string {
    return new Date(this.nowMs()).toISOString();
  }

  monotonicMs(): number {
    // performance.now() is monotonic and unaffected by wall-clock adjustments.
    return performance.now();
  }
}

/**
 * Deterministic clock for tests. Wall and monotonic advance together, and both are
 * non-decreasing, which is what `monotonic_timestamps.spec.ts` asserts over real runs.
 */
export class FrozenClock implements Clock {
  private wall: number;
  private mono: number;
  private readonly autoAdvanceMs: number;

  constructor(startIso = "2026-01-01T00:00:00.000Z", autoAdvanceMs = 0) {
    this.wall = new Date(startIso).getTime();
    this.mono = 0;
    this.autoAdvanceMs = autoAdvanceMs;
  }

  nowMs(): number {
    const v = this.wall;
    if (this.autoAdvanceMs) this.advance(this.autoAdvanceMs);
    return v;
  }

  nowIso(): string {
    return new Date(this.nowMs()).toISOString();
  }

  monotonicMs(): number {
    const v = this.mono;
    if (this.autoAdvanceMs) this.advance(this.autoAdvanceMs);
    return v;
  }

  /** Advance both bases by the same amount. Never accepts a negative delta. */
  advance(ms: number): void {
    if (ms < 0) throw new Error("FrozenClock cannot move backwards");
    this.wall += ms;
    this.mono += ms;
  }

  setIso(iso: string): void {
    const next = new Date(iso).getTime();
    if (next < this.wall) throw new Error("FrozenClock cannot move backwards");
    this.mono += next - this.wall;
    this.wall = next;
  }
}

export const systemClock: Clock = new SystemClock();
