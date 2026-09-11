import type { SideEffectClass, TargetClassification } from "@investigator/core";
import { ACTION_BASE_SIDE_EFFECT, SIDE_EFFECT_SEVERITY, fail } from "@investigator/core";
import type { ActionSpec, ExperimentSpec } from "./types.js";

/**
 * Deterministic side-effect classifier (docs/architecture/test-data-and-side-effects.md).
 *
 * The recorded classification is ALWAYS this classifier's, never the model's declaration. A
 * proposal declaring a weaker class than the computed one fails validation, so the disagreement
 * surfaces at gate 1 rather than at run time.
 *
 * It errs toward `destructive`: an ambiguous control costs one acknowledgement line and prevents
 * one bad afternoon.
 */

const DEFAULT_DESTRUCTIVE_PATTERNS: readonly RegExp[] = [
  /\bdelete\b/i,
  /\bremove\b/i,
  /\bdeactivate\b/i,
  /\bdisable\s+account\b/i,
  /\bpurge\b/i,
  /\bwipe\b/i,
  /\brefund\b/i,
  /\bpay\b/i,
  /\bcheckout\b/i,
  /\btransfer\b/i,
  /\bwithdraw\b/i,
  /\bcancel\s+(subscription|order|account|booking)\b/i,
  /\bunsubscribe\b/i,
  /\bclose\s+account\b/i,
  /\breset\s+(all|everything)\b/i,
];

/** Text that suggests a control submits to the server rather than only changing local state. */
const REMOTE_WRITE_PATTERNS: readonly RegExp[] = [
  /\bsubmit\b/i,
  /\bsave\b/i,
  /\bconfirm\b/i,
  /\bapply\b/i,
  /\bcreate\b/i,
  /\bupdate\b/i,
  /\bpublish\b/i,
  /\bsend\b/i,
  /\bplace\s+order\b/i,
  /\bsign\s?up\b/i,
];

export interface ClassifierOptions {
  /** Extra patterns from `safety.destructivePatterns`. `(?i)` prefix supported. */
  extraDestructivePatterns?: readonly string[];
}

function compileExtra(patterns: readonly string[] | undefined): RegExp[] {
  if (!patterns) return [];
  const out: RegExp[] = [];
  for (const p of patterns) {
    const ci = p.startsWith("(?i)");
    try {
      out.push(new RegExp(ci ? p.slice(4) : p, ci ? "i" : ""));
    } catch {
      // A malformed operator pattern must not silently disable classification, but neither
      // should it stop a run: skip it and let config validation report the real problem.
    }
  }
  return out;
}

/** Every string on the action that a human would read as the control's label. */
function actionText(action: ActionSpec): string {
  const parts: string[] = [];
  if (action.selector?.name) parts.push(action.selector.name);
  if (action.selector?.value) parts.push(action.selector.value);
  if (action.description) parts.push(action.description);
  if (action.url) parts.push(action.url);
  return parts.join(" ");
}

export function classifyAction(action: ActionSpec, opts: ClassifierOptions = {}): SideEffectClass {
  const base = ACTION_BASE_SIDE_EFFECT[action.type];
  const text = actionText(action);
  const destructivePatterns = [
    ...DEFAULT_DESTRUCTIVE_PATTERNS,
    ...compileExtra(opts.extraDestructivePatterns),
  ];

  // Destructive beats everything, on any action type that can activate a control.
  const canActivate =
    action.type === "click" ||
    action.type === "dblclick" ||
    action.type === "press" ||
    action.type === "check" ||
    action.type === "goto";
  if (canActivate && destructivePatterns.some((re) => re.test(text))) {
    return "destructive";
  }

  // A click on something that reads like a submit control is a remote write.
  if (
    (action.type === "click" || action.type === "dblclick") &&
    REMOTE_WRITE_PATTERNS.some((re) => re.test(text))
  ) {
    return "remote-write";
  }

  // A submit-typed control is a remote write regardless of its label.
  if (action.type === "click" && action.selector?.role === "button" && /submit/i.test(text)) {
    return "remote-write";
  }

  return base;
}

