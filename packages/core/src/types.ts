/**
 * Domain vocabulary. These enums are the single source of truth in code; `schemas/common.v1.json`
 * is the single source of truth on the wire, and `tests/docs/vocabulary.spec.ts` asserts the two
 * agree bidirectionally so neither can drift.
 */

// ---------------------------------------------------------------------------
// Queue and outcome. Three orthogonal dimensions, never conflated (ADR-0005).
// ---------------------------------------------------------------------------

export const JOB_STATES = ["PENDING", "CLAIMED", "RUNNING", "TERMINAL"] as const;
export type JobState = (typeof JOB_STATES)[number];

export const JOB_TERMINAL_REASONS = ["COMPLETED", "INTERRUPTED", "WORKER_ERROR"] as const;
export type JobTerminalReason = (typeof JOB_TERMINAL_REASONS)[number];

export const RUN_OUTCOMES = [
  "VALID_COMPLETED",
  "PRODUCT_FAILED",
  "AUTOMATION_FAILED",
  "INFRASTRUCTURE_FAILED",
  "INTERRUPTED",
  "INCONCLUSIVE",
] as const;
export type RunOutcome = (typeof RUN_OUTCOMES)[number];

/**
 * Which ordered decision rule produced a RunOutcome. Recorded in every manifest so the
 * classification is explainable, and recomputed independently by the extractor.
 */
export const OUTCOME_RULE_IDS = [1, 2, 3, 4, 5, 6] as const;
export type OutcomeRuleId = (typeof OUTCOME_RULE_IDS)[number];

/** The legal (terminal reason, outcome) matrix. Mirrored by SQLite CHECK constraints. */
export const LEGAL_TERMINAL_OUTCOMES: Readonly<Record<JobTerminalReason, readonly RunOutcome[]>> = {
  COMPLETED: ["VALID_COMPLETED", "PRODUCT_FAILED", "AUTOMATION_FAILED", "INCONCLUSIVE"],
  INTERRUPTED: ["INTERRUPTED"],
  WORKER_ERROR: ["INFRASTRUCTURE_FAILED", "AUTOMATION_FAILED", "INCONCLUSIVE"],
};

export function isLegalTerminalOutcome(reason: JobTerminalReason, outcome: RunOutcome): boolean {
  return LEGAL_TERMINAL_OUTCOMES[reason].includes(outcome);
}

/**
 * Retry eligibility. AUTOMATION_FAILED is deliberately NOT retryable: it means the approved
 * sequence is wrong, which is a human decision surfaced at the next gate. PRODUCT_FAILED and
 * VALID_COMPLETED are never retried because they are observations.
 */
export function isRetryableOutcome(outcome: RunOutcome): boolean {
  return outcome === "INFRASTRUCTURE_FAILED" || outcome === "INTERRUPTED";
}

// ---------------------------------------------------------------------------
// Evidence completeness (ADR-0016)
// ---------------------------------------------------------------------------

export const EVIDENCE_CATEGORIES = [
  "actions",
  "navigation",
  "console",
  "exceptions",
  "networkMetadata",
  "responseBodies",
  "domSnapshots",
  "storage",
  "screenshots",
  "video",
  "trace",
  "webSocketFrames",
] as const;
export type EvidenceCategory = (typeof EVIDENCE_CATEGORIES)[number];

export const CAPTURE_STATUS_VALUES = [
  "complete",
  "partial",
  "missing",
  "redacted",
  "unsupported",
  "corrupted",
  "disabled",
] as const;
export type CaptureStatusValue = (typeof CAPTURE_STATUS_VALUES)[number];

export const CAPTURE_REASON_CODES = [
  "SIZE_LIMIT",
  "CONTENT_TYPE_NOT_CAPTURED",
  "POLICY_REDACTED",
  "CONFIG_OFF",
  "COLLECTOR_UNSUPPORTED",
  "RUN_INTERRUPTED",
  "PARSE_FAILED",
  "HASH_MISMATCH",
  "DROPPED_BACKPRESSURE",
  "TARGET_DETACHED",
  // Video-specific. A recording is raw pixels, so "captured" and "redacted" come apart for
  // it in a way they do not for text evidence -- these three say which happened.
  "PERSISTED_UNREDACTED",
  "NO_RECORDING_PRODUCED",
  "PERSIST_FAILED",
] as const;
export type CaptureReasonCode = (typeof CAPTURE_REASON_CODES)[number];

