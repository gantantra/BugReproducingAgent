import {
  canonicalJson,
  fail,
  lineageId as makeLineageId,
  sha256Prefixed,
} from "@investigator/core";
import type { Clock } from "@investigator/core";
import { systemClock } from "@investigator/core";
import type { LineageRecordRow, MetadataStore, MetadataTx } from "@investigator/storage";

/**
 * @investigator/lineage — the provenance graph (ADR-0012, docs/architecture/lineage-model.md).
 *
 * Playwright produces evidence. Deterministic software normalizes and measures evidence. DeepSeek interprets and prioritizes evidence. Humans authorize consequential transitions.
 *
 * This package answers one question for any node in an investigation: WHO produced it — a human,
 * deterministic software, or a model. That is not bookkeeping; it is the mechanism by which the
 * governing principle is auditable after the fact rather than merely asserted.
 *
 * Three properties the rest of the system relies on:
 *
 *  1. APPEND-ONLY. There is no update and no delete, here or in the store interface, and SQLite
 *     triggers reject both. A retry, a correction, and a supersession are all new edges.
 *  2. TOTAL ORDER. `seq` is a per-investigation monotonic integer assigned inside the same
 *     transaction as the insert, so the chain has no gaps and no ties.
 *  3. TAMPER-EVIDENT. Each record hashes its own canonical content together with its
 *     predecessor's hash. Rewriting history requires rewriting every subsequent record, and
 *     `verifyChain` reports the first link that does not reconcile. This is detection, not
 *     prevention — the honest guarantee for a local single-user tool, recorded as residual risk
 *     in the security model.
 *
 * This package imports no AI code and never will (ADR-0006).
 */

export const NODE_KINDS = [
  "intake_report",
  "flow",
  "experiment_proposal",
  "approved_experiment",
  "job",
  "run",
  "failure_signature",
  "approved_failure_signature",
  "run_classification",
  "finding",
  "minimization_candidate",
  "validated_reproduction",
  "approved_reproduction",
  "static_test",
  "report",
  "approval",
  "ai_call",
  "artifact",
  "statistic",
] as const;
export type NodeKind = (typeof NODE_KINDS)[number];

export const EDGE_TYPES = [
  "interpreted_as",
  "proposed_from",
  "approved_as",
  "scheduled_as",
  "executed_as",
  "retry_of",
  "extracted_signature",
  "classified_as",
  "approved_signature",
  "derived_finding",
  "supported_by",
  "contradicted_by",
  "proposed_reduction",
  "validated_as",
  "controlled_by",
  "approved_reproduction",
  "emitted_test",
  "reported_in",
  "produced_by",
  "governed_by",
  "superseded_by",
] as const;
export type EdgeType = (typeof EDGE_TYPES)[number];

/** Which kinds an edge may legally connect. An edge outside this table is a programming error. */
const EDGE_ENDPOINTS: Record<EdgeType, { from: NodeKind[]; to: NodeKind[] }> = {
  interpreted_as: { from: ["intake_report"], to: ["flow"] },
  proposed_from: { from: ["flow"], to: ["experiment_proposal"] },
  approved_as: { from: ["experiment_proposal"], to: ["approved_experiment"] },
  scheduled_as: { from: ["approved_experiment"], to: ["job"] },
  executed_as: { from: ["job"], to: ["run"] },
  retry_of: { from: ["job"], to: ["job"] },
  extracted_signature: { from: ["run"], to: ["failure_signature"] },
  classified_as: { from: ["run"], to: ["run_classification"] },
  approved_signature: { from: ["failure_signature"], to: ["approved_failure_signature"] },
  derived_finding: { from: ["run", "statistic", "run_classification"], to: ["finding"] },
  supported_by: {
    from: ["finding"],
    to: ["run", "artifact", "statistic", "approval", "failure_signature"],
  },
  contradicted_by: { from: ["finding"], to: ["run", "artifact", "statistic", "approval"] },
  proposed_reduction: { from: ["approved_experiment"], to: ["minimization_candidate"] },
  validated_as: { from: ["minimization_candidate"], to: ["validated_reproduction"] },
  controlled_by: { from: ["validated_reproduction"], to: ["run"] },
  approved_reproduction: { from: ["validated_reproduction"], to: ["approved_reproduction"] },
  emitted_test: { from: ["approved_reproduction", "approved_experiment"], to: ["static_test"] },
  reported_in: { from: ["finding"], to: ["report"] },
  produced_by: { from: [...NODE_KINDS], to: ["ai_call"] },
  governed_by: { from: [...NODE_KINDS], to: ["approval"] },
  superseded_by: { from: [...NODE_KINDS], to: [...NODE_KINDS] },
};

