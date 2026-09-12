import type {
  ActionType,
  EvidenceCategory,
  ResetStrategy,
  SideEffectClass,
} from "@investigator/core";

/**
 * Execution-side shapes. Actions come from the closed vocabulary in `schemas/action.v1.json`; the
 * interpreter can execute nothing else, and there is no action that runs model-supplied source
 * (ADR-0006).
 */

export interface SelectorSpec {
  /**
   * `described` is the only NON-EXECUTABLE strategy: the reporter's own words for a control whose
   * selector nobody has established yet. It lets an interpreted flow say "the Verified filter"
   * instead of inventing `[data-testid=...]`. The interpreter refuses it, so a flow still carrying
   * one cannot silently run against a guess.
   */
  strategy: "testid" | "role" | "label" | "placeholder" | "text" | "css" | "xpath" | "described";
  value?: string;
  role?: string;
  name?: string;
  exact?: boolean;
  nth?: number;
}

export type TestDataValue =
  | { kind: "literal"; literal: string }
  | { kind: "generated"; generator: string; params?: Record<string, unknown> }
  | { kind: "secretRef"; envVar: string }
  | { kind: "unknown"; unknownId: string };

export type AssertionKind =
  | "elementCountAtLeast"
  | "elementCountEquals"
  | "elementVisible"
  | "elementHidden"
  | "textContains"
  | "textEquals"
  | "attributeEquals"
  | "urlMatches"
  | "noConsoleErrors"
  | "noUncaughtExceptions"
  | "responseStatusIn"
  | "storageKeyPresent"
  | "storageKeyAbsent";

export interface AssertionSpec {
  assertionId: string;
  kind: AssertionKind;
  selector?: SelectorSpec;
  min?: number;
  count?: number;
  text?: string;
  attribute?: string;
  expected?: string | number | boolean | null;
  urlPattern?: string;
  statuses?: number[];
  storageArea?: "localStorage" | "sessionStorage";
  storageKey?: string;
  timeoutMs?: number;
  /** When true, a MATCH indicates the product failure rather than a violated expectation. */
  isFailurePredicate?: boolean;
}

export interface ActionSpec {
  actionId: string;
  type: ActionType;
  description?: string;
  timeoutMs?: number;
  sideEffect?: SideEffectClass;
  computedSideEffect?: SideEffectClass;
  // Type-specific
  /**
   * Null when the reporter never gave a path. An interpretation must not invent one, so the gap
   * is carried explicitly and `unknownRef` names the unknown that has to be answered first.
   */
  url?: string | null;
  /** The `unknowns[].id` this action is waiting on, when a required value is absent. */
  unknownRef?: string;
  waitUntil?: "commit" | "domcontentloaded" | "load" | "networkidle";
  selector?: SelectorSpec;
  value?: TestDataValue;
  option?: string;
  key?: string;
  deltaX?: number;
  deltaY?: number;
  condition?:
    | "commit"
    | "domcontentloaded"
    | "load"
    | "networkidle"
    | "selectorVisible"
    | "selectorHidden"
    | "selectorAttached"
    | "selectorDetached";
  ms?: number;
  assertion?: AssertionSpec;
  fullPage?: boolean;
  area?: "localStorage" | "sessionStorage";
  areas?: Array<"localStorage" | "sessionStorage" | "cookies" | "indexedDb" | "cache">;
  profileName?: string;
}

/** The unit the executor consumes: an approved, post-edit experiment. */
export interface ExperimentSpec {
  experimentId: string;
  investigationId: string;
  actions: ActionSpec[];
  assertions: AssertionSpec[];
  repetitions: number;
  requiredEvidence: EvidenceCategory[];
  emulationProfile?: string;
  safety: {
    maxSideEffectClass: SideEffectClass;
    destructiveActionIds: string[];
    resetStrategy: ResetStrategy;
  };
  targetName: string;
}

export interface DeclaredFactor {
  kind: string;
  value: string | number | boolean | null;
  actionId?: string;
}
