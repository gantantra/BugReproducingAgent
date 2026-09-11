import { parse as parseYaml } from "yaml";
import {
  canonicalJson,
  fail,
  schemaRegistry,
  sha256Prefixed,
  systemClock,
} from "@investigator/core";
import type { Clock, Gate } from "@investigator/core";
import type { ApprovalRecordRow } from "@investigator/storage";

/**
 * @investigator/approvals — the three human gates (ADR-0013, frozen decision 4).
 *
 * Playwright produces evidence. Deterministic software normalizes and measures evidence. DeepSeek interprets and prioritizes evidence. Humans authorize consequential transitions.
 *
 * This package is the last clause of the governing principle made executable. Its job is not to
 * make approval convenient; it is to make approval MEAN something:
 *
 *  - An approval is bound by SHA-256 to the exact proposal bytes a human read. A file that
 *    approves "the plan" approves exactly one revision of it and nothing else.
 *  - There is no auto-approval. No flag, no config key, no environment variable. A test asserts
 *    that no code path outside the approve handler constructs an ApprovalRecord.
 *  - A human may correct a judgement (which failure we are chasing) but may never overwrite a
 *    measurement (what was observed). That line is enforced by the edit surface, not by etiquette.
 *
 * The destructive-action classifier is INJECTED rather than imported, so this package does not
 * depend on the executor. The CLI wires the real classifier in.
 */

export const GATES = ["experiment_selection", "target_failure", "final_reproduction"] as const;

/** Gate n cannot be proposed until gate n-1 is APPROVED. */
const GATE_ORDER: Record<Gate, number> = {
  experiment_selection: 1,
  target_failure: 2,
  final_reproduction: 3,
};

export const GATE_NUMBER = GATE_ORDER;

export type GateState =
  "NOT_REACHED" | "AWAITING_APPROVAL" | "APPROVED" | "REJECTED" | "SUPERSEDED";

export interface GateStatus {
  gate: Gate;
  state: GateState;
  /** The checksum this state refers to, if any. */
  proposalChecksum: string | null;
  approvalId: string | null;
  effectiveProposalChecksum: string | null;
  decidedAt: string | null;
  /**
   * Earlier decisions for this gate that a newly rendered proposal has superseded. The records
   * themselves are never mutated, so "superseded" exists only as this derived view.
   */
  supersededApprovalIds: string[];
}

export interface ProposalBundle {
  schemaVersion: "1.0.0";
  gate: Gate;
  investigationId: string;
  renderedAt: string;
  flowId?: string;
  summary?: string;
  items: Array<Record<string, unknown> & { itemId: string }>;
}

// ---------------------------------------------------------------------------------------------
// Canonicalisation and checksums
// ---------------------------------------------------------------------------------------------

/**
 * The exact bytes a checksum is taken over.
 *
 * Frozen form: sorted keys, two-space indentation, LF, UTF-8 without BOM, one trailing newline.
 * `canonicalJson` already produces exactly this, and a round-trip test pins it: if this form ever
 * drifts, every previously recorded approval would silently stop matching its proposal.
 */
export function canonicalProposalBytes(proposal: unknown): string {
  return canonicalJson(proposal);
}

export function proposalChecksumOf(proposal: unknown): string {
  return sha256Prefixed(canonicalProposalBytes(proposal));
}

export function checksumOfBytes(bytes: string): string {
  return sha256Prefixed(bytes);
}

// ---------------------------------------------------------------------------------------------
// Edit surface
// ---------------------------------------------------------------------------------------------

/**
 * What a human may change at each gate, as JSON-pointer patterns against one ITEM.
 *
 * Gate 2 is the one that matters most: `/signature/predicate` and `/clusters/*` are editable
 * because deciding which failure to chase is a judgement, while a run's outcome and a fingerprint
 * are forbidden because rewriting an observation is falsification, not correction.
 *
 * Widening a surface requires editing this table, which is why it lives in one visible place.
 */
