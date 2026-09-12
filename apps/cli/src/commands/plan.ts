import { readFileSync } from "node:fs";
import { fail, schemaRegistry, systemClock, type Gate } from "@investigator/core";
import { ensureInvestigationDirs } from "@investigator/storage";
import {
  canonicalProposalBytes,
  checksumOfBytes,
  renderProposalMarkdown,
  type ProposalBundle,
} from "@investigator/approvals";
import { LineageWriter } from "@investigator/lineage";
import { runFlow } from "@investigator/ai-flows";
import type { GlobalOptions, Runtime } from "../runtime.js";
import { GATE_SLUG, writeProposalTriple } from "../gates.js";
import { openAiSession } from "../ai.js";
import { buildToolRegistry, readFlowFacts, readPreviousExperiments } from "../tool-registry.js";

/**
 * `investigate plan --from <file>` — render a gate-1 proposal for a human to decide on.
 *
 * Playwright produces evidence. Deterministic software normalizes and measures evidence. DeepSeek interprets and prioritizes evidence. Humans authorize consequential transitions.
 *
 * In M2 the candidate experiments are supplied as a file. `propose_experiments` (M3) will produce
 * the same bundle from a flow, and every downstream step — checksum, approval, execution — is
 * identical either way. That is deliberate: the gate does not care whether a human or a model
 * wrote the proposal, only that a human approved the exact bytes.
 *
 * Rendering is idempotent in the sense that matters: the same input produces the same canonical
 * bytes and therefore the same checksum. Re-rendering a CHANGED proposal produces a new checksum,
 * which returns the gate to AWAITING_APPROVAL and supersedes any earlier decision without
 * mutating it.
 */

export interface PlanOptions {
  from?: string;
  gate?: string;
  /** Generate the proposal with `propose_experiments` instead of reading a file (M3). */
  ai?: boolean;
  replay?: string;
}

export interface PlanResult {
  json: unknown;
  human: () => string;
}

