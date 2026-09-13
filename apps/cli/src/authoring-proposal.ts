import { classifyExperiment } from "@investigator/execution";
import type { AssertionSpec, ExperimentSpec, SelectorSpec } from "@investigator/execution";

import type { TranslatedAction } from "./authoring-actions.js";

/**
 * Assembling a gate-1 proposal from an authoring session, so the flow a human watched work can
 * be measured by the deterministic runner.
 *
 * WHY A GATE PROPOSAL AND NOT A NEW COMMAND
 *
 * `investigate plan --from <file>` already renders any proposal into the checksum-bound triple a
 * human approves, and says so in its own words: the gate does not care who drafted it. `run` then
 * reads the EFFECTIVE proposal — the post-edit document the approval recorded — and builds its
 * experiment straight from the approved item's `actions`, `assertions`, `repetitions`,
 * `requiredEvidence` and `safety`. So an authoring session does not need a new gate, a new
 * approval type, or a change to either command. It needs to write one file in a shape that
 * already exists.
 *
 * That is also why `repetitions` lives in the item rather than in a flag: "N runs as the operator
 * approved" is literally the operator editing this number before approving, and the checksum
 * binds the approval to the edited bytes.
 *
 * MECHANICAL VERSUS AUTHORED
 *
 * The structural fields are derived here and are the same for every authored reproduction: the
 * varied factor is `repetitionOnly` because nothing IS varied — an intermittent bug is measured
 * by repeating one flow, not by contrasting two. The falsifier follows from that mechanically.
 *
 * The descriptive fields come from the session, by way of the plan the operator already read and
 * approved before the browser opened. Nothing here writes prose about the application: a
 * hypothesis invented at assembly time would be this file guessing at a bug it never saw, and it
 * would be presented to a human at a gate as though the session had said it.
 */

export interface AuthoredProposalInput {
  investigationId: string;
  /** Translated, round-trip-verified actions from the session that worked. */
  actions: readonly TranslatedAction[];
  /** The plan the operator approved before the browser opened. Authored, already human-read. */
  approvedPlan: string;
  /** The reporter's own words, for the person deciding at the gate. */
  reportSummary?: string;
  /** Default repetition count. The operator edits it before approving; that edit is the decision. */
  repetitions: number;
  /** Target name the investigation is bound to, carried through to the run. */
  emulationProfile?: string;
  authoredAt: string;
  /** Brief version, so a proposal can be traced to the instructions that produced it. */
  briefVersion: string;
}

export type AuthoredProposalResult =
  | { ok: true; proposal: Record<string, unknown>; experimentId: string }
  | { ok: false; reason: string };

/**
 * Evidence a reproduction run must capture for the analysis to have anything to contrast.
 *
 * These are `common.v1.json#/$defs/evidenceCategory` values, not Playwright's names for the same
 * things — `networkMetadata` rather than "request"/"response". `contrastRuns` computes what
 * separates failing runs from passing ones out of exactly these categories, so a category left
 * out here is a question the analysis cannot answer later, and `video` is what a human reviews
 * at the final gate.
 */
const REQUIRED_EVIDENCE = [
  "actions",
  "navigation",
  "console",
  "exceptions",
  "networkMetadata",
  "video",
  "trace",
] as const;

/**
 * Turn the session's closing check into the assertion the run is classified by.
 *
 * The authored flow ends with a `waitFor` because `whyStepsCannotMeasure` refuses to emit one
 * that does not — a script with no failable step reports a pass on every run whatever the
 * application does. That closing check is what the run outcome has to hang on, so it is
 * mirrored here as an assertion rather than left implicit in the action list.
 *
 * `isFailurePredicate` stays FALSE. The check describes the application WORKING — the text that
 * appears when the flow succeeds — so a match is the healthy case and a miss is the bug. Marking
 * it as a failure predicate would inverted the classification and report a clean run as a
 * reproduction.
 */
function assertionFromActions(actions: readonly TranslatedAction[]): AssertionSpec | null {
  for (let i = actions.length - 1; i >= 0; i--) {
    const a = actions[i]!.action as unknown as Record<string, unknown>;
    if (a["type"] !== "waitFor") continue;
    const condition = String(a["condition"] ?? "");
    const selector = a["selector"] as SelectorSpec | undefined;
    if (!selector) continue;
    if (condition === "selectorVisible" || condition === "selectorAttached") {
      return { assertionId: "AS1", kind: "elementVisible", selector, isFailurePredicate: false };
    }
    if (condition === "selectorHidden" || condition === "selectorDetached") {
      return { assertionId: "AS1", kind: "elementHidden", selector, isFailurePredicate: false };
    }
  }
  return null;
}

