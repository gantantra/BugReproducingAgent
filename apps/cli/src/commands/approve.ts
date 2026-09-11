import { existsSync, readFileSync, writeFileSync } from "node:fs";
import {
  approvalId as makeApprovalId,
  canonicalJson,
  fail,
  systemClock,
  type Gate,
} from "@investigator/core";
import { ensureInvestigationDirs } from "@investigator/storage";
import {
  GATES,
  GATE_NUMBER,
  canonicalProposalBytes,
  scaffoldApprovalYaml,
  validateApproval,
} from "@investigator/approvals";
import { LineageWriter } from "@investigator/lineage";
import type { GlobalOptions, Runtime } from "../runtime.js";
import { approvalScaffoldPath, destructiveActionIds, readProposal } from "../gates.js";

/**
 * `investigate approve <gate>` — the ONLY place an ApprovalRecord is constructed.
 *
 * Playwright produces evidence. Deterministic software normalizes and measures evidence. DeepSeek interprets and prioritizes evidence. Humans authorize consequential transitions.
 *
 * Everything protective about this command lives in `@investigator/approvals`; this handler's job
 * is to read bytes, call the validator, and — only if all nine checks pass — write one immutable
 * record in one transaction. There is no `--yes`, no `--force`, and no configuration that skips a
 * check. `--scaffold` writes a starting file and approves nothing.
 */

export interface ApproveOptions {
  scaffold?: boolean;
  from?: string;
  checksum?: string;
  approver?: string;
}

export interface ApproveResult {
  json: unknown;
  human: () => string;
}

const EDGE_FOR_GATE: Record<
  Gate,
  {
    edge: "approved_as" | "approved_signature" | "approved_reproduction";
    fromKind: "experiment_proposal" | "failure_signature" | "validated_reproduction";
    toKind: "approved_experiment" | "approved_failure_signature" | "approved_reproduction";
  }
> = {
  experiment_selection: {
    edge: "approved_as",
    fromKind: "experiment_proposal",
    toKind: "approved_experiment",
  },
  target_failure: {
    edge: "approved_signature",
    fromKind: "failure_signature",
    toKind: "approved_failure_signature",
  },
  final_reproduction: {
    edge: "approved_reproduction",
    fromKind: "validated_reproduction",
    toKind: "approved_reproduction",
  },
};

