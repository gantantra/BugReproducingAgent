/**
 * Fixture experiments. Shaped exactly like an approved, post-edit `ExperimentSpec`, so the
 * reliability gate exercises the real executor path rather than a test-only shortcut.
 *
 * Typed structurally rather than by importing @investigator/execution, because test-fixtures
 * must stay at the bottom of the dependency graph (ADR-0019).
 */

export interface FixtureAction {
  actionId: string;
  type: string;
  url?: string;
  waitUntil?: string;
  selector?: { strategy: string; value?: string; role?: string; name?: string; exact?: boolean };
  condition?: string;
  ms?: number;
  timeoutMs?: number;
  assertion?: FixtureAssertion;
}

export interface FixtureAssertion {
  assertionId: string;
  kind: string;
  selector?: { strategy: string; value?: string; role?: string; name?: string };
  min?: number;
  timeoutMs?: number;
  isFailurePredicate?: boolean;
}

export interface FixtureExperiment {
  experimentId: string;
  investigationId: string;
  actions: FixtureAction[];
  assertions: FixtureAssertion[];
  repetitions: number;
  requiredEvidence: string[];
  emulationProfile?: string;
  safety: {
    maxSideEffectClass: string;
    destructiveActionIds: string[];
    resetStrategy: string;
  };
  targetName: string;
}

const RESULT_CARDS: FixtureAssertion = {
  assertionId: "AS1",
  kind: "elementCountAtLeast",
  selector: { strategy: "testid", value: "result-card" },
  min: 1,
  timeoutMs: 3000,
};

function base(): Omit<FixtureExperiment, "experimentId" | "targetName" | "actions" | "assertions"> {
  return {
    investigationId: "INV-001",
    repetitions: 1,
    requiredEvidence: ["actions", "navigation", "console", "exceptions", "networkMetadata"],
    safety: {
      maxSideEffectClass: "read",
      destructiveActionIds: [],
      resetStrategy: "fresh-context",
    },
  };
}

/**
 * The performance fixture sequence (frozen decision 3): four actions — goto, click, waitFor,
 * assert — which is what the 100-sequential-run budget is measured against.
 */
export function searchExperiment(
  targetName: string,
  opts: { experimentId?: string; seedParam?: number; clickDelayMs?: number } = {}
): FixtureExperiment {
  const query = opts.seedParam === undefined ? "" : `?seed=${opts.seedParam}`;
  const actions: FixtureAction[] = [
    { actionId: "A1", type: "goto", url: `/search${query}`, waitUntil: "load" },
  ];
  if (opts.clickDelayMs !== undefined) {
    actions.push({ actionId: "A2", type: "waitForTimeout", ms: opts.clickDelayMs });
  }
  actions.push(
    {
      actionId: "A3",
      type: "click",
      selector: { strategy: "testid", value: "filter-verified" },
      timeoutMs: 5000,
    },
    { actionId: "A4", type: "waitFor", condition: "networkidle", timeoutMs: 5000 },
    { actionId: "A5", type: "assert", assertion: RESULT_CARDS }
  );

  return {
    ...base(),
    experimentId: opts.experimentId ?? "EXP-001",
    targetName,
    actions,
    assertions: [RESULT_CARDS],
  };
}

/** Targets a control that does not exist, so the approved action cannot execute (rule 3). */
export function automationFailingExperiment(targetName: string): FixtureExperiment {
  return {
    ...base(),
    experimentId: "EXP-AUTO",
    targetName,
    actions: [
      { actionId: "A1", type: "goto", url: "/search", waitUntil: "load" },
      {
        actionId: "A2",
        type: "click",
        selector: { strategy: "role", role: "button", name: "Verified" },
        timeoutMs: 1500,
      },
      { actionId: "A3", type: "assert", assertion: RESULT_CARDS },
    ],
    assertions: [RESULT_CARDS],
  };
}

/** Transport failure before the first successful navigation (rule 2). */
export function infrastructureFailingExperiment(targetName: string): FixtureExperiment {
  return {
    ...base(),
    experimentId: "EXP-INFRA",
    targetName,
    actions: [{ actionId: "A1", type: "goto", url: "/search", waitUntil: "load", timeoutMs: 4000 }],
    assertions: [RESULT_CARDS],
  };
}

/** Exercises network events that start in one action window and finish in a later one. */
export function straddlingExperiment(targetName: string): FixtureExperiment {
  return {
    ...base(),
    experimentId: "EXP-STRADDLE",
    targetName,
    actions: [
      { actionId: "A1", type: "goto", url: "/search", waitUntil: "load" },
      { actionId: "A2", type: "click", selector: { strategy: "testid", value: "filter-verified" } },
      { actionId: "A3", type: "waitForTimeout", ms: 50 },
      { actionId: "A4", type: "waitFor", condition: "networkidle", timeoutMs: 5000 },
    ],
    assertions: [],
  };
}

/** Emits cookies, auth headers, URL tokens, and PII for the redaction gate. */
export function sensitiveExperiment(targetName: string): FixtureExperiment {
  return {
    ...base(),
    experimentId: "EXP-SENSITIVE",
    targetName,
    actions: [
      { actionId: "A1", type: "goto", url: "/search", waitUntil: "load" },
      // Waits on an observable condition rather than networkidle: the fixture's own in-page
      // fetch can keep the network busy, and a timeout here would be a harness artefact.
      {
        actionId: "A2",
        type: "waitFor",
        condition: "selectorAttached",
        selector: { strategy: "css", value: "#results" },
        timeoutMs: 5000,
      },
      { actionId: "A3", type: "waitForTimeout", ms: 300 },
    ],
    assertions: [],
  };
}