export const EDIT_SURFACE: Record<Gate, { allow: RegExp[]; description: string[] }> = {
  experiment_selection: {
    allow: [
      /^\/actions(\/\d+(\/[A-Za-z0-9_]+)*)?$/,
      /^\/assertions(\/\d+(\/[A-Za-z0-9_]+)*)?$/,
      /^\/repetitions$/,
      /^\/requiredEvidence(\/\d+)?$/,
      /^\/safety(\/[A-Za-z0-9_]+)*$/,
      /^\/emulationProfile$/,
      /^\/actions\/\d+\/timeoutMs$/,
    ],
    description: [
      "/actions/* (add, remove, reorder, retype within the closed vocabulary)",
      "/assertions/*",
      "/repetitions",
      "/requiredEvidence",
      "/safety/*",
      "/emulationProfile",
    ],
  },
  target_failure: {
    allow: [
      /^\/signature\/predicate$/,
      /^\/signature\/label$/,
      /^\/clusters\/\d+\/runIds(\/\d+)?$/,
      /^\/clusters\/\d+\/label$/,
    ],
    description: [
      "/signature/predicate (within the deterministic predicate grammar)",
      "/signature/label",
      "/clusters/*/runIds (reassign runs between clusters)",
      "/clusters/*/label",
    ],
  },
  final_reproduction: {
    allow: [
      /^\/sequence\/actions(\/\d+(\/[A-Za-z0-9_]+)*)?$/,
      /^\/assertions(\/\d+(\/[A-Za-z0-9_]+)*)?$/,
      /^\/repetitions$/,
      /^\/control(\/[A-Za-z0-9_]+)*$/,
    ],
    description: [
      "/sequence/actions/* (removal and reorder only)",
      "/assertions/*",
      "/repetitions",
      "/control/*",
    ],
  },
};

export function isPathEditable(gate: Gate, path: string): boolean {
  return EDIT_SURFACE[gate].allow.some((re) => re.test(path));
}

// ---------------------------------------------------------------------------------------------
// JSON pointer
// ---------------------------------------------------------------------------------------------

function pointerSegments(path: string): string[] {
  if (path === "" || path === "/") return [];
  if (!path.startsWith("/")) {
    fail(
      "GATE_EDIT_OUT_OF_SURFACE",
      `Edit path must be a JSON pointer starting with "/": ${path}`,
      {
        context: { path },
      }
    );
  }
  return path
    .slice(1)
    .split("/")
    .map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"));
}

function readPointer(root: unknown, path: string): { found: boolean; value: unknown } {
  let node: unknown = root;
  for (const seg of pointerSegments(path)) {
    if (Array.isArray(node)) {
      const i = Number.parseInt(seg, 10);
      if (!Number.isInteger(i) || i < 0 || i >= node.length)
        return { found: false, value: undefined };
      node = node[i];
    } else if (node && typeof node === "object") {
      if (!(seg in (node as Record<string, unknown>))) return { found: false, value: undefined };
      node = (node as Record<string, unknown>)[seg];
    } else {
      return { found: false, value: undefined };
    }
  }
  return { found: true, value: node };
}

function writePointer(root: unknown, path: string, value: unknown): void {
  const segs = pointerSegments(path);
  const last = segs.pop();
  if (last === undefined) {
    fail("GATE_EDIT_OUT_OF_SURFACE", "An edit cannot replace the whole item", {
      context: { path },
    });
  }
  let node: unknown = root;
  for (const seg of segs) {
    if (Array.isArray(node)) node = node[Number.parseInt(seg, 10)];
    else if (node && typeof node === "object") node = (node as Record<string, unknown>)[seg];
    else {
      fail("GATE_EDIT_OUT_OF_SURFACE", `Edit path does not exist: ${path}`, { context: { path } });
    }
  }
  if (Array.isArray(node)) {
    const i = Number.parseInt(last, 10);
    if (value === null) node.splice(i, 1);
    else node[i] = value;
    return;
  }
  if (node && typeof node === "object") {
    (node as Record<string, unknown>)[last] = value;
    return;
  }
  fail("GATE_EDIT_OUT_OF_SURFACE", `Edit path does not exist: ${path}`, { context: { path } });
}

export interface ApprovalEdit {
  itemId: string;
  path: string;
  from: unknown;
  to: unknown;
  rationale: string;
}

/**
 * Apply the human's edits to the proposal, producing the EFFECTIVE proposal execution consumes.
 *
 * `from` must match the current value. An edit written against a different revision of the
 * proposal therefore cannot apply silently — which is the failure mode that would let a human
 * believe they had changed one thing while changing another.
 */