export interface CaptureReason {
  code: CaptureReasonCode;
  count: number;
  limitBytes?: number;
  detail?: string;
}

export interface CategoryStatus {
  status: CaptureStatusValue;
  expected?: number | null;
  collected?: number;
  reasons?: CaptureReason[];
}

export interface CaptureStatus {
  schemaVersion: "1.0.0";
  runId: string;
  versions: VersionStamps;
  redaction: RedactionStamp;
  categories: Record<EvidenceCategory, CategoryStatus>;
  limitations: string[];
  requiredCategories?: EvidenceCategory[];
  unsafeTrace?: boolean;
  unsafeDebug?: boolean;
}

// ---------------------------------------------------------------------------
// Findings (ADR-0012). Present in M1 only as vocabulary; no flow produces one yet.
// ---------------------------------------------------------------------------

export const FINDING_LEVELS = [
  "observed",
  "correlated",
  "probable_trigger",
  "high_confidence_trigger",
  "confirmed_trigger",
  "root_cause_hypothesis",
  "confirmed_root_cause",
] as const;

// ---------------------------------------------------------------------------
// Actions and side effects
// ---------------------------------------------------------------------------

export const ACTION_TYPES = [
  "goto",
  "click",
  "dblclick",
  "fill",
  "select",
  "check",
  "uncheck",
  "press",
  "hover",
  "scroll",
  "waitFor",
  "waitForTimeout",
  "assert",
  "screenshot",
  "setStorage",
  "clearStorage",
  "setEmulation",
  "reload",
  "goBack",
  "goForward",
] as const;
export type ActionType = (typeof ACTION_TYPES)[number];

/**
 * The closed set of assertion kinds, mirroring `action.v1.json#/$defs/assertion`.
 *
 * Stated here so a flow can be TOLD the vocabulary rather than discovering it by being refused:
 * a model that invented an assertion kind had its entire interpretation discarded, and nothing in
 * the prompt had ever listed the alternatives.
 */
export const ASSERTION_KINDS = [
  "elementCountAtLeast",
  "elementCountEquals",
  "elementVisible",
  "elementHidden",
  "textContains",
  "textEquals",
  "attributeEquals",
  "urlMatches",
  "noConsoleErrors",
  "noUncaughtExceptions",
  "responseStatusIn",
  "storageKeyPresent",
  "storageKeyAbsent",
] as const;
export type AssertionKind = (typeof ASSERTION_KINDS)[number];

export const SIDE_EFFECT_CLASSES = ["read", "local-write", "remote-write", "destructive"] as const;
export type SideEffectClass = (typeof SIDE_EFFECT_CLASSES)[number];

/** Worst-first, for comparing a declared class against the computed one. */
export const SIDE_EFFECT_SEVERITY: readonly SideEffectClass[] = [
  "read",
  "local-write",
  "remote-write",
  "destructive",
];

/** Static class per action type. The classifier may escalate an instance, never de-escalate it. */
export const ACTION_BASE_SIDE_EFFECT: Readonly<Record<ActionType, SideEffectClass>> = {
  goto: "read",
  click: "read",
  dblclick: "read",
  fill: "local-write",
  select: "local-write",
  check: "local-write",
  uncheck: "local-write",
  press: "read",
  hover: "read",
  scroll: "read",
  waitFor: "read",
  waitForTimeout: "read",
  assert: "read",
  screenshot: "read",
  setStorage: "local-write",
  clearStorage: "local-write",
  setEmulation: "read",
  reload: "read",
  goBack: "read",
  goForward: "read",
};

export const TARGET_CLASSIFICATIONS = ["fixture", "test", "staging"] as const;
export type TargetClassification = (typeof TARGET_CLASSIFICATIONS)[number];

