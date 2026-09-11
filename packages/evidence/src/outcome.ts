import type {
  CaptureStatus,
  EvidenceCategory,
  OutcomeRuleId,
  RunOutcome,
} from "@investigator/core";
import { requiredEvidenceUsable } from "./capture-status.js";
import type { AssertionOutcome } from "./extract.js";

/**
 * RunOutcome decision rules (ADR-0005).
 *
 * Six ordered rules, first match wins, with the matching rule id recorded so every
 * classification is explainable and testable. The ORDER carries the design:
 *
 *  - Rule 3 (automation) precedes rule 4 (product) so a broken script is never reported as a
 *    defect. Inventing defects is the worst failure this system could have.
 *  - Rule 6 follows rule 5 so a green run with a missing required evidence category is
 *    INCONCLUSIVE rather than a proof of correctness.
 *  - Rules 2 and 3 are separated by BOUNDARY: failures attributable to the harness, host, or
 *    environment are infrastructure; failures attributable to the automation instructions
 *    interacting with the application are automation. Genuine ambiguity goes to INCONCLUSIVE,
 *    never to PRODUCT_FAILED.
 */

export interface OutcomeInputs {
  interrupted: boolean;
  infrastructureFailure: { reason: string } | null;
  automationFailure: { reason: string; actionId?: string } | null;
  assertionOutcomes: readonly AssertionOutcome[];
  consoleErrorCount: number;
  exceptionCount: number;
  captureStatus: CaptureStatus;
  requiredCategories: readonly EvidenceCategory[];
}

export interface OutcomeDecision {
  outcome: RunOutcome;
  ruleId: OutcomeRuleId;
  detail: string;
}

export const OUTCOME_RULES: Readonly<Record<OutcomeRuleId, string>> = {
  1: "Killed, lease expired, or terminated mid-run",
  2: "Harness, host, or environment failure before the first successful navigation",
  3: "Automation instructions failed against the application",
  4: "A declared product assertion failed or a failure predicate matched",
  5: "All assertions passed and required evidence categories are usable",
  6: "Anything else, including green with a missing required evidence category",
};

export function decideOutcome(input: OutcomeInputs): OutcomeDecision {
  // Rule 1 — interruption. Checked first: nothing else about the run is trustworthy.
  if (input.interrupted) {
    return { outcome: "INTERRUPTED", ruleId: 1, detail: OUTCOME_RULES[1] };
  }

  // Rule 2 — infrastructure. The harness or the environment failed, not the product.
  if (input.infrastructureFailure) {
    return {
      outcome: "INFRASTRUCTURE_FAILED",
      ruleId: 2,
      detail: `${OUTCOME_RULES[2]}: ${input.infrastructureFailure.reason}`,
    };
  }

  // Rule 3 — automation. BEFORE product, deliberately: a missing selector or an out-of-allowlist
  // navigation means our instructions were wrong, and reporting that as a defect would invent one.
  if (input.automationFailure) {
    return {
      outcome: "AUTOMATION_FAILED",
      ruleId: 3,
      detail: `${OUTCOME_RULES[3]}: ${input.automationFailure.reason}`,
    };
  }

  // Rule 4 — product. A declared assertion failed, or a declared failure predicate matched.
  const failedAssertions = input.assertionOutcomes.filter((a) => a.result === "fail");
  const matchedPredicates = input.assertionOutcomes.filter(
    (a) => a.isFailurePredicate && a.result === "pass"
  );
  if (failedAssertions.length > 0 || matchedPredicates.length > 0) {
    const parts: string[] = [];
    if (failedAssertions.length) {
      parts.push(`assertions failed: ${failedAssertions.map((a) => a.assertionId).join(", ")}`);
    }
    if (matchedPredicates.length) {
      parts.push(
        `failure predicates matched: ${matchedPredicates.map((a) => a.assertionId).join(", ")}`
      );
    }
    return {
      outcome: "PRODUCT_FAILED",
      ruleId: 4,
      detail: `${OUTCOME_RULES[4]} (${parts.join("; ")})`,
    };
  }

  // Rule 5 — valid. Everything declared passed AND the required evidence is actually usable.
  const evidence = requiredEvidenceUsable(input.captureStatus, input.requiredCategories);
  const anyEvaluated = input.assertionOutcomes.some((a) => a.result !== "not-evaluated");
  if (evidence.ok && anyEvaluated) {
    return { outcome: "VALID_COMPLETED", ruleId: 5, detail: OUTCOME_RULES[5] };
  }

  // Rule 6 — inconclusive. Green with missing required evidence is not proof of correctness,
  // and neither is a run in which nothing was actually asserted.
  const why = !evidence.ok
    ? `required evidence unusable: ${evidence.offending
        .map((o) => `${o.category}=${o.status}`)
        .join(", ")}`
    : "no assertion was evaluated";
  return { outcome: "INCONCLUSIVE", ruleId: 6, detail: `${OUTCOME_RULES[6]} (${why})` };
}