export function applyEdits(bundle: ProposalBundle, edits: readonly ApprovalEdit[]): ProposalBundle {
  const next = JSON.parse(JSON.stringify(bundle)) as ProposalBundle;

  for (const edit of edits) {
    if (!isPathEditable(bundle.gate, edit.path)) {
      fail(
        "GATE_EDIT_OUT_OF_SURFACE",
        `Path ${edit.path} is not editable at gate ${bundle.gate}. Editable: ${EDIT_SURFACE[bundle.gate].description.join(", ")}`,
        { context: { gate: bundle.gate, path: edit.path, itemId: edit.itemId } }
      );
    }
    const item = next.items.find((i) => i.itemId === edit.itemId);
    if (!item) {
      fail("GATE_REFERENCE_UNKNOWN", `Edit references unknown item ${edit.itemId}`, {
        context: { itemId: edit.itemId },
      });
    }
    const current = readPointer(item, edit.path);
    if (!current.found) {
      fail("GATE_EDIT_OUT_OF_SURFACE", `Edit path ${edit.path} does not exist on ${edit.itemId}`, {
        context: { itemId: edit.itemId, path: edit.path },
      });
    }
    if (canonicalJson(current.value ?? null) !== canonicalJson(edit.from ?? null)) {
      fail(
        "GATE_EDIT_OUT_OF_SURFACE",
        `Edit at ${edit.path} on ${edit.itemId} expected a different current value. ` +
          `The proposal changed since this edit was written; re-read it and rewrite the edit.`,
        {
          context: {
            itemId: edit.itemId,
            path: edit.path,
            expected: canonicalJson(edit.from ?? null).slice(0, 120),
            actual: canonicalJson(current.value ?? null).slice(0, 120),
          },
        }
      );
    }
    writePointer(item, edit.path, edit.to);
  }

  return next;
}

// ---------------------------------------------------------------------------------------------
// Gate state
// ---------------------------------------------------------------------------------------------

/**
 * Derive each gate's state from the approval records alone.
 *
 * Records are never mutated, so "superseded" is a derived view: an older decision for a gate
 * whose checksum is no longer the one being proposed. That is why the state machine has no
 * SUPERSEDED row in the database.
 */
export function deriveGateStates(
  approvals: readonly ApprovalRecordRow[],
  awaiting: Partial<Record<Gate, string>> = {}
): Record<Gate, GateStatus> {
  const out = {} as Record<Gate, GateStatus>;

  for (const gate of GATES) {
    const forGate = approvals
      .filter((a) => a.gate === gate)
      .sort((a, b) => a.recordedAt.localeCompare(b.recordedAt));
    const pendingChecksum = awaiting[gate] ?? null;

    // A decision on the checksum currently awaiting approval wins; otherwise the latest decision.
    const decisive =
      (pendingChecksum
        ? forGate.filter((a) => a.proposalChecksum === pendingChecksum)
        : forGate
      ).slice(-1)[0] ?? null;

    // Any decision bound to a checksum that is no longer the one on offer is superseded.
    const supersededApprovalIds = pendingChecksum
      ? forGate.filter((a) => a.proposalChecksum !== pendingChecksum).map((a) => a.approvalId)
      : [];

    if (!decisive) {
      // A freshly rendered proposal puts the gate back to AWAITING_APPROVAL bound to the NEW
      // checksum, even when earlier decisions exist: those decided a different document.
      out[gate] = {
        gate,
        state: pendingChecksum ? "AWAITING_APPROVAL" : "NOT_REACHED",
        proposalChecksum: pendingChecksum,
        approvalId: null,
        effectiveProposalChecksum: null,
        decidedAt: null,
        supersededApprovalIds,
      };
      continue;
    }

    const state: GateState = decisive.decision === "approve" ? "APPROVED" : "REJECTED";

    out[gate] = {
      gate,
      state,
      proposalChecksum: decisive.proposalChecksum,
      approvalId: decisive.approvalId,
      effectiveProposalChecksum: decisive.effectiveProposalChecksum,
      decidedAt: decisive.decidedAt,
      supersededApprovalIds,
    };
  }

  return out;
}

/** The approval that authorises execution for a gate, or null. Expiry is applied by the caller. */
export function approvedRecordFor(
  approvals: readonly ApprovalRecordRow[],
  gate: Gate
): ApprovalRecordRow | null {
  return (
    approvals
      .filter((a) => a.gate === gate && a.decision === "approve")
      .sort((a, b) => a.recordedAt.localeCompare(b.recordedAt))
      .slice(-1)[0] ?? null
  );
}

