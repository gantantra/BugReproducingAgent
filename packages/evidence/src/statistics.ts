/**
 * Internal statistics for the confirmation loop (ADR-0031).
 *
 * Deterministic arithmetic over counts. Nothing here is shown in the UI: the settings are frozen
 * into the experiment config when the operator confirms, and the result view shows plain counts
 * and a verdict. Defaults are conservative and live here, overridable only by internal config.
 */

export interface StatisticalSettings {
  /** Two-sided confidence level for each arm's interval. */
  confidence: number;
  /** Significance level for the Fisher exact test. */
  alpha: number;
  /** Runs that reached the final check, per arm, below which no trigger is claimed. */
  minReachedPerArm: number;
}

export const DEFAULT_STATISTICAL_SETTINGS: StatisticalSettings = {
  confidence: 0.95,
  alpha: 0.05,
  minReachedPerArm: 10,
};

export interface Interval {
  low: number;
  high: number;
}

/** Standard normal quantile for the two-sided confidence levels this system uses. */
function zFor(confidence: number): number {
  const table: Record<string, number> = { "0.9": 1.644854, "0.95": 1.959964, "0.99": 2.575829 };
  const z = table[String(confidence)];
  if (z === undefined) throw new RangeError(`unsupported confidence level ${confidence}`);
  return z;
}

/** Wilson score interval for x successes in n trials. n = 0 gives the uninformative [0, 1]. */
export function wilsonInterval(x: number, n: number, confidence = 0.95): Interval {
  if (!Number.isInteger(x) || !Number.isInteger(n) || x < 0 || n < 0 || x > n) {
    throw new RangeError(`invalid counts ${x}/${n}`);
  }
  if (n === 0) return { low: 0, high: 1 };
  const z = zFor(confidence);
  const p = x / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { low: Math.max(0, centre - half), high: Math.min(1, centre + half) };
}

function logFactorial(n: number): number {
  let s = 0;
  for (let i = 2; i <= n; i++) s += Math.log(i);
  return s;
}

/**
 * Two-sided Fisher exact test on the 2x2 table [[a, b], [c, d]]: the probability, under
 * independence with the margins fixed, of a table at least as extreme as the one observed.
 */
export function fisherExactTwoSided(a: number, b: number, c: number, d: number): number {
  for (const v of [a, b, c, d]) {
    if (!Number.isInteger(v) || v < 0) throw new RangeError(`invalid cell ${v}`);
  }
  const row1 = a + b;
  const row2 = c + d;
  const col1 = a + c;
  const n = row1 + row2;
  if (n === 0) return 1;
  const lf = (k: number): number => logFactorial(k);
  const base = lf(row1) + lf(row2) + lf(col1) + lf(n - col1) - lf(n);
  const prob = (x: number): number =>
    Math.exp(base - lf(x) - lf(row1 - x) - lf(col1 - x) - lf(row2 - col1 + x));
  const observed = prob(a);
  const lo = Math.max(0, col1 - row2);
  const hi = Math.min(row1, col1);
  let p = 0;
  for (let x = lo; x <= hi; x++) {
    const px = prob(x);
    // Relative tolerance, so tables exactly as likely as the observed one are included.
    if (px <= observed * (1 + 1e-7)) p += px;
  }
  return Math.min(1, p);
}

export interface ArmCounts {
  /** Runs that failed at the check and matched the target signature. */
  matched: number;
  /** Runs that reached the check: matched + other failures at the check + passes. */
  reached: number;
  /** Failures at the check that did not match the signature, shown but never counted. */
  otherFailures: number;
  /** Runs that never reached the check. */
  excluded: number;
}

export interface ConfirmationVerdict {
  verdict: "high_confidence_trigger" | "not_confirmed";
  variantRate: number;
  controlRate: number;
  variantInterval: Interval;
  controlInterval: Interval;
  pValue: number;
  /** Why not confirmed, in plain words; absent when confirmed. */
  reason?: string;
}

/**
 * Confirmed only when both arms reached the check often enough, the variant's matched rate is
 * higher, the two intervals do not overlap, and the difference is significant. Anything less is
 * "not confirmed", with the reason.
 */
export function decideConfirmation(
  variant: ArmCounts,
  control: ArmCounts,
  settings: StatisticalSettings = DEFAULT_STATISTICAL_SETTINGS
): ConfirmationVerdict {
  const variantInterval = wilsonInterval(variant.matched, variant.reached, settings.confidence);
  const controlInterval = wilsonInterval(control.matched, control.reached, settings.confidence);
  const variantRate = variant.reached ? variant.matched / variant.reached : 0;
  const controlRate = control.reached ? control.matched / control.reached : 0;
  const pValue = fisherExactTwoSided(
    variant.matched,
    variant.reached - variant.matched,
    control.matched,
    control.reached - control.matched
  );
  const base = { variantRate, controlRate, variantInterval, controlInterval, pValue };

  if (variant.reached < settings.minReachedPerArm || control.reached < settings.minReachedPerArm) {
    return {
      ...base,
      verdict: "not_confirmed",
      reason: `too few runs reached the final check (${variant.reached} with the change, ${control.reached} without; at least ${settings.minReachedPerArm} each are needed)`,
    };
  }
  if (variantRate <= controlRate) {
    return {
      ...base,
      verdict: "not_confirmed",
      reason: "the bug was not more frequent with the change than without it",
    };
  }
  if (variantInterval.low <= controlInterval.high) {
    return {
      ...base,
      verdict: "not_confirmed",
      reason: "the two rates are too close to tell apart with this many runs",
    };
  }
  if (pValue >= settings.alpha) {
    return {
      ...base,
      verdict: "not_confirmed",
      reason: "the difference could be chance with this many runs",
    };
  }
  return { ...base, verdict: "high_confidence_trigger" };
}