export async function planCommand(
  rt: Runtime,
  opts: PlanOptions,
  globals: GlobalOptions
): Promise<PlanResult> {
  if (!opts.from && !opts.ai) {
    fail(
      "INPUT_INVALID",
      "`investigate plan` needs either --from <proposal.json> or --ai to generate one with propose_experiments.",
      { context: { flag: "--from" } }
    );
  }

  const investigationId = globals.investigation;
  if (!investigationId) {
    fail("INPUT_INVALID", "`investigate plan` requires --investigation <id>", {
      context: { flag: "--investigation" },
    });
  }
  const investigation = await rt.metadata.read((t) => t.getInvestigation(investigationId));
  if (!investigation) {
    fail("GATE_REFERENCE_UNKNOWN", `Unknown investigation ${investigationId}. Run intake first.`, {
      context: { investigationId },
    });
  }

  const gate = (opts.gate ?? "experiment_selection") as Gate;

  let input: unknown;
  let generatedBy: {
    flowId: string;
    flowVersion: string;
    flowHash: string;
    aiRequestIds: string[];
  } | null = null;

  if (opts.ai) {
    // The model proposes; a human still decides. Everything downstream of here -- canonical bytes,
    // checksum, approval, execution -- is identical whether a person or a model wrote the
    // proposal, which is exactly the point: the gate does not care who drafted it.
    const session = await openAiSession({
      rt,
      investigationId,
      flowId: "propose_experiments",
      ...(opts.replay ? { replayDir: opts.replay } : {}),
    });
    const previous = await readPreviousExperiments(rt, investigationId);
    // The flow interpreted from the human's report at `intake --ai`. Null when no AI intake has
    // run, in which case `get_flow` reports NOT_READY and the model proposes from constraints
    // and prior runs alone -- visibly, rather than by quietly reasoning about nothing.
    const flow = await readFlowFacts(rt, investigationId);
    const registry = buildToolRegistry(rt, investigationId, { flow, previous });

    // `propose-experiments.output.v1.json`: summary + items only. The model must not mint
    // `gate`, `investigationId` or `renderedAt` -- the system already knows those, and asking a
    // model for a fact it cannot observe is asking it to fabricate one.
    const result = await runFlow<{
      summary?: string;
      items?: Array<Record<string, unknown>>;
    }>(
      {
        flow: session.flow,
        input: { investigationId },
        userContent: JSON.stringify({
          investigationId,
          instruction: "Propose ranked experiments. Use your tools before proposing.",
        }),
      },
      {
        investigationId,
        gateway: session.gateway,
        capabilities: session.capabilities,
        registry,
        toolContext: {
          investigationId,
          normalizerVersion: "1.0.0",
          extractorVersion: "1.0.0",
          redaction: rt.redactor.policyStamp(),
          captureStatus: {},
          maxBytes: session.flow.definition.budget.maxEvidenceBytes,
        },
      }
    );

    if (result.status !== "complete") {
      fail(
        "AI_INVALID_OUTPUT",
        `propose_experiments did not complete: ${result.status === "inconclusive" ? result.reason : "partial"}`,
        { context: { flowId: "propose_experiments", status: result.status } }
      );
    }
    input = result.value;
    generatedBy = {
      flowId: session.flow.definition.id,
      flowVersion: session.flow.definition.version,
      flowHash: session.flow.flowHash,
      aiRequestIds: result.record.aiRequestIds,
    };
  } else {
    try {
      input = JSON.parse(readFileSync(opts.from!, "utf8"));
    } catch (e) {
      return fail("INPUT_INVALID", "Cannot read the proposal input file", {
        context: { path: opts.from ?? "" },
        cause: e,
      });
    }
  }

  const draft = input as Partial<ProposalBundle>;

  // The bundle is normalised so that the operator's file does not have to repeat what the CLI
  // already knows, and so that `renderedAt` comes from the injected clock rather than the file.
  const bundle: ProposalBundle = {
    schemaVersion: "1.0.0",
    gate,
    investigationId,
    renderedAt: systemClock.nowIso(),
    ...(draft.flowId ? { flowId: draft.flowId } : {}),
    ...(draft.summary ? { summary: draft.summary } : {}),
    items: draft.items ?? [],
  };

  /*
   * An empty proposal is an ANSWER, not a malformed document.
   *
   * The flow reaches it honestly: given a report it cannot ground -- no selector, no URL, an origin
   * that is not a configured target -- the correct output is "nothing can be proposed, and here is
   * why", which is exactly what the model writes into `summary`. Rejecting that as invalid made the
   * flow spend its one repair attempt re-deriving the same answer, and the extra turn then blew the
   * wall-clock budget, so a correct result surfaced as a timeout.
   *
   * No proposal triple is written and no checksum is minted: there is nothing to approve, and a
   * checksum over an empty bundle would let someone approve nothing at all.
   */
  if (bundle.items.length === 0) {
    const reason = bundle.summary?.trim();
    return {
      json: {
        ok: true,
        investigationId,
        gate,
        proposalRendered: false,
        items: [] as string[],
        reason: reason ?? null,
        generatedBy,
        nextCommand: `investigate intake --investigation ${investigationId} --from <report.md> --ai`,
      },
      human: () =>
        [
          `No experiments could be proposed for ${investigationId}.`,
          "",
          reason ?? "The flow returned no reason.",
          "",
          "This is an answer, not a failure: nothing was invented to fill the gaps. Supply what is",
          "missing -- a target whose origin matches the report, a real selector, the path -- and",
          "render the proposal again.",
        ].join("\n"),
    };
  }
  const ids = new Set<string>();
  for (const item of bundle.items) {
    if (ids.has(item.itemId)) {
      fail("INPUT_INVALID", `Duplicate itemId ${item.itemId} in the proposal`, {
        context: { itemId: item.itemId },
      });
    }
    ids.add(item.itemId);
  }

  schemaRegistry().assert("gate-proposal.v1.json", bundle, opts.from ?? "propose_experiments");

  const bytes = canonicalProposalBytes(bundle);
  const checksum = checksumOfBytes(bytes);

  ensureInvestigationDirs(rt.workspace, investigationId);
  const markdown = renderProposalMarkdown(bundle, checksum);
  const paths = writeProposalTriple(rt, investigationId, gate, bytes, markdown);

  // Stored as an artifact so its hash is independently recorded: a later edit of the file on disk
  // is then detectable as GATE_PROPOSAL_STALE rather than silently approved.
  const ref = await rt.artifacts.put({
    investigationId,
    kind: "proposal",
    filename: `${GATE_SLUG[gate]}.proposal.json`,
    bytes,
    contentType: "application/json",
    redactionApplied: rt.redactor.policyStamp(),
  });

  const lineage = new LineageWriter(rt.metadata, systemClock);
  for (const item of bundle.items) {
    await lineage.append({
      investigationId,
      edge: "proposed_from",
      fromKind: "flow",
      fromId: bundle.flowId ?? "FLOW-000",
      toKind: "experiment_proposal",
      toId: item.itemId,
      // The actor records WHO drafted this proposal. A file-supplied one is a deterministic
      // transcription; a generated one must carry the call id and the exact prompt hash, so a
      // later reader can tell a human's proposal from a model's at a glance.
      actor: generatedBy
        ? {
            kind: "ai",
            aiCallId: generatedBy.aiRequestIds[0] ?? "AIC-unknown",
            flowId: generatedBy.flowId,
            flowVersion: generatedBy.flowVersion,
            flowHash: generatedBy.flowHash,
          }
        : { kind: "deterministic", component: "cli:plan", version: "0.1.0" },
      inputs: {
        proposalChecksum: checksum,
        proposalArtifactId: ref.artifactId,
        rank: item["rank"] ?? null,
      },
    });
  }

  return {
    json: {
      ok: true,
      investigationId,
      gate,
      proposalChecksum: checksum,
      proposalArtifactId: ref.artifactId,
      items: bundle.items.map((i) => i.itemId),
      generatedBy,
      files: paths,
      nextCommand: `investigate approve ${gate} --investigation ${investigationId} --scaffold`,
    },
    human: () =>
      [
        `Gate 1 proposal rendered for ${investigationId}.`,
        `  items      ${bundle.items.map((i) => i.itemId).join(", ")}`,
        `  checksum   ${checksum}`,
        `  read       ${paths.markdown}`,
        "",
        "Read the proposal, then scaffold an approval file:",
        `  investigate approve ${gate} --investigation ${investigationId} --scaffold`,
        "",
        "Nothing runs until that approval is recorded. Re-rendering a changed proposal produces a",
        "new checksum and invalidates any approval of the old one, by design.",
      ].join("\n"),
  };
}