/**
 * Gate ordering. Gate 2 cannot be proposed before gate 1 is approved, and gate 3 before gate 2.
 *
 * Enforced here rather than at each call site so that adding a command cannot accidentally skip
 * a gate.
 */
export function assertGateReachable(gate: Gate, approvals: readonly ApprovalRecordRow[]): void {
  const n = GATE_ORDER[gate];
  for (const earlier of GATES) {
    if (GATE_ORDER[earlier] >= n) continue;
    if (!approvedRecordFor(approvals, earlier)) {
      fail("GATE_REQUIRED", `Gate ${gate} cannot be reached before gate ${earlier} is approved.`, {
        context: { gate, blockedBy: earlier },
      });
    }
  }
}

export function isExpired(
  record: ApprovalRecordRow,
  expiryHours: number,
  now: Date = new Date()
): boolean {
  const decided = Date.parse(record.decidedAt);
  if (!Number.isFinite(decided)) return true;
  return now.getTime() - decided > expiryHours * 3600_000;
}

// ---------------------------------------------------------------------------------------------
// Approval file
// ---------------------------------------------------------------------------------------------

export interface ApprovalFile {
  schemaVersion: string;
  gate: Gate;
  investigationId: string;
  proposalChecksum: string;
  decision: "approve" | "reject" | "request_changes";
  approver: { name: string; method: "local-file"; note?: string };
  decidedAt: string;
  approvedItemIds?: string[];
  rejectedItemIds?: string[];
  edits?: ApprovalEdit[];
  safetyAcknowledgements?: Array<{
    itemId: string;
    actionId: string;
    classification: string;
    acknowledged: boolean;
    justification: string;
  }>;
  requestedChanges?: string[];
  notes?: string;
}

export interface ValidateArgs {
  /** Raw YAML text of the approval file the human wrote. */
  approvalText: string;
  /** `--checksum` as typed on the command line. */
  flagChecksum: string;
  gate: Gate;
  investigationId: string;
  /** The canonical proposal bytes currently on disk. */
  proposalBytes: string;
  /** The hash recorded in the ArtifactStore when the proposal was rendered. */
  storedProposalHash: string;
  approvals: readonly ApprovalRecordRow[];
  expiryHours: number;
  /** Returns the destructive action ids for one proposal item. Injected; see the module note. */
  classifyDestructive: (item: Record<string, unknown>) => string[];
  clock?: Clock;
  /** Tolerance for a `decidedAt` slightly ahead of local time. */
  futureSkewMs?: number;
}

export interface ValidatedApproval {
  file: ApprovalFile;
  bundle: ProposalBundle;
  effective: ProposalBundle;
  effectiveChecksum: string;
  approvedItemIds: string[];
}

/**
 * The nine checks, in order, before ANY state change.
 *
 * Order is part of the contract: a malformed file must not be able to provoke a checksum
 * comparison, and a stale proposal must be caught before its contents are trusted enough to
 * resolve item ids against.
 */