export type Actor =
  | { kind: "human"; name: string; approvalId: string }
  | { kind: "deterministic"; component: string; version: string }
  | { kind: "ai"; aiCallId: string; flowId: string; flowVersion: string; flowHash: string };

export interface AppendEdgeArgs {
  investigationId: string;
  edge: EdgeType;
  fromKind: NodeKind;
  fromId: string;
  toKind: NodeKind;
  toId: string;
  actor: Actor;
  inputs?: Record<string, unknown>;
}

/**
 * The bytes a record's hash is taken over.
 *
 * Deliberately excludes `recordHash` itself and `lineageId`. Including the id would make the hash
 * depend on an allocation order that carries no meaning; excluding it means two structurally
 * identical edges in different investigations still differ, because `investigationId` and `seq`
 * are both inside.
 */
function hashSubject(rec: Omit<LineageRecordRow, "recordHash">): string {
  return canonicalJson({
    investigationId: rec.investigationId,
    seq: rec.seq,
    edge: rec.edge,
    fromKind: rec.fromKind,
    fromId: rec.fromId,
    toKind: rec.toKind,
    toId: rec.toId,
    actorKind: rec.actorKind,
    actorComponent: rec.actorComponent,
    actorVersion: rec.actorVersion,
    actorName: rec.actorName,
    createdAt: rec.createdAt,
    inputsJson: rec.inputsJson,
    approvalId: rec.approvalId,
    aiCallId: rec.aiCallId,
    flowId: rec.flowId,
    flowVersion: rec.flowVersion,
    flowHash: rec.flowHash,
    prevRecordHash: rec.prevRecordHash,
  });
}

export function computeRecordHash(rec: Omit<LineageRecordRow, "recordHash">): string {
  return sha256Prefixed(hashSubject(rec) + (rec.prevRecordHash ?? ""));
}

function actorColumns(
  actor: Actor
): Pick<
  LineageRecordRow,
  | "actorKind"
  | "actorComponent"
  | "actorVersion"
  | "actorName"
  | "approvalId"
  | "aiCallId"
  | "flowId"
  | "flowVersion"
  | "flowHash"
> {
  // The database CHECK constraints require exactly these combinations; filling them here keeps
  // the requirement in one place instead of at every call site.
  switch (actor.kind) {
    case "human":
      return {
        actorKind: "human",
        actorComponent: null,
        actorVersion: null,
        actorName: actor.name,
        approvalId: actor.approvalId,
        aiCallId: null,
        flowId: null,
        flowVersion: null,
        flowHash: null,
      };
    case "deterministic":
      return {
        actorKind: "deterministic",
        actorComponent: actor.component,
        actorVersion: actor.version,
        actorName: null,
        approvalId: null,
        aiCallId: null,
        flowId: null,
        flowVersion: null,
        flowHash: null,
      };
    case "ai":
      return {
        actorKind: "ai",
        actorComponent: null,
        actorVersion: null,
        actorName: null,
        approvalId: null,
        aiCallId: actor.aiCallId,
        flowId: actor.flowId,
        flowVersion: actor.flowVersion,
        flowHash: actor.flowHash,
      };
  }
}

export class LineageWriter {
  private readonly clock: Clock;

  constructor(
    private readonly metadata: MetadataStore,
    clock?: Clock
  ) {
    this.clock = clock ?? systemClock;
  }