/** The first line of the plan that reads like a statement of what is being reproduced. */
function firstMeaningfulLine(text: string): string {
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/^[\s#>*\-0-9.)]+/, "").trim();
    if (line.length >= 12) return line;
  }
  return "";
}

export function buildAuthoredGateProposal(input: AuthoredProposalInput): AuthoredProposalResult {
  if (input.actions.length === 0) {
    return { ok: false, reason: "the session produced no executable actions" };
  }
  const assertion = assertionFromActions(input.actions);
  if (!assertion) {
    return {
      ok: false,
      reason:
        "the translated actions contain no check that can fail, so a run of them could not be classified. The session needed to end with a browser_wait_for on text present when the flow works",
    };
  }

  const experimentId = "EXP-001";

  /* The declared safety class is COMPUTED, not asserted.
   *
   * `safety.destructiveActionIds` "must equal or exceed the deterministic classifier result; a
   * weaker declaration fails validation", and the class enum is
   * `read | local-write | remote-write | destructive` — so a hand-written guess here is both
   * likely wrong and pointless, since the same classifier decides whether it was good enough at
   * enqueue time. Running it now means the proposal a human reads at the gate already states the
   * real class of what they are approving. */
  const classification = classifyExperiment({
    experimentId,
    investigationId: input.investigationId,
    actions: input.actions.map((a) => a.action),
    assertions: [],
    repetitions: input.repetitions,
    requiredEvidence: [],
    safety: {
      maxSideEffectClass: "read",
      destructiveActionIds: [],
      resetStrategy: "fresh-context",
    },
  } as unknown as ExperimentSpec);
  const authored = firstMeaningfulLine(input.approvedPlan);
  const summary = input.reportSummary?.trim() ?? "";

  const item: Record<string, unknown> = {
    itemId: experimentId,
    rank: 1,
    // Authored: the operator already read and approved this sentence as the plan.
    hypothesis: authored
      ? `The authored flow reproduces the reported behaviour: ${authored}`
      : "The authored flow reproduces the reported behaviour.",
    // Mechanical: nothing is varied between runs, which is the whole method for an intermittent
    // fault. The schema has a `repetitionOnly` kind precisely for this.
    variedFactor: "repetitionOnly — the same approved flow, repeated without variation",
    // Mechanical: the negation of the hypothesis, stated as an observation.
    falsifier: `Every one of the ${input.repetitions} runs completes with ${describeAssertion(assertion)} — the flow never fails, so it does not reproduce the report and the failure lies outside what this flow exercises.`,
    expectedDiscriminatingSignal:
      "Runs that fail differ from runs that pass in console errors, request ordering or response status at the step the check guards.",
    rankRationale:
      "The only experiment: this is the flow a human watched reach the reported behaviour, not one of several candidate hypotheses.",
    /* Each action carries the statement it came from in `description`, which `action.v1` already
     * declares. The gate item itself is `additionalProperties: false`, and widening a schema
     * shared by every proposal just to hang an audit trail on this one would be the wrong place
     * to put it — the provenance belongs to the action, not to the bundle. */
    actions: input.actions.map((a) => ({
      ...(a.action as unknown as Record<string, unknown>),
      description: a.statement,
    })),
    assertions: [assertion as unknown as Record<string, unknown>],
    repetitions: input.repetitions,
    requiredEvidence: [...REQUIRED_EVIDENCE],
    ...(input.emulationProfile ? { emulationProfile: input.emulationProfile } : {}),
    safety: {
      maxSideEffectClass: classification.maxClass,
      destructiveActionIds: classification.destructiveActionIds,
      // Every run gets a new browser context. The authored flow may still write to the server,
      // which is why this is declared rather than assumed: `destructive-classifier` refuses a
      // sequence that writes when the target declares no server-side reset.
      // The gate item's `safety` is stricter than the standalone experiment proposal's: no
      // `notes`. The provenance it would have carried is on each action's `description`.
      resetStrategy: "fresh-context",
    },
  };

  const proposal: Record<string, unknown> = {
    schemaVersion: "1.0.0",
    gate: "experiment_selection",
    investigationId: input.investigationId,
    renderedAt: input.authoredAt,
    summary: [
      "Authored reproduction, ready to measure.",
      summary ? `Reported: ${summary}` : "",
      `Approve to run the flow ${input.repetitions} times with full evidence capture. Edit \`repetitions\` first if you want a different count — the approval binds to what you approve.`,
      `Authoring brief ${input.briefVersion}.`,
    ]
      .filter(Boolean)
      .join("\n"),
    items: [item],
  };

  return { ok: true, proposal, experimentId };
}

function describeAssertion(a: AssertionSpec): string {
  return a.kind === "elementHidden" ? "the watched element gone" : "the watched element visible";
}