export function validateApproval(args: ValidateArgs): ValidatedApproval {
  const clock = args.clock ?? systemClock;
  const registry = schemaRegistry();

  // 1. Parses and validates against the approval schema, with additionalProperties: false.
  let parsed: unknown;
  try {
    parsed = parseYaml(args.approvalText);
  } catch (e) {
    return fail("INPUT_INVALID", "Approval file is not valid YAML", { cause: e });
  }
  registry.assert("approval-record.v1.json", parsed, "approval file");
  const file = parsed as ApprovalFile;

  if (file.gate !== args.gate) {
    fail("INPUT_INVALID", `Approval file is for gate ${file.gate}, not ${args.gate}`, {
      context: { fileGate: file.gate, commandGate: args.gate },
    });
  }
  if (file.investigationId !== args.investigationId) {
    fail(
      "GATE_REFERENCE_UNKNOWN",
      `Approval file names investigation ${file.investigationId}, not ${args.investigationId}`,
      { context: { fileInvestigation: file.investigationId, actual: args.investigationId } }
    );
  }

  // 2. --checksum equals the SHA-256 of the proposal bytes on disk.
  const onDisk = checksumOfBytes(args.proposalBytes);
  if (args.flagChecksum !== onDisk) {
    fail(
      "GATE_CHECKSUM_MISMATCH",
      "--checksum does not match the proposal on disk. Re-read the proposal and use its printed checksum.",
      { context: { provided: args.flagChecksum, onDisk } }
    );
  }

  // 3. The file's proposalChecksum equals --checksum. Neither a stale file nor a stale shell
  //    history can approve the wrong revision.
  if (file.proposalChecksum !== args.flagChecksum) {
    fail(
      "GATE_CHECKSUM_MISMATCH",
      "The approval file's proposalChecksum disagrees with --checksum. They must agree.",
      { context: { inFile: file.proposalChecksum, onFlag: args.flagChecksum } }
    );
  }

  // 4. The proposal artifact still hashes to what was recorded when it was rendered.
  if (onDisk !== args.storedProposalHash) {
    fail(
      "GATE_PROPOSAL_STALE",
      "The proposal file has been modified since it was rendered. Re-render it and re-read it before approving.",
      { context: { onDisk, whenRendered: args.storedProposalHash } }
    );
  }

  const bundle = JSON.parse(args.proposalBytes) as ProposalBundle;
  registry.assert("gate-proposal.v1.json", bundle, "proposal bundle");

  // 5. Gate ordering, and this gate is not already decided for this checksum.
  assertGateReachable(args.gate, args.approvals);
  const alreadyDecided = args.approvals.find(
    (a) => a.gate === args.gate && a.proposalChecksum === args.flagChecksum
  );
  if (alreadyDecided) {
    fail(
      "GATE_ALREADY_APPROVED",
      `Gate ${args.gate} already has a ${alreadyDecided.decision} decision for this proposal (${alreadyDecided.approvalId}).`,
      { context: { approvalId: alreadyDecided.approvalId, decision: alreadyDecided.decision } }
    );
  }

  // 6. Every referenced id exists in THIS bundle.
  const known = new Set(bundle.items.map((i) => i.itemId));
  const referenced = [
    ...(file.approvedItemIds ?? []),
    ...(file.rejectedItemIds ?? []),
    ...(file.edits ?? []).map((e) => e.itemId),
    ...(file.safetyAcknowledgements ?? []).map((s) => s.itemId),
  ];
  for (const id of referenced) {
    if (!known.has(id)) {
      fail(
        "GATE_REFERENCE_UNKNOWN",
        `Item ${id} is not in this proposal. Referenced ids must belong to this investigation and this bundle.`,
        { context: { itemId: id, known: [...known].join(",") } }
      );
    }
  }

  // 9a. decidedAt must not be in the future beyond a small skew allowance. Checked before edits
  //     so a clock problem is reported as a clock problem.
  const skew = args.futureSkewMs ?? 5 * 60_000;
  const decidedAtMs = Date.parse(file.decidedAt);
  if (!Number.isFinite(decidedAtMs)) {
    fail("INPUT_INVALID", "decidedAt is not a valid timestamp", {
      context: { decidedAt: file.decidedAt },
    });
  }
  if (decidedAtMs - clock.nowMs() > skew) {
    fail("INPUT_INVALID", "decidedAt is in the future", {
      context: { decidedAt: file.decidedAt, now: clock.nowIso() },
    });
  }

  // 7. Edits are inside the surface, `from` matches, and the edited bundle still validates.
  const approvedItemIds =
    file.decision === "approve" ? (file.approvedItemIds ?? bundle.items.map((i) => i.itemId)) : [];
  const effective = applyEdits(bundle, file.edits ?? []);
  registry.assert("gate-proposal.v1.json", effective, "edited proposal bundle");

  // 8. Every destructive action in every APPROVED item carries an acknowledgement.
  if (file.decision === "approve") {
    const acks = new Map(
      (file.safetyAcknowledgements ?? [])
        .filter((a) => a.acknowledged === true && a.justification.trim().length > 0)
        .map((a) => [`${a.itemId}:${a.actionId}`, a])
    );
    for (const item of effective.items) {
      if (!approvedItemIds.includes(item.itemId)) continue;
      for (const actionId of args.classifyDestructive(item)) {
        if (!acks.has(`${item.itemId}:${actionId}`)) {
          fail(
            "GATE_EDIT_OUT_OF_SURFACE",
            `Action ${actionId} in ${item.itemId} is classified destructive and has no acknowledgement with a justification. ` +
              `Approval is blocked, and execution would refuse with EXEC_DESTRUCTIVE_BLOCKED.`,
            { context: { itemId: item.itemId, actionId } }
          );
        }
      }
    }
  }

  return {
    file,
    bundle,
    effective,
    effectiveChecksum: proposalChecksumOf(effective),
    approvedItemIds,
  };
}