export const RESET_STRATEGIES = [
  "none",
  "fresh-context",
  "seeded-storage-state",
  "scripted-reset",
  "per-run-tenant",
  "idempotent-only",
] as const;
export type ResetStrategy = (typeof RESET_STRATEGIES)[number];

export const GATES = ["experiment_selection", "target_failure", "final_reproduction"] as const;
export type Gate = (typeof GATES)[number];

export const MODEL_ALIASES = ["FAST_MODEL", "REASONING_MODEL", "FALLBACK_MODEL"] as const;
export type ModelAlias = (typeof MODEL_ALIASES)[number];

// ---------------------------------------------------------------------------
// Artifacts and redaction
// ---------------------------------------------------------------------------

export const ARTIFACT_KINDS = [
  "trace",
  "video",
  "screenshot",
  "dom-snapshot",
  "network-log",
  "console-log",
  "storage-snapshot",
  "raw-event-log",
  "normalized-evidence",
  "run-manifest",
  "proposal",
  "effective-proposal",
  "approval-file",
  "intake-report",
  // The structured interpretation of an intake report, produced by `intake_to_flow`. An artifact
  // rather than a return value: `propose_experiments` reads it through `get_flow`, so the
  // interpretation a model proposes from is the same bytes a human can inspect and cite.
  "flow",
  "statistics",
  "reproducer-package",
  "report",
  "reset-script-output",
  "storage-state",
] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

export interface AppliedRule {
  ruleId: string;
  occurrences: number;
}

/**
 * Proof that redaction ran. Required by every persistence entry point (ADR-0008); a store call
 * without one is REDACTION_NOT_APPLIED. This is the type-level form of "fail closed".
 */
export interface RedactionStamp {
  policyId: string;
  policyVersion: string;
  policyHash: string;
  mode: "strict" | "permissive";
  appliedRules: AppliedRule[];
}

export interface ArtifactRef {
  artifactId: string;
  runId?: string;
  kind: ArtifactKind;
  filename: string;
  contentType: string;
  byteLength: number;
  /** Computed by the store, never supplied by the caller (ADR-0004). */
  sha256: string;
  storedAt: string;
  redactionApplied: RedactionStamp;
  tombstoned?: boolean;
  tombstonedAt?: string;
  tombstoneReason?: string;
}

export interface VersionStamps {
  collectorVersion: string;
  normalizerVersion: string;
  extractorVersion: string;
}

// ---------------------------------------------------------------------------
// Emulation (ADR-0014). Resolved values read back from the live browser, not profile names.
// ---------------------------------------------------------------------------

export interface Dimensions {
  width: number;
  height: number;
}

export interface ResolvedEmulationValues {
  viewport: Dimensions;
  screen: Dimensions;
  deviceScaleFactor: number;
  isMobile: boolean;
  hasTouch: boolean;
  maxTouchPoints?: number;
  userAgent: string;
  userAgentSource?: "config" | "browser-default" | "read-back";
  locale: string;
  timezoneId: string;
  colorScheme: "light" | "dark" | "no-preference";
  reducedMotion?: "reduce" | "no-preference";
  forcedColors?: "active" | "none";
  network?: {
    profile: string;
    downloadKbps: number;
    uploadKbps: number;
    latencyMs: number;
    offline: boolean;
  } | null;
  cpu?: { throttlingRate: number } | null;
  geolocation?: Record<string, unknown> | null;
  permissions?: string[];
}

export interface EmulationDiscrepancy {
  field: string;
  requested: JsonPrimitive;
  observed: JsonPrimitive;
}

export interface ResolvedEmulation {
  profileName: string;
  profileSource: string;
  resolved: ResolvedEmulationValues;
  browser: {
    engine: "chromium";
    channel?: string | null;
    playwrightVersion: string;
    /** Observed at launch. Never templated, never assumed. */
    browserVersion: string;
    headless: boolean;
    launchArgs?: string[];
  };
  discrepancies?: EmulationDiscrepancy[];
}

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

export type JsonPrimitive = string | number | boolean | null;

export type ConfigSource = "cli-flag" | "env" | "config-file" | "built-in-default";

export interface ConfigSourceEntry {
  value: JsonPrimitive;
  source: ConfigSource;
}
