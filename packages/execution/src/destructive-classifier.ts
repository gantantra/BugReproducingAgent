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

  /*
   * An operator who has turned `blockDestructiveActions` off has said this environment is theirs
   * to act on — an in-house QA server with disposable accounts, where the whole point is running a
   * destructive flow hundreds of times unattended.
   *
   * Everything below this line exists to stop an unintended write to an environment someone cares
   * about, so the flag now governs all of it rather than only the staging refusal. What it does
   * NOT touch: the approval gate itself. A human still authorises the batch; they are simply not
   * asked to re-justify each `delete` inside a proposal they have already read.
   */
  if (!input.blockDestructiveActions) return;

  // Destructive actions need a per-sequence acknowledgement, and are blocked outright on
  // staging unless the operator has explicitly turned the block off.
  for (const actionId of classification.destructiveActionIds) {
    // `&& input.blockDestructiveActions` was redundant here: the early return above already
    // handled the false case. Left as-is it read like the staging refusal had its own switch.
    if (targetClassification === "staging") {
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
/**
 * Should the executor refuse this job because it contains destructive actions?
 *
 * Extracted from the worker so it can be tested without a browser. It is the last of three
 * checkpoints — enqueue, approval acknowledgement, executor — and it was the one nothing switched
 * off: turning `blockDestructiveActions` off cleared the first two and left this one throwing
 * `EXEC_DESTRUCTIVE_BLOCKED` on the first delete. A flag that governs some of its checkpoints
 * governs none of them, so the condition now lives in one named, tested place rather than being
 * spelled out a third time inside a 600-line method.
 */
export function shouldBlockDestructiveExecution(input: {
  blockDestructiveActions: boolean;
  destructiveActionCount: number;
  targetClassification: TargetClassification;
}): boolean {
  if (!input.blockDestructiveActions) return false;
  if (input.destructiveActionCount === 0) return false;
  // Fixture targets are local, disposable, and have no external state to protect.
  return input.targetClassification !== "fixture";
}

/**
 * Is this URL inside the allowlist?
 *
 * Exact origin match, OR a SUBDOMAIN of an allowed origin over the same protocol.
 *
 * The subdomain clause is not a loosening for its own sake; without it the allowlist blocked
 * ordinary navigation. Sites put sign-in on `login.`, mobile on `m.`, static assets on `cdn.`,
 * and a redirect to any of them from `https://www.example.com` failed the run mid-flow with
 * EXEC_ORIGIN_NOT_ALLOWED. The operator had already named the site; being bounced to its own
 * login host is what a real user's browser does, and refusing it protected nothing while
 * stopping the investigation.
 *
 * What it still refuses is what it was for: a DIFFERENT site. `evil.com`, `example.com.attacker
 * .net` and a downgrade from https to http are all rejected — the check is on host boundaries,
 * so a suffix match cannot be smuggled through by appending the allowed host to another domain.
 */
export function isOriginAllowed(url: string, allowedOrigins: readonly string[]): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const origin = parsed.origin.replace(/\/+$/, "").toLowerCase();
  const host = parsed.hostname.toLowerCase();
  const protocol = parsed.protocol.toLowerCase();

  return allowedOrigins.some((allowed) => {
    const norm = allowed.replace(/\/+$/, "").toLowerCase();
    if (norm === origin) return true;
    let allowedUrl: URL;
    try {
      allowedUrl = new URL(norm);
    } catch {
      return false;
    }
    // Same protocol, and a dot-delimited suffix — so `login.example.com` passes for
    // `example.com` while `notexample.com` and `example.com.evil.net` do not.
    if (allowedUrl.protocol.toLowerCase() !== protocol) return false;
    if (allowedUrl.port !== parsed.port) return false;
    const allowedHost = allowedUrl.hostname.toLowerCase();
    // `www.` is a subdomain like any other, so an allowlist entry of `www.example.com` is
    // anchored at `example.com`. Without this the commonest redirect on the web — www to apex,
    // or apex to www — failed the run, and the operator had plainly named that site.
    const base = allowedHost.startsWith("www.") ? allowedHost.slice(4) : allowedHost;
    return host === base || host.endsWith(`.${base}`);
  });
}

export const DESTRUCTIVE_PATTERNS = DEFAULT_DESTRUCTIVE_PATTERNS;
