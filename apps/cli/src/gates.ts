import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fail, type Gate } from "@investigator/core";
import { investigationDirs } from "@investigator/storage";
import {
  GATE_NUMBER,
  approvedRecordFor,
  checksumOfBytes,
  deriveGateStates,
  isExpired,
  type GateStatus,
  type ProposalBundle,
} from "@investigator/approvals";
import { classifyExperiment } from "@investigator/execution";
import type { Runtime } from "./runtime.js";

/**
 * Gate plumbing shared by `plan`, `approve`, `run`, `status` and `show`.
 *
 * Playwright produces evidence. Deterministic software normalizes and measures evidence. DeepSeek interprets and prioritizes evidence. Humans authorize consequential transitions.
 *
 * Everything here is read-only with respect to approvals. The ONLY place an `ApprovalRecord` is
 * constructed is the `approve` command handler, and a test asserts that no other module does it.
 */

export const GATE_SLUG: Record<Gate, string> = {
  experiment_selection: "gate-1.experiment_selection",
  target_failure: "gate-2.target_failure",
  final_reproduction: "gate-3.final_reproduction",
};

export interface ProposalPaths {
  json: string;
  sha256: string;
  markdown: string;
}

export function proposalPaths(rt: Runtime, investigationId: string, gate: Gate): ProposalPaths {
  const dirs = investigationDirs(rt.workspace, investigationId);
  const base = join(dirs.manifests, GATE_SLUG[gate]);
  return {
    json: `${base}.proposal.json`,
    sha256: `${base}.proposal.json.sha256`,
    markdown: `${base}.proposal.md`,
  };
}

export function approvalScaffoldPath(rt: Runtime, investigationId: string, gate: Gate): string {
  const dirs = investigationDirs(rt.workspace, investigationId);
  return join(dirs.approvals, `${GATE_SLUG[gate]}.approval.yaml`);
}

/** The proposal currently on disk for a gate, or null when none has been rendered. */
export function readProposal(
  rt: Runtime,
  investigationId: string,
  gate: Gate
): { bytes: string; bundle: ProposalBundle; checksum: string } | null {
  const paths = proposalPaths(rt, investigationId, gate);
  if (!existsSync(paths.json)) return null;
  const bytes = readFileSync(paths.json, "utf8");
  return {
    bytes,
    bundle: JSON.parse(bytes) as ProposalBundle,
    checksum: checksumOfBytes(bytes),
  };
}

/**
 * Gate states for an investigation, combining recorded decisions with whatever proposal is
 * currently rendered on disk.
 */
export async function gateStates(
  rt: Runtime,
  investigationId: string
): Promise<Record<Gate, GateStatus>> {
  const approvals = await rt.metadata.read((t) => t.listApprovals(investigationId));
  const awaiting: Partial<Record<Gate, string>> = {};
  for (const gate of Object.keys(GATE_SLUG) as Gate[]) {
    const proposal = readProposal(rt, investigationId, gate);
    if (proposal) awaiting[gate] = proposal.checksum;
  }
  return deriveGateStates(approvals, awaiting);
}

export interface AuthorisedExecution {
  approvalId: string;
  effectiveProposalChecksum: string;
  effective: ProposalBundle;
  approvedItemIds: string[];
}

/**
 * The single door to execution.
 *
 * `run` cannot enqueue anything without passing through here, and this refuses unless a gate-1
 * approval exists, has not expired, and its effective proposal is still readable. The M1
 * `--fixture-experiment` bypass is gone: from M2 there is exactly one path from intent to browser,
 * and it goes through a human.
 */