  /**
   * Append one edge. Sequence allocation, hash chaining and insertion happen in ONE transaction:
   * a crash between allocating `seq` and writing the record would otherwise leave a permanent gap
   * that `verifyChain` could never distinguish from deletion.
   */
  async append(args: AppendEdgeArgs): Promise<LineageRecordRow> {
    const endpoints = EDGE_ENDPOINTS[args.edge];
    if (!endpoints) {
      fail("INTERNAL", `Unknown lineage edge ${args.edge}`, { context: { edge: args.edge } });
    }
    if (!endpoints.from.includes(args.fromKind) || !endpoints.to.includes(args.toKind)) {
      fail("INTERNAL", `Edge ${args.edge} cannot connect ${args.fromKind} -> ${args.toKind}`, {
        context: { edge: args.edge, fromKind: args.fromKind, toKind: args.toKind },
      });
    }

    return this.metadata.tx(async (t: MetadataTx) => {
      const seq = await t.nextSequence(args.investigationId, "lineage");
      const previous = await t.lastLineage(args.investigationId);
      const withoutHash: Omit<LineageRecordRow, "recordHash"> = {
        lineageId: makeLineageId(seq),
        investigationId: args.investigationId,
        seq,
        edge: args.edge,
        fromKind: args.fromKind,
        fromId: args.fromId,
        toKind: args.toKind,
        toId: args.toId,
        createdAt: this.clock.nowIso(),
        inputsJson: args.inputs ? canonicalJson(args.inputs) : null,
        prevRecordHash: previous?.recordHash ?? null,
        ...actorColumns(args.actor),
      };
      const rec: LineageRecordRow = {
        ...withoutHash,
        recordHash: computeRecordHash(withoutHash),
      };
      await t.insertLineageEdge(rec);
      return rec;
    });
  }
}

export interface ChainVerification {
  ok: boolean;
  records: number;
  /** The first record whose hash or predecessor link does not reconcile. */
  firstBreak: { lineageId: string; seq: number; reason: string } | null;
}

/**
 * Walk the per-investigation hash chain.
 *
 * Three distinct failures are reported separately, because they mean different things: a gap in
 * `seq` means a record was deleted, a broken `prevRecordHash` means one was inserted or
 * reordered, and a bad `recordHash` means one was edited in place.
 */
export function verifyChain(records: readonly LineageRecordRow[]): ChainVerification {
  const ordered = [...records].sort((a, b) => a.seq - b.seq);
  let previousHash: string | null = null;
  let expectedSeq = 1;

  for (const rec of ordered) {
    if (rec.seq !== expectedSeq) {
      return {
        ok: false,
        records: ordered.length,
        firstBreak: {
          lineageId: rec.lineageId,
          seq: rec.seq,
          reason: `sequence gap: expected seq ${expectedSeq}, found ${rec.seq}. A record is missing.`,
        },
      };
    }
    if ((rec.prevRecordHash ?? null) !== previousHash) {
      return {
        ok: false,
        records: ordered.length,
        firstBreak: {
          lineageId: rec.lineageId,
          seq: rec.seq,
          reason:
            "prevRecordHash does not match the preceding record. A record was inserted, removed, or reordered.",
        },
      };
    }
    const { recordHash, ...withoutHash } = rec;
    const recomputed = computeRecordHash(withoutHash);
    if (recomputed !== recordHash) {
      return {
        ok: false,
        records: ordered.length,
        firstBreak: {
          lineageId: rec.lineageId,
          seq: rec.seq,
          reason:
            "recordHash does not match the record's own contents. This record was edited in place.",
        },
      };
    }
    previousHash = recordHash;
    expectedSeq++;
  }

  return { ok: true, records: ordered.length, firstBreak: null };
}

export interface ClosureHop {
  lineageId: string;
  seq: number;
  edge: string;
  fromKind: string;
  fromId: string;
  toKind: string;
  toId: string;
  actorKind: string;
  actor: string;
  createdAt: string;
  /** Distance from the queried node, in edges. */
  depth: number;
}