// ---------------------------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------------------------

function actionLine(a: unknown): string {
  const act = a as Record<string, unknown>;
  const parts = [String(act["actionId"] ?? "?"), String(act["type"] ?? "?")];
  if (act["url"]) parts.push(String(act["url"]));
  const sel = act["selector"] as Record<string, unknown> | undefined;
  if (sel) parts.push(`${String(sel["strategy"])}=${String(sel["value"] ?? sel["name"] ?? "")}`);
  if (act["timeoutMs"]) parts.push(`${String(act["timeoutMs"])}ms`);
  return parts.join("  ");
}

/**
 * The human-readable rendering.
 *
 * Deliberately leads with hypothesis, varied factor and falsifier for each item. Risk R10 in the
 * M2 spec is rubber-stamping: a reviewer shown only a list of actions will approve it, so the
 * rendering puts the reasoning — and specifically what would DISPROVE it — above the mechanics.
 *
 * Generated from the JSON and never part of the checksum, so regenerating it is always safe.
 */
export function renderProposalMarkdown(bundle: ProposalBundle, checksum: string): string {
  const lines: string[] = [
    `# Gate ${GATE_ORDER[bundle.gate]} proposal — ${bundle.gate}`,
    "",
    `Investigation: ${bundle.investigationId}`,
    `Rendered: ${bundle.renderedAt}`,
    `Proposal checksum: \`${checksum}\``,
    "",
    "> Playwright produces evidence. Deterministic software normalizes and measures evidence. DeepSeek interprets and prioritizes evidence. Humans authorize consequential transitions.",
    "",
    "This document is the thing you are deciding on. Approving it binds your decision to the",
    "checksum above: if the proposal changes in any way, this approval no longer applies.",
    "",
  ];

  if (bundle.summary) lines.push(bundle.summary, "");

  lines.push(`## Items (${bundle.items.length})`, "");

  for (const item of bundle.items) {
    lines.push(`### ${item.itemId}${item["rank"] ? `  (rank ${String(item["rank"])})` : ""}`, "");
    if (item["hypothesis"]) lines.push(`**Hypothesis.** ${String(item["hypothesis"])}`, "");
    if (item["variedFactor"]) lines.push(`**Varied factor.** ${String(item["variedFactor"])}`, "");
    if (item["falsifier"]) {
      lines.push(
        `**What would disprove it.** ${String(item["falsifier"])}`,
        "",
        "If that observation would not change your mind, this experiment is not worth running.",
        ""
      );
    }
    if (item["expectedDiscriminatingSignal"]) {
      lines.push(
        `**Expected discriminating signal.** ${String(item["expectedDiscriminatingSignal"])}`,
        ""
      );
    }
    if (item["rankRationale"])
      lines.push(`**Why this rank.** ${String(item["rankRationale"])}`, "");

    const actions = item["actions"] as unknown[] | undefined;
    if (actions?.length) {
      lines.push("**Actions.**", "", "```");
      for (const a of actions) lines.push(actionLine(a));
      lines.push("```", "");
    }

    const signature = item["signature"] as Record<string, unknown> | undefined;
    if (signature) {
      lines.push("**Target failure signature.**", "", "```");
      lines.push(`label:      ${String(signature["label"] ?? "")}`);
      lines.push(`predicate:  ${String(signature["predicate"] ?? "")}`);
      lines.push(`fingerprint:${String(signature["fingerprint"] ?? "")}   (not editable)`);
      lines.push("```", "");
    }

    const clusters = item["clusters"] as Array<Record<string, unknown>> | undefined;
    if (clusters?.length) {
      lines.push("**Run clusters.**", "");
      for (const c of clusters) {
        const runIds = (c["runIds"] as string[] | undefined) ?? [];
        lines.push(
          `- \`${String(c["clusterId"])}\` ${String(c["label"] ?? "")} — ${runIds.length} run(s): ${runIds.join(", ")}`
        );
      }
      lines.push("");
    }

    const safety = item["safety"] as Record<string, unknown> | undefined;
    if (safety) {
      const destructive = (safety["destructiveActionIds"] as string[] | undefined) ?? [];
      lines.push(
        `**Safety.** side effects: ${String(safety["maxSideEffectClass"] ?? "?")}, reset: ${String(safety["resetStrategy"] ?? "?")}`,
        ""
      );
      if (destructive.length) {
        lines.push(
          `> **${destructive.length} destructive action(s):** ${destructive.join(", ")}.`,
          "> Each needs a `safetyAcknowledgements` entry with a justification, or approval is refused.",
          ""
        );
      }
    }
    if (item["repetitions"]) lines.push(`**Repetitions.** ${String(item["repetitions"])}`, "");
    lines.push("");
  }

  lines.push(
    "## Editable at this gate",
    "",
    ...EDIT_SURFACE[bundle.gate].description.map((d) => `- \`${d}\``),
    "",
    "Anything not listed is refused with `GATE_EDIT_OUT_OF_SURFACE`. An edit must state the",
    "current value in `from`, so an edit written against an older revision cannot apply silently.",
    ""
  );

  return lines.join("\n");
}