export async function requireGateApproval(
  rt: Runtime,
  investigationId: string,
  gate: Gate
): Promise<AuthorisedExecution> {
  const approvals = await rt.metadata.read((t) => t.listApprovals(investigationId));
  const record = approvedRecordFor(approvals, gate);

  if (!record) {
    fail(
      "GATE_REQUIRED",
      `Gate ${GATE_NUMBER[gate]} (${gate}) has not been approved for ${investigationId}. ` +
        `Render a proposal with \`investigate plan\`, then approve it with \`investigate approve ${gate}\`.`,
      { context: { investigationId, gate } }
    );
  }
  if (isExpired(record, rt.config.approvals.expiryHours)) {
    fail(
      "GATE_APPROVAL_EXPIRED",
      `Approval ${record.approvalId} was decided at ${record.decidedAt} and is older than ` +
        `approvals.expiryHours (${rt.config.approvals.expiryHours}). Re-approve before running.`,
      { context: { approvalId: record.approvalId, decidedAt: record.decidedAt } }
    );
  }
  if (!record.effectiveProposalChecksum) {
    fail("GATE_REQUIRED", `Approval ${record.approvalId} carries no effective proposal`, {
      context: { approvalId: record.approvalId },
    });
  }

  const payload = JSON.parse(record.payloadJson) as {
    effectiveProposalArtifactId?: string;
    approvedItemIds?: string[];
  };
  if (!payload.effectiveProposalArtifactId) {
    fail("GATE_REQUIRED", `Approval ${record.approvalId} has no stored effective proposal`, {
      context: { approvalId: record.approvalId },
    });
  }

  const text = await rt.artifacts.getText(payload.effectiveProposalArtifactId);
  // The effective proposal is content-addressed; if its bytes no longer hash to what the
  // approval recorded, something edited what a human authorised.
  const observed = checksumOfBytes(text);
  if (observed !== record.effectiveProposalChecksum) {
    fail(
      "GATE_PROPOSAL_STALE",
      "The effective proposal no longer matches the checksum recorded with its approval.",
      {
        context: {
          approvalId: record.approvalId,
          observed,
          recorded: record.effectiveProposalChecksum,
        },
      }
    );
  }

  return {
    approvalId: record.approvalId,
    effectiveProposalChecksum: record.effectiveProposalChecksum,
    effective: JSON.parse(text) as ProposalBundle,
    approvedItemIds: payload.approvedItemIds ?? [],
  };
}

/**
 * Destructive actions in one proposal item, using the deterministic classifier.
 *
 * Passed into `@investigator/approvals` rather than imported by it, so the approvals package
 * stays independent of the executor.
 */
export function destructiveActionIds(rt: Runtime, item: Record<string, unknown>): string[] {
  // `blockDestructiveActions: false` now means what it says. It previously only skipped the
  // staging-target refusal, while the per-action acknowledgement stayed mandatory — so an operator
  // who had deliberately turned the guard off still had to write a justification for every
  // matching control. One flag, one meaning: off means the approval carries no such requirement.
  if (!rt.config.safety.blockDestructiveActions) return [];

  const actions = (item["actions"] as unknown[] | undefined) ?? [];
  if (actions.length === 0) return [];
  const classification = classifyExperiment(
    {
      experimentId: String(item["itemId"] ?? "EXP-000"),
      investigationId: "INV-000",
      actions: actions as never,
      assertions: [],
      repetitions: 1,
      requiredEvidence: [],
      safety: {
        maxSideEffectClass: "read",
        destructiveActionIds: [],
        resetStrategy: "fresh-context",
      },
      targetName: String(item["targetName"] ?? ""),
    },
    { extraDestructivePatterns: rt.config.safety.destructivePatterns }
  );
  return classification.destructiveActionIds;
}

/** Write the proposal triple: canonical JSON, its checksum, and the human rendering. */
export function writeProposalTriple(
  rt: Runtime,
  investigationId: string,
  gate: Gate,
  bytes: string,
  markdown: string
): ProposalPaths {
  const paths = proposalPaths(rt, investigationId, gate);
  writeFileSync(paths.json, bytes, "utf8");
  writeFileSync(
    paths.sha256,
    `${checksumOfBytes(bytes)}  ${GATE_SLUG[gate]}.proposal.json\n`,
    "utf8"
  );
  writeFileSync(paths.markdown, markdown, "utf8");
  return paths;
}
