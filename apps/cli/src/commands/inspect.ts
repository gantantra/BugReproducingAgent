import { fail, type Gate } from "@investigator/core";
import { closure, unauthorisedRuns, verifyChain } from "@investigator/lineage";
import { GATES, GATE_NUMBER } from "@investigator/approvals";
import type { GlobalOptions, Runtime } from "../runtime.js";
import { gateStates, readProposal } from "../gates.js";

/**
 * Read-only inspection: `status`, `show`, `lineage`.
 *
 * Playwright produces evidence. Deterministic software normalizes and measures evidence. DeepSeek interprets and prioritizes evidence. Humans authorize consequential transitions.
 *
 * All three answer offline, from the database and artifacts alone: no browser, no provider. That
 * is not a convenience, it is M2 exit criterion 7 — provenance that can only be reconstructed by
 * re-running something is not provenance.
 */

export interface CommandResult {
  json: unknown;
  human: () => string;
}

function requireInvestigation(globals: GlobalOptions): string {
  if (!globals.investigation) {
    fail("INPUT_INVALID", "This command requires --investigation <id>", {
      context: { flag: "--investigation" },
    });
  }
  return globals.investigation;
}

export async function statusCommand(rt: Runtime, globals: GlobalOptions): Promise<CommandResult> {
  const investigationId = requireInvestigation(globals);
  const investigation = await rt.metadata.read((t) => t.getInvestigation(investigationId));
  if (!investigation) {
    fail("GATE_REFERENCE_UNKNOWN", `Unknown investigation ${investigationId}`, {
      context: { investigationId },
    });
  }

  const states = await gateStates(rt, investigationId);
  const runs = await rt.metadata.read((t) => t.listRuns(investigationId));
  const queue = await rt.queue.stats(investigationId);
  const records = await rt.metadata.read((t) => t.listLineage(investigationId));
  const chain = verifyChain(records);

  const byOutcome: Record<string, number> = {};
  for (const r of runs) if (r.outcome) byOutcome[r.outcome] = (byOutcome[r.outcome] ?? 0) + 1;

  // What the operator should do next, derived from state rather than guessed.
  let next = `investigate plan --investigation ${investigationId} --from <proposal.json>`;
  const gate1 = states["experiment_selection"];
  if (gate1.state === "AWAITING_APPROVAL") {
    next = `investigate approve experiment_selection --investigation ${investigationId} --scaffold`;
  } else if (gate1.state === "APPROVED") {
    next = `investigate run --investigation ${investigationId}`;
  }

  return {
    json: {
      ok: true,
      investigationId,
      title: investigation.title,
      status: investigation.status,
      target: investigation.targetName,
      gates: GATES.map((g) => ({
        gate: g,
        number: GATE_NUMBER[g],
        state: states[g].state,
        approvalId: states[g].approvalId,
        proposalChecksum: states[g].proposalChecksum,
        supersededApprovalIds: states[g].supersededApprovalIds,
      })),
      runs: runs.length,
      byOutcome,
      queue,
      lineage: { records: chain.records, chainOk: chain.ok, firstBreak: chain.firstBreak },
      nextCommand: next,
    },
    human: () => {
      const lines = [
        `${investigationId}  ${investigation.title}`,
        `  status   ${investigation.status}`,
        `  target   ${investigation.targetName ?? "(none)"}`,
        "",
        "Gates:",
      ];
      for (const g of GATES) {
        const s = states[g];
        const detail =
          s.state === "APPROVED"
            ? `by ${s.approvalId}`
            : s.state === "AWAITING_APPROVAL"
              ? `checksum ${String(s.proposalChecksum).slice(0, 20)}...`
              : "";
        lines.push(`  ${GATE_NUMBER[g]}. ${g.padEnd(20)} ${s.state.padEnd(18)} ${detail}`);
        if (s.supersededApprovalIds.length) {
          lines.push(`      superseded: ${s.supersededApprovalIds.join(", ")}`);
        }
      }
      lines.push("", `Runs: ${runs.length}`);
      for (const [o, c] of Object.entries(byOutcome).sort()) lines.push(`  ${o.padEnd(24)} ${c}`);
      lines.push(
        "",
        `Lineage: ${chain.records} records, chain ${chain.ok ? "verifies" : "BROKEN"}`
      );
      if (chain.firstBreak)
        lines.push(`  first break at seq ${chain.firstBreak.seq}: ${chain.firstBreak.reason}`);
      lines.push("", `Next: ${next}`);
      return lines.join("\n");
    },
  };
}

export async function showCommand(
  rt: Runtime,
  what: string,
  globals: GlobalOptions
): Promise<CommandResult> {
  const investigationId = requireInvestigation(globals);

  if ((GATES as readonly string[]).includes(what)) {
    const gate = what as Gate;
    const proposal = readProposal(rt, investigationId, gate);
    if (!proposal) {
      fail("GATE_REQUIRED", `No ${gate} proposal has been rendered`, {
        context: { investigationId, gate },
      });
    }
    return {
      json: { ok: true, gate, checksum: proposal.checksum, bundle: proposal.bundle },
      human: () => `${gate} proposal  ${proposal.checksum}\n\n${proposal.bytes}`,
    };
  }

  // Otherwise: an artifact id.
  const ref = await rt.artifacts.head(what);
  const text = await rt.artifacts.getText(what);
  return {
    json: {
      ok: true,
      artifactId: ref.artifactId,
      kind: ref.kind,
      sha256: ref.sha256,
      bytes: ref.byteLength,
    },
    human: () => `${ref.artifactId}  ${ref.kind}  ${ref.sha256}\n\n${text}`,
  };
}

export async function lineageCommand(
  rt: Runtime,
  nodeId: string,
  globals: GlobalOptions
): Promise<CommandResult> {
  const investigationId = requireInvestigation(globals);
  const records = await rt.metadata.read((t) => t.listLineage(investigationId));
  const chain = verifyChain(records);
  const c = closure(records, nodeId);

  if (c.ancestors.length === 0 && c.descendants.length === 0) {
    fail("GATE_REFERENCE_UNKNOWN", `No lineage records mention ${nodeId}`, {
      context: { nodeId, investigationId },
    });
  }

  return {
    json: {
      ok: true,
      nodeId,
      chainOk: chain.ok,
      ancestors: c.ancestors,
      descendants: c.descendants,
      unauthorisedRuns: unauthorisedRuns(records),
    },
    human: () => {
      const lines = [`Lineage for ${nodeId}`, ""];
      const render = (title: string, hops: typeof c.ancestors): void => {
        lines.push(`${title} (${hops.length}):`);
        if (hops.length === 0) lines.push("  (none)");
        for (const h of hops) {
          lines.push(
            `  ${String(h.seq).padStart(3)}  ${h.edge.padEnd(20)} ${h.fromId} -> ${h.toId}`,
            `       ${h.actorKind.padEnd(13)} ${h.actor}`
          );
        }
        lines.push("");
      };
      render("Ancestors", c.ancestors);
      render("Descendants", c.descendants);
      lines.push(`Hash chain: ${chain.ok ? "verifies" : `BROKEN at seq ${chain.firstBreak?.seq}`}`);
      // The question the governing principle exists to answer.
      const humanHops = c.ancestors.filter((h) => h.actorKind === "human");
      lines.push(
        humanHops.length
          ? `Authorised by: ${humanHops.map((h) => h.actor).join(", ")}`
          : "Authorised by: NOTHING — no human decision appears in this node's ancestry."
      );
      return lines.join("\n");
    },
  };
}