export async function approveCommand(
  rt: Runtime,
  gateArg: string,
  opts: ApproveOptions,
  globals: GlobalOptions
): Promise<ApproveResult> {
  if (!(GATES as readonly string[]).includes(gateArg)) {
    fail("INPUT_INVALID", `Unknown gate ${gateArg}. One of: ${GATES.join(", ")}`, {
      context: { gate: gateArg },
    });
  }
  const gate = gateArg as Gate;

  const investigationId = globals.investigation;
  if (!investigationId) {
    fail("INPUT_INVALID", "`investigate approve` requires --investigation <id>", {
      context: { flag: "--investigation" },
    });
  }

  const proposal = readProposal(rt, investigationId, gate);
  if (!proposal) {
    fail(
      "GATE_REQUIRED",
      `No ${gate} proposal has been rendered for ${investigationId}. Run \`investigate plan\` first.`,
      { context: { investigationId, gate } }
    );
  }

  // ---------------------------------------------------------------------------------------
  // --scaffold: write a pre-filled, schema-valid file. This approves NOTHING.
  // ---------------------------------------------------------------------------------------
  if (opts.scaffold) {
    ensureInvestigationDirs(rt.workspace, investigationId);
    const path = approvalScaffoldPath(rt, investigationId, gate);
    if (existsSync(path)) {
      fail(
        "INPUT_INVALID",
        `An approval file already exists at ${path}. Edit it, or delete it to scaffold afresh.`,
        { context: { path } }
      );
    }
    const text = scaffoldApprovalYaml({
      gate,
      investigationId,
      proposalChecksum: proposal.checksum,
      bundle: proposal.bundle,
      approverName: opts.approver ?? "",
      decidedAt: systemClock.nowIso(),
      classifyDestructive: (item) => destructiveActionIds(rt, item),
    });
    writeFileSync(path, text, "utf8");

    const command =
      `investigate approve ${gate} --investigation ${investigationId} ` +
      `--from ${path} --checksum ${proposal.checksum}`;

    return {
      json: {
        ok: true,
        scaffolded: true,
        approved: false,
        path,
        proposalChecksum: proposal.checksum,
        nextCommand: command,
      },
      human: () =>
        [
          `Scaffolded an approval file. Nothing has been approved.`,
          `  edit   ${path}`,
          `  read   ${proposal.bundle.items.length} item(s) in the rendered proposal first`,
          "",
          "Then record the decision:",
          `  ${command}`,
        ].join("\n"),
    };
  }

  // ---------------------------------------------------------------------------------------
  // The real thing.
  // ---------------------------------------------------------------------------------------
  if (!opts.from || !opts.checksum) {
    fail(
      "INPUT_INVALID",
      "`investigate approve` requires --from <approval.yaml> and --checksum <sha256>, " +
        "or --scaffold to create the file. The checksum binds the decision to exact bytes.",
      { context: { from: opts.from ?? null, checksum: opts.checksum ?? null } }
    );
  }

  let approvalText: string;
  try {
    approvalText = readFileSync(opts.from, "utf8");
  } catch (e) {
    return fail("INPUT_INVALID", "Cannot read the approval file", {
      context: { path: opts.from },
      cause: e,
    });
  }

  const approvals = await rt.metadata.read((t) => t.listApprovals(investigationId));

  // The stored hash is what the proposal hashed to when it was rendered. Comparing the file on
  // disk against it is what makes an edit-after-rendering detectable.
  const storedRefs = await rt.artifacts.list(investigationId, { kind: "proposal" });
  const storedRef = storedRefs.filter((r) => r.sha256 === proposal.checksum).slice(-1)[0];
  const storedProposalHash = storedRef?.sha256 ?? proposal.checksum;

  const validated = validateApproval({
    approvalText,
    flagChecksum: opts.checksum,
    gate,
    investigationId,
    proposalBytes: proposal.bytes,
    storedProposalHash,
    approvals,
    expiryHours: rt.config.approvals.expiryHours,
    classifyDestructive: (item) => destructiveActionIds(rt, item),
    clock: systemClock,
  });

  // ---------------------------------------------------------------------------------------
  // All nine checks passed. One short transaction from here.
  // ---------------------------------------------------------------------------------------
  const effectiveBytes = canonicalProposalBytes(validated.effective);

  const effectiveRef = await rt.artifacts.put({
    investigationId,
    kind: "effective-proposal",
    filename: `${gate}.effective-proposal.json`,
    bytes: effectiveBytes,
    contentType: "application/json",
    redactionApplied: rt.redactor.policyStamp(),
  });

  // The approval file itself is stored, so what a human wrote is recoverable offline.
  const approvalFileRef = await rt.artifacts.put({
    investigationId,
    kind: "approval-file",
    filename: `${gate}.approval.yaml`,
    bytes: approvalText,
    contentType: "text/yaml",
    redactionApplied: rt.redactor.policyStamp(),
  });

  const seq = await rt.metadata.tx((t) => t.nextSequence(investigationId, "approval"));
  const approvalRecordId = makeApprovalId(seq);
  const recordedAt = systemClock.nowIso();

  await rt.metadata.tx((t) =>
    t.insertApproval({
      approvalId: approvalRecordId,
      investigationId,
      gate,
      approvalType: "gate_decision",
      proposalChecksum: opts.checksum!,
      effectiveProposalChecksum: validated.effectiveChecksum,
      decision: validated.file.decision,
      approverName: validated.file.approver.name,
      decidedAt: validated.file.decidedAt,
      recordedAt,
      payloadJson: canonicalJson({
        approvedItemIds: validated.approvedItemIds,
        rejectedItemIds: validated.file.rejectedItemIds ?? [],
        edits: validated.file.edits ?? [],
        safetyAcknowledgements: validated.file.safetyAcknowledgements ?? [],
        requestedChanges: validated.file.requestedChanges ?? [],
        notes: validated.file.notes ?? "",
        effectiveProposalArtifactId: effectiveRef.artifactId,
        approvalFileArtifactId: approvalFileRef.artifactId,
      }),
    })
  );

  // One human edge per approved item, each naming the approval that authorised it. This is what
  // `unauthorisedRuns` later walks to prove nothing reached the browser ungoverned.
  const lineage = new LineageWriter(rt.metadata, systemClock);
  const spec = EDGE_FOR_GATE[gate];
  const approvedNodeIds: string[] = [];
  if (validated.file.decision === "approve") {
    for (const itemId of validated.approvedItemIds) {
      const approvedId = `A${itemId}`;
      approvedNodeIds.push(approvedId);
      await lineage.append({
        investigationId,
        edge: spec.edge,
        fromKind: spec.fromKind,
        fromId: itemId,
        toKind: spec.toKind,
        toId: approvedId,
        actor: {
          kind: "human",
          name: validated.file.approver.name,
          approvalId: approvalRecordId,
        },
        inputs: {
          proposalChecksum: opts.checksum,
          effectiveProposalChecksum: validated.effectiveChecksum,
          edits: (validated.file.edits ?? []).filter((e) => e.itemId === itemId).length,
        },
      });
      await lineage.append({
        investigationId,
        edge: "governed_by",
        fromKind: spec.toKind,
        fromId: approvedId,
        toKind: "approval",
        toId: approvalRecordId,
        actor: {
          kind: "human",
          name: validated.file.approver.name,
          approvalId: approvalRecordId,
        },
      });
    }
  }

  const editCount = (validated.file.edits ?? []).length;
  const nextCommand =
    validated.file.decision === "approve" && gate === "experiment_selection"
      ? `investigate run --investigation ${investigationId}`
      : `investigate status --investigation ${investigationId}`;

  return {
    json: {
      ok: true,
      approvalId: approvalRecordId,
      investigationId,
      gate,
      decision: validated.file.decision,
      approvedItemIds: validated.approvedItemIds,
      edits: editCount,
      proposalChecksum: opts.checksum,
      effectiveProposalChecksum: validated.effectiveChecksum,
      effectiveProposalArtifactId: effectiveRef.artifactId,
      approvalFileArtifactId: approvalFileRef.artifactId,
      approvedNodeIds,
      nextCommand,
    },
    human: () =>
      [
        `Gate ${GATE_NUMBER[gate]} (${gate}) — ${validated.file.decision.toUpperCase()}`,
        `  approval   ${approvalRecordId}  by ${validated.file.approver.name}`,
        `  items      ${validated.approvedItemIds.join(", ") || "(none)"}`,
        `  edits      ${editCount}`,
        `  proposal   ${opts.checksum}`,
        `  effective  ${validated.effectiveChecksum}`,
        "",
        validated.file.decision === "approve"
          ? "Execution reads the EFFECTIVE proposal, never the pre-edit one."
          : "Nothing is authorised to run.",
        "",
        `Next: ${nextCommand}`,
      ].join("\n"),
  };
}