export interface Closure {
  nodeId: string;
  ancestors: ClosureHop[];
  descendants: ClosureHop[];
}

function actorLabel(rec: LineageRecordRow): string {
  if (rec.actorKind === "human") return `human:${rec.actorName ?? "?"} (${rec.approvalId ?? "?"})`;
  if (rec.actorKind === "ai") {
    return `ai:${rec.flowId ?? "?"}@${rec.flowVersion ?? "?"} (${rec.aiCallId ?? "?"})`;
  }
  return `deterministic:${rec.actorComponent ?? "?"}@${rec.actorVersion ?? "?"}`;
}

function hop(rec: LineageRecordRow, depth: number): ClosureHop {
  return {
    lineageId: rec.lineageId,
    seq: rec.seq,
    edge: rec.edge,
    fromKind: rec.fromKind,
    fromId: rec.fromId,
    toKind: rec.toKind,
    toId: rec.toId,
    actorKind: rec.actorKind,
    actor: actorLabel(rec),
    createdAt: rec.createdAt,
    depth,
  };
}

/**
 * Ancestor and descendant closure for one node, breadth-first.
 *
 * Pure: it takes records and returns hops, so `investigate lineage` answers offline with no
 * browser and no provider, which exit criterion 7 requires. Cycles are tolerated -- a
 * `superseded_by` pair can legitimately point both ways over time -- by tracking visited nodes
 * rather than assuming a DAG.
 */
export function closure(records: readonly LineageRecordRow[], nodeId: string): Closure {
  const byTo = new Map<string, LineageRecordRow[]>();
  const byFrom = new Map<string, LineageRecordRow[]>();
  for (const rec of records) {
    (byTo.get(rec.toId) ?? byTo.set(rec.toId, []).get(rec.toId)!).push(rec);
    (byFrom.get(rec.fromId) ?? byFrom.set(rec.fromId, []).get(rec.fromId)!).push(rec);
  }

  const walk = (index: Map<string, LineageRecordRow[]>, step: (r: LineageRecordRow) => string) => {
    const out: ClosureHop[] = [];
    const seenNodes = new Set<string>([nodeId]);
    const seenEdges = new Set<string>();
    let frontier = [nodeId];
    let depth = 1;
    while (frontier.length > 0) {
      const next: string[] = [];
      for (const id of frontier) {
        for (const rec of index.get(id) ?? []) {
          if (seenEdges.has(rec.lineageId)) continue;
          seenEdges.add(rec.lineageId);
          out.push(hop(rec, depth));
          const other = step(rec);
          if (!seenNodes.has(other)) {
            seenNodes.add(other);
            next.push(other);
          }
        }
      }
      frontier = next;
      depth++;
    }
    return out.sort((a, b) => a.seq - b.seq);
  };

  return {
    nodeId,
    ancestors: walk(byTo, (r) => r.fromId),
    descendants: walk(byFrom, (r) => r.toId),
  };
}

/**
 * Did anything reach the executor without an approval authorising it?
 *
 * The lineage model names this as a query the graph must answer, and the answer must always be
 * "no". A run is authorised when its job traces back to an approved experiment that is
 * `governed_by` an approval. This is the check that would catch AI output reaching the browser
 * without a human gate.
 */
export function unauthorisedRuns(records: readonly LineageRecordRow[]): string[] {
  const runs = records.filter((r) => r.edge === "executed_as").map((r) => r.toId);
  const unauthorised: string[] = [];
  for (const runId of runs) {
    const ancestors = closure(records, runId).ancestors;
    const governed = ancestors.some((h) => h.edge === "governed_by" && h.toKind === "approval");
    const humanApproved = ancestors.some((h) => h.actorKind === "human");
    if (!governed && !humanApproved) unauthorised.push(runId);
  }
  return unauthorised;
}

export const LINEAGE_COMPONENT = "lineage";
export const LINEAGE_VERSION = "0.1.0";
export const PACKAGE_NAME = "@investigator/lineage";
