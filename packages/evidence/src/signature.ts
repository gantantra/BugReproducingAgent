/**
 * The target failure signature of an authored suite, and the predicate that counts a run as
 * matching it (ADR-0031).
 *
 * Derived, not proposed: a model reads the evidence and suggests what to vary, but WHICH failure
 * is being counted is fixed deterministically from the runs themselves, before any variant runs.
 * A run matches when it failed at the final check AND carries every console and exception
 * fingerprint that was present in all such failures and in no passing run. A failure at the check
 * without them is a different failure -- counted separately, never towards the rate.
 *
 * Pure: the same runs in the same order give the same signature.
 */

export interface TargetSignature {
  schemaVersion: "1.0.0";
  /** Only runs that failed at the script's final check can match. */
  atCheck: true;
  consoleFingerprints: string[];
  exceptionFingerprints: string[];
}

export interface SignatureRun {
  outcome: string;
  features: Record<string, unknown>;
}

const FAILED_AT_CHECK = "PRODUCT_FAILED";
const PASSED = "VALID_COMPLETED";

function consoleOf(run: SignatureRun): Set<string> {
  const counts = run.features["consoleCounts"] as
    { byFingerprint?: Record<string, number> } | undefined;
  return new Set(Object.keys(counts?.byFingerprint ?? {}));
}

function exceptionsOf(run: SignatureRun): Set<string> {
  const list = run.features["exceptionFingerprints"];
  if (!Array.isArray(list)) return new Set();
  return new Set(
    list.map((e) =>
      typeof e === "object" && e !== null
        ? String((e as { fingerprint?: unknown }).fingerprint)
        : String(e)
    )
  );
}

function discriminators(
  failing: readonly SignatureRun[],
  passing: readonly SignatureRun[],
  of: (r: SignatureRun) => Set<string>
): string[] {
  if (failing.length === 0) return [];
  const [first, ...rest] = failing.map(of);
  const inPassing = new Set(passing.flatMap((r) => [...of(r)]));
  return [...first!].filter((v) => rest.every((s) => s.has(v)) && !inPassing.has(v)).sort();
}

export function deriveTargetSignature(runs: readonly SignatureRun[]): TargetSignature {
  const failing = runs.filter((r) => r.outcome === FAILED_AT_CHECK);
  const passing = runs.filter((r) => r.outcome === PASSED);
  return {
    schemaVersion: "1.0.0",
    atCheck: true,
    consoleFingerprints: discriminators(failing, passing, consoleOf),
    exceptionFingerprints: discriminators(failing, passing, exceptionsOf),
  };
}

export function matchesSignature(signature: TargetSignature, run: SignatureRun): boolean {
  if (run.outcome !== FAILED_AT_CHECK) return false;
  const console = consoleOf(run);
  const exceptions = exceptionsOf(run);
  return (
    signature.consoleFingerprints.every((f) => console.has(f)) &&
    signature.exceptionFingerprints.every((f) => exceptions.has(f))
  );
}

export type SignatureCount = "matched" | "other-failure" | "passed" | "excluded";

/**
 * How one run counts. Only a match enters a rate's numerator; a pass enters only its
 * denominator; a failure at the check that does not match is counted apart; a run that never
 * reached the check says nothing about the bug and is excluded, as `rerun` already does.
 */
export function countRun(signature: TargetSignature, run: SignatureRun): SignatureCount {
  if (matchesSignature(signature, run)) return "matched";
  if (run.outcome === FAILED_AT_CHECK) return "other-failure";
  if (run.outcome === PASSED) return "passed";
  return "excluded";
}
