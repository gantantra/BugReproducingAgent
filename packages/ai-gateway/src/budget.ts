/**
 * Six-dimension budget enforcement and cost accounting.
 *
 * Playwright produces evidence. Deterministic software normalizes and measures evidence. DeepSeek interprets and prioritizes evidence. Humans authorize consequential transitions.
 *
 * Budget exhaustion returns a TYPED stop reason. It never truncates silently, and it never lets a
 * flow "finish" on partial information without saying so — a flow that ran out of turns and
 * reported a conclusion anyway would be indistinguishable from one that actually concluded.
 *
 * Cost is checked BEFORE dispatch against committed spend plus the worst case of the call about to
 * be made. Checking afterwards would mean the ceiling is discovered by exceeding it.
 */

export const BUDGET_DIMENSIONS = [
  "BUDGET_TOKENS",
  "BUDGET_COST",
  "BUDGET_TURNS",
  "BUDGET_WALLCLOCK",
  "BUDGET_TOOL_CALLS",
  "BUDGET_REPAIRS",
] as const;
export type BudgetStopReason = (typeof BUDGET_DIMENSIONS)[number];

export interface BudgetLimits {
  maxTotalTokens: number;
  maxUsd: number | null;
  maxTurns: number;
  maxWallClockMs: number;
  maxToolCalls: number;
  maxRepairs: number;
}

export interface BudgetSpend {
  totalTokens: number;
  usd: number;
  turns: number;
  elapsedMs: number;
  toolCalls: number;
  repairs: number;
}

export const ZERO_SPEND: BudgetSpend = {
  totalTokens: 0,
  usd: 0,
  turns: 0,
  elapsedMs: 0,
  toolCalls: 0,
  repairs: 0,
};

export interface ModelPrice {
  inputUsdPerMillionTokens: number;
  outputUsdPerMillionTokens: number;
}

export interface CostEstimate {
  usd: number | null;
  /** Present when no price is declared for the model in use. */
  warning: "UNPRICED_MODEL" | null;
}

/**
 * Cost from a config-declared price table. The agent NEVER invents a price: an unpriced model
 * yields `null` plus an `UNPRICED_MODEL` warning, and budget enforcement falls back to token
 * ceilings. A guessed price would make a spend ceiling meaningless in exactly the case where it
 * matters — a model nobody has priced yet.
 */
export function estimateCost(
  modelId: string,
  promptTokens: number,
  completionTokens: number,
  prices: Record<string, ModelPrice> | undefined
): CostEstimate {
  const price = prices?.[modelId];
  if (!price) return { usd: null, warning: "UNPRICED_MODEL" };
  const usd =
    (promptTokens / 1_000_000) * price.inputUsdPerMillionTokens +
    (completionTokens / 1_000_000) * price.outputUsdPerMillionTokens;
  return { usd, warning: null };
}

export interface PreflightArgs {
  limits: BudgetLimits;
  spent: BudgetSpend;
  /** Worst case for the call about to be dispatched. */
  plannedPromptTokens: number;
  plannedMaxOutputTokens: number;
  modelId: string;
  prices: Record<string, ModelPrice> | undefined;
  /** Committed spend across the whole investigation, which outranks the flow budget. */
  investigationUsdSpent?: number;
  investigationUsdCeiling?: number | null;
}

export interface PreflightResult {
  allowed: boolean;
  stopReason: BudgetStopReason | null;
  detail: string;
  warnings: string[];
  worstCaseUsd: number | null;
}

/**
 * Pre-dispatch check across every dimension that can be known in advance.
 *
 * The investigation ceiling wins over the flow budget: a flow that fits its own budget must still
 * not push the investigation past what the operator authorised for the whole thing.
 */