export interface ClassificationResult {
  perAction: Map<string, SideEffectClass>;
  maxClass: SideEffectClass;
  destructiveActionIds: string[];
  remoteWriteActionIds: string[];
}

export function classifyExperiment(
  experiment: ExperimentSpec,
  opts: ClassifierOptions = {}
): ClassificationResult {
  const perAction = new Map<string, SideEffectClass>();
  const destructiveActionIds: string[] = [];
  const remoteWriteActionIds: string[] = [];
  let maxIdx = 0;

  for (const action of experiment.actions) {
    const cls = classifyAction(action, opts);
    perAction.set(action.actionId, cls);
    if (cls === "destructive") destructiveActionIds.push(action.actionId);
    if (cls === "remote-write") remoteWriteActionIds.push(action.actionId);
    maxIdx = Math.max(maxIdx, SIDE_EFFECT_SEVERITY.indexOf(cls));
  }

  return {
    perAction,
    maxClass: SIDE_EFFECT_SEVERITY[maxIdx] as SideEffectClass,
    destructiveActionIds,
    remoteWriteActionIds,
  };
}

export interface SafetyGateInput {
  experiment: ExperimentSpec;
  classification: ClassificationResult;
  targetClassification: TargetClassification;
  blockDestructiveActions: boolean;
  /** Action ids a human acknowledged in the gate-1 approval, with justification. */
  acknowledgedDestructiveActionIds: readonly string[];
}

/**
 * Static safety check, run at enqueue time before any browser launch. Seven production-impact
 * guards live across the system; these are the ones that depend on the actions themselves.
 */
export function assertSafeToEnqueue(input: SafetyGateInput): void {
  const { experiment, classification, targetClassification } = input;

  // Fixture targets are local, disposable, and have no external state.
  if (targetClassification === "fixture") return;

  // Destructive actions need a per-sequence acknowledgement, and are blocked outright on
  // staging unless the operator has explicitly turned the block off.
  for (const actionId of classification.destructiveActionIds) {
    if (targetClassification === "staging" && input.blockDestructiveActions) {
      fail("EXEC_DESTRUCTIVE_BLOCKED", "Destructive action is blocked on a staging target", {
        context: { experimentId: experiment.experimentId, actionId, targetClassification },
      });
    }
    if (!input.acknowledgedDestructiveActionIds.includes(actionId)) {
      fail(
        "EXEC_DESTRUCTIVE_BLOCKED",
        "Destructive action has no acknowledged safety approval for this sequence",
        { context: { experimentId: experiment.experimentId, actionId } }
      );
    }
  }

  // A sequence that writes to the server needs a declared reset strategy, or run N differs from
  // run 1 for reasons unrelated to the hypothesis.
  const writes =
    classification.remoteWriteActionIds.length > 0 ||
    classification.destructiveActionIds.length > 0;
  const strategy = experiment.safety.resetStrategy;
  if (writes && (strategy === "none" || strategy === "fresh-context")) {
    fail(
      "EXEC_DESTRUCTIVE_BLOCKED",
      "Sequence contains remote writes but the target declares no server-side reset strategy",
      {
        context: {
          experimentId: experiment.experimentId,
          resetStrategy: strategy,
          offendingActions: [
            ...classification.remoteWriteActionIds,
            ...classification.destructiveActionIds,
          ].join(","),
        },
      }
    );
  }

  if (strategy === "idempotent-only" && writes) {
    fail("EXEC_DESTRUCTIVE_BLOCKED", "Reset strategy idempotent-only forbids any remote write", {
      context: { experimentId: experiment.experimentId },
    });
  }
}

/**
 * Origin allowlist check. Applied at enqueue for static URLs and again at navigation time for
 * anything the page triggers.
 */
export function isOriginAllowed(url: string, allowedOrigins: readonly string[]): boolean {
  let origin: string;
  try {
    origin = new URL(url).origin;
  } catch {
    return false;
  }
  const norm = (o: string): string => o.replace(/\/+$/, "").toLowerCase();
  return allowedOrigins.some((a) => norm(a) === norm(origin));
}

export const DESTRUCTIVE_PATTERNS = DEFAULT_DESTRUCTIVE_PATTERNS;