/**
 * A schema-valid, pre-filled approval file.
 *
 * Scaffolding approves nothing. It exists because approval friction is itself a safety risk: a
 * human asked to hand-author YAML will look for a shortcut, and there is deliberately no shortcut
 * to find.
 */
export function scaffoldApprovalYaml(args: {
  gate: Gate;
  investigationId: string;
  proposalChecksum: string;
  bundle: ProposalBundle;
  approverName: string;
  decidedAt: string;
  classifyDestructive: (item: Record<string, unknown>) => string[];
}): string {
  const itemIds = args.bundle.items.map((i) => i.itemId);
  const lines = [
    "# Approval file. Edit it, then run the printed `investigate approve` command.",
    "#",
    "# This approves exactly the proposal whose checksum appears below, and nothing else.",
    "# Re-rendering the proposal changes the checksum and invalidates this file, by design.",
    "",
    'schemaVersion: "1.0.0"',
    `gate: ${args.gate}`,
    `investigationId: ${args.investigationId}`,
    `proposalChecksum: "${args.proposalChecksum}"`,
    "",
    "# approve | reject | request_changes",
    "decision: approve",
    "",
    "approver:",
    `  name: "${args.approverName}"`,
    "  method: local-file",
    "",
    `decidedAt: "${args.decidedAt}"`,
    "",
    "# List ONLY the items you are approving. Removing an id rejects that item by omission.",
    "approvedItemIds:",
    ...itemIds.map((id) => `  - ${id}`),
    "",
    "# Optional. Each edit must lie inside this gate's editable surface, and `from` must match",
    "# the proposal's current value.",
    `# Editable here: ${EDIT_SURFACE[args.gate].description.join(", ")}`,
    "edits: []",
    "",
  ];

  // Destructive actions are emitted as a COMMENTED template, never as pre-filled entries.
  //
  // The schema pins `acknowledged` to the constant `true`, so an acknowledgement cannot exist in
  // a "not yet acknowledged" state -- which is the right design: an acknowledgement is an
  // assertion that a human accepted a side effect, and there is no such thing as a provisional
  // one. The scaffold therefore stays schema-valid with an empty list, and approval is refused
  // by check 8 until the human writes the entry out themselves.
  const destructiveTemplate: string[] = [];
  for (const item of args.bundle.items) {
    for (const actionId of args.classifyDestructive(item)) {
      destructiveTemplate.push(
        `#   - itemId: ${item.itemId}`,
        `#     actionId: ${actionId}`,
        "#     classification: destructive",
        "#     acknowledged: true",
        '#     justification: "why this side effect is acceptable on this target"'
      );
    }
  }
  if (destructiveTemplate.length) {
    lines.push(
      "# ---------------------------------------------------------------------------------",
      "# THIS PROPOSAL CONTAINS DESTRUCTIVE ACTIONS.",
      "#",
      "# Approval is refused until every one of them is acknowledged with a justification.",
      "# Uncomment and complete the entries below only if you accept the side effects.",
      "# ---------------------------------------------------------------------------------",
      "safetyAcknowledgements: []",
      ...destructiveTemplate,
      ""
    );
  } else {
    lines.push("# No destructive actions in this proposal.", "safetyAcknowledgements: []", "");
  }

  lines.push('notes: ""', "");
  return lines.join("\n");
}

export const APPROVALS_COMPONENT = "approvals";
export const APPROVALS_VERSION = "0.1.0";
export const PACKAGE_NAME = "@investigator/approvals";