export function preflight(args: PreflightArgs): PreflightResult {
  const { limits, spent } = args;
  const warnings: string[] = [];

  if (spent.turns >= limits.maxTurns) {
    return {
      allowed: false,
      stopReason: "BUDGET_TURNS",
      detail: `turn limit ${limits.maxTurns} reached`,
      warnings,
      worstCaseUsd: null,
    };
  }
  if (spent.elapsedMs >= limits.maxWallClockMs) {
    return {
      allowed: false,
      stopReason: "BUDGET_WALLCLOCK",
      detail: `wall-clock budget ${limits.maxWallClockMs}ms exhausted`,
      warnings,
      worstCaseUsd: null,
    };
  }
  // `maxToolCalls: 0` means the flow is TOOL-FREE, not that its tool budget is spent. Without the
  // `> 0` guard, `0 >= 0` refused the first call of every single-shot flow -- `intake_to_flow`
  // could never run at all, and said "budget exhausted: BUDGET_TOOL_CALLS" while doing it.
  //
  // Exhaustion is also only ever a reason to stop CALLING TOOLS, never a reason to refuse a plain
  // text turn; the model can still answer from what it already gathered.
  if (limits.maxToolCalls > 0 && spent.toolCalls >= limits.maxToolCalls) {
    return {
      allowed: false,
      stopReason: "BUDGET_TOOL_CALLS",
      detail: `tool-call limit ${limits.maxToolCalls} reached`,
      warnings,
      worstCaseUsd: null,
    };
  }
  if (spent.repairs > limits.maxRepairs) {
    return {
      allowed: false,
      stopReason: "BUDGET_REPAIRS",
      detail: `repair limit ${limits.maxRepairs} exceeded`,
      warnings,
      worstCaseUsd: null,
    };
  }

  const worstCaseTokens =
    spent.totalTokens + args.plannedPromptTokens + args.plannedMaxOutputTokens;
  if (worstCaseTokens > limits.maxTotalTokens) {
    return {
      allowed: false,
      stopReason: "BUDGET_TOKENS",
      detail: `worst-case ${worstCaseTokens} tokens would exceed the ${limits.maxTotalTokens} budget`,
      warnings,
      worstCaseUsd: null,
    };
  }

  const estimate = estimateCost(
    args.modelId,
    args.plannedPromptTokens,
    args.plannedMaxOutputTokens,
    args.prices
  );
  if (estimate.warning) warnings.push(estimate.warning);

  if (estimate.usd !== null) {
    if (limits.maxUsd !== null && spent.usd + estimate.usd > limits.maxUsd) {
      return {
        allowed: false,
        stopReason: "BUDGET_COST",
        detail: `worst-case $${(spent.usd + estimate.usd).toFixed(4)} would exceed the flow ceiling $${limits.maxUsd}`,
        warnings,
        worstCaseUsd: estimate.usd,
      };
    }
    const invCeiling = args.investigationUsdCeiling ?? null;
    if (invCeiling !== null) {
      const invWorstCase = (args.investigationUsdSpent ?? 0) + estimate.usd;
      if (invWorstCase > invCeiling) {
        return {
          allowed: false,
          stopReason: "BUDGET_COST",
          detail: `worst-case $${invWorstCase.toFixed(4)} would exceed the INVESTIGATION ceiling $${invCeiling}`,
          warnings,
          worstCaseUsd: estimate.usd,
        };
      }
    }
  }

  return {
    allowed: true,
    stopReason: null,
    detail: "within budget",
    warnings,
    worstCaseUsd: estimate.usd,
  };
}

/** Running spend tracker for one flow. */
export class BudgetTracker {
  private spend: BudgetSpend = { ...ZERO_SPEND };

  constructor(
    readonly limits: BudgetLimits,
    private readonly startedAtMs: number
  ) {}

  get spent(): BudgetSpend {
    return { ...this.spend };
  }

  /** Absolute deadline every retry must respect. */
  deadlineMs(): number {
    return this.startedAtMs + this.limits.maxWallClockMs;
  }

  elapsed(nowMs: number): number {
    return nowMs - this.startedAtMs;
  }

  chargeCall(args: { totalTokens: number; usd: number | null; nowMs: number }): void {
    this.spend.turns++;
    this.spend.totalTokens += args.totalTokens;
    if (args.usd !== null) this.spend.usd += args.usd;
    this.spend.elapsedMs = this.elapsed(args.nowMs);
  }

  /**
   * A tool call is charged whether or not it was allowed.
   *
   * Charging a refused call is deliberate: an out-of-allowlist attempt consumes budget so that a
   * model cannot probe the allowlist for free, and the attempt stays visible in the accounting.
   */
  chargeToolCall(nowMs: number): void {
    this.spend.toolCalls++;
    this.spend.elapsedMs = this.elapsed(nowMs);
  }

  chargeRepair(nowMs: number): void {
    this.spend.repairs++;
    this.spend.elapsedMs = this.elapsed(nowMs);
  }

  /** Dimensions already exhausted, without planning a specific call. */
  exhausted(nowMs: number): BudgetStopReason | null {
    if (this.spend.turns >= this.limits.maxTurns) return "BUDGET_TURNS";
    if (this.elapsed(nowMs) >= this.limits.maxWallClockMs) return "BUDGET_WALLCLOCK";
    // See `preflight`: zero is "tools not permitted", not "tool budget spent".
    if (this.limits.maxToolCalls > 0 && this.spend.toolCalls >= this.limits.maxToolCalls) {
      return "BUDGET_TOOL_CALLS";
    }
    if (this.spend.totalTokens >= this.limits.maxTotalTokens) return "BUDGET_TOKENS";
    if (this.limits.maxUsd !== null && this.spend.usd >= this.limits.maxUsd) return "BUDGET_COST";
    if (this.spend.repairs > this.limits.maxRepairs) return "BUDGET_REPAIRS";
    return null;
  }
}
