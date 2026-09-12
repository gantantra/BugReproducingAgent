import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isInvestigatorError, systemClock } from "@investigator/core";
import { SqliteMetadataStore } from "@investigator/storage";
import type { LineageRecordRow } from "@investigator/storage";
import {
  LineageWriter,
  closure,
  computeRecordHash,
  unauthorisedRuns,
  verifyChain,
} from "./index.js";

/**
 * Lineage is the mechanism that makes the governing principle auditable rather than merely
 * asserted: for any node, who produced it. These tests pin the three properties the rest of the
 * system leans on — append-only, total order, tamper-evident — and the queries M2 exit criteria
 * 6, 7 and 11 require.
 */

let dir: string;
let store: SqliteMetadataStore;
const INV = "INV-001";

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "reproagent-lineage-"));
  store = new SqliteMetadataStore({ path: join(dir, "t.db") });
  await store.migrate();
  await store.tx((t) =>
    t.insertInvestigation({
      investigationId: INV,
      title: "t",
      targetName: null,
      createdAt: systemClock.nowIso(),
      status: "open",
    })
  );
});

afterEach(async () => {
  await store.close();
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* disposable */
  }
});

const DET = { kind: "deterministic", component: "execution", version: "0.1.0" } as const;

async function chain(writer: LineageWriter): Promise<void> {
  await writer.append({
    investigationId: INV,
    edge: "approved_as",
    fromKind: "experiment_proposal",
    fromId: "EXP-001",
    toKind: "approved_experiment",
    toId: "AEXP-001",
    actor: { kind: "human", name: "Operator", approvalId: "APPR-001" },
  });
  await writer.append({
    investigationId: INV,
    edge: "scheduled_as",
    fromKind: "approved_experiment",
    fromId: "AEXP-001",
    toKind: "job",
    toId: "JOB-aaaa",
    actor: DET,
  });
  await writer.append({
    investigationId: INV,
    edge: "executed_as",
    fromKind: "job",
    fromId: "JOB-aaaa",
    toKind: "run",
    toId: "RUN-001",
    actor: DET,
  });
}

describe("lineage hash chain", () => {
  it("assigns gap-free sequence and a verifying chain", async () => {
    const writer = new LineageWriter(store);
    await chain(writer);

    const records = await store.read((t) => t.listLineage(INV));
    expect(records.map((r) => r.seq)).toEqual([1, 2, 3]);
    expect(records[0]?.prevRecordHash).toBeNull();
    expect(records[1]?.prevRecordHash).toBe(records[0]?.recordHash);

    const v = verifyChain(records);
    expect(v.ok, JSON.stringify(v.firstBreak)).toBe(true);
    expect(v.records).toBe(3);
  });

  it("detects a record edited in place, and names it", async () => {
    const writer = new LineageWriter(store);
    await chain(writer);
    const records = await store.read((t) => t.listLineage(INV));

    // Rewrite what a run was executed from, leaving the stored hash alone: the shape a local
    // tamper takes when someone wants a run to look authorised by a different approval.
    const tampered = records.map((r, i) => (i === 2 ? { ...r, fromId: "JOB-ffff" } : r));
    const v = verifyChain(tampered);
    expect(v.ok).toBe(false);
    expect(v.firstBreak?.seq).toBe(3);
    expect(v.firstBreak?.reason).toContain("edited in place");
  });

  it("detects a removed record as a sequence gap", async () => {
    const writer = new LineageWriter(store);
    await chain(writer);
    const records = await store.read((t) => t.listLineage(INV));

    const v = verifyChain([records[0]!, records[2]!]);
    expect(v.ok).toBe(false);
    expect(v.firstBreak?.reason).toContain("sequence gap");
  });

  it("detects a reordered or spliced record through the predecessor link", async () => {
    const writer = new LineageWriter(store);
    await chain(writer);
    const records = await store.read((t) => t.listLineage(INV));

    // Same contents, same seq, but pointing at the wrong predecessor.
    const spliced = records.map((r, i) => {
      if (i !== 1) return r;
      const withoutHash = { ...r, prevRecordHash: "sha256:not-the-previous-record" };
      // Re-hash it so the record is internally consistent: only the LINK is wrong, which is what
      // distinguishes a splice from an in-place edit.
      return { ...withoutHash, recordHash: computeRecordHash(withoutHash) } as LineageRecordRow;
    });
    const v = verifyChain(spliced);
    expect(v.ok).toBe(false);
    expect(v.firstBreak?.seq).toBe(2);
    expect(v.firstBreak?.reason).toContain("inserted, removed, or reordered");
  });

  it("is append-only: the store rejects an update to a lineage row", async () => {
    const writer = new LineageWriter(store);
    await chain(writer);
    let err: unknown;
    try {
      store.raw().exec("UPDATE lineage SET to_id = 'RUN-999' WHERE seq = 3");
    } catch (e) {
      err = e;
    }
    expect(err, "a lineage update must be refused").toBeDefined();
    expect(String((err as Error).message)).toContain("APPEND_ONLY");
  });
});

describe("lineage edge validity", () => {
  it("refuses an edge between kinds it cannot connect", async () => {
    const writer = new LineageWriter(store);
    let err: unknown;
    try {
      await writer.append({
        investigationId: INV,
        edge: "executed_as",
        fromKind: "run",
        fromId: "RUN-001",
        toKind: "job",
        toId: "JOB-aaaa",
        actor: DET,
      });
    } catch (e) {
      err = e;
    }
    expect(isInvestigatorError(err)).toBe(true);
    expect((err as Error).message).toContain("cannot connect");
  });

  it("requires the columns the actor kind implies", async () => {
    // A human edge without an approval violates the database CHECK. The writer fills these from
    // the actor union so the requirement cannot be forgotten at a call site.
    const writer = new LineageWriter(store);
    const rec = await writer.append({
      investigationId: INV,
      edge: "approved_as",
      fromKind: "experiment_proposal",
      fromId: "EXP-001",
      toKind: "approved_experiment",
      toId: "AEXP-001",
      actor: { kind: "human", name: "Operator", approvalId: "APPR-001" },
    });
    expect(rec.actorKind).toBe("human");
    expect(rec.approvalId).toBe("APPR-001");
    expect(rec.actorComponent).toBeNull();
  });
});

describe("lineage closure", () => {
  it("reconstructs ancestors and descendants with actor kind on every hop", async () => {
    const writer = new LineageWriter(store);
    await chain(writer);
    const records = await store.read((t) => t.listLineage(INV));

    const c = closure(records, "RUN-001");
    expect(c.descendants).toHaveLength(0);
    expect(c.ancestors.map((h) => h.edge)).toEqual(["approved_as", "scheduled_as", "executed_as"]);
    // The human/AI/deterministic boundary must be visible at a glance.
    expect(c.ancestors.map((h) => h.actorKind)).toEqual([
      "human",
      "deterministic",
      "deterministic",
    ]);
    expect(c.ancestors[0]?.actor).toContain("APPR-001");

    const forward = closure(records, "EXP-001");
    expect(forward.descendants.map((h) => h.toId)).toEqual(["AEXP-001", "JOB-aaaa", "RUN-001"]);
  });

  it("terminates on a supersession cycle rather than looping", async () => {
    const writer = new LineageWriter(store);
    await writer.append({
      investigationId: INV,
      edge: "superseded_by",
      fromKind: "flow",
      fromId: "FLOW-001",
      toKind: "flow",
      toId: "FLOW-002",
      actor: DET,
    });
    await writer.append({
      investigationId: INV,
      edge: "superseded_by",
      fromKind: "flow",
      fromId: "FLOW-002",
      toKind: "flow",
      toId: "FLOW-001",
      actor: DET,
    });
    const records = await store.read((t) => t.listLineage(INV));
    const c = closure(records, "FLOW-001");
    expect(c.descendants.length).toBe(2);
  });
});

describe("authorisation query", () => {
  it("reports no unauthorised run when the chain reaches a human approval", async () => {
    const writer = new LineageWriter(store);
    await chain(writer);
    const records = await store.read((t) => t.listLineage(INV));
    expect(unauthorisedRuns(records)).toEqual([]);
  });

  it("names a run whose chain never reaches a human decision", async () => {
    // The shape of the bug this query exists to catch: something scheduled and executed without
    // ever passing a gate.
    const writer = new LineageWriter(store);
    await writer.append({
      investigationId: INV,
      edge: "executed_as",
      fromKind: "job",
      fromId: "JOB-bbbb",
      toKind: "run",
      toId: "RUN-002",
      actor: DET,
    });
    const records = await store.read((t) => t.listLineage(INV));
    expect(unauthorisedRuns(records)).toEqual(["RUN-002"]);
  });
});

/**
 * A workspace holds many investigations, and each keeps its own provenance chain.
 *
 * This regressed for real: `lineage_id` is allocated from a PER-INVESTIGATION sequence, but the
 * v1 schema made it a GLOBAL primary key. The second investigation in a workspace collided on
 * LIN-000001 the instant it recorded its first edge, so a workspace could hold provenance for
 * exactly one investigation. Every test until now used a single investigation, and every e2e
 * flow created a fresh workspace, so nothing noticed.
 */
describe("lineage ids are scoped to their investigation", () => {
  const OTHER = "INV-002";

  beforeEach(async () => {
    await store.tx((t) =>
      t.insertInvestigation({
        investigationId: OTHER,
        title: "second",
        targetName: null,
        createdAt: systemClock.nowIso(),
        status: "open",
      })
    );
  });

  const firstEdge = (investigationId: string) => ({
    investigationId,
    edge: "executed_as" as const,
    fromKind: "job" as const,
    fromId: "JOB-1",
    toKind: "run" as const,
    toId: "RUN-001",
    actor: DET,
  });

  it("two investigations each start at LIN-000001 without colliding", async () => {
    const writer = new LineageWriter(store);
    const a = await writer.append(firstEdge(INV));
    const b = await writer.append(firstEdge(OTHER));

    expect(a.lineageId).toBe("LIN-000001");
    expect(b.lineageId).toBe("LIN-000001");
    expect(a.seq).toBe(1);
    expect(b.seq).toBe(1);
  });

  it("keeps the two chains separate", async () => {
    const writer = new LineageWriter(store);
    await writer.append(firstEdge(INV));
    await writer.append(firstEdge(OTHER));
    await writer.append({ ...firstEdge(INV), toId: "RUN-002" });

    const mine = await store.read((t) => t.listLineage(INV));
    const theirs = await store.read((t) => t.listLineage(OTHER));
    expect(mine).toHaveLength(2);
    expect(theirs).toHaveLength(1);

    // Each chain verifies on its own. A shared id space would have let one investigation's
    // record become the other's predecessor, which is precisely the tamper-evidence this
    // structure exists to provide.
    expect(verifyChain(mine).ok).toBe(true);
    expect(verifyChain(theirs).ok).toBe(true);
  });

  it("still refuses a duplicate id within ONE investigation", async () => {
    // Narrowing the constraint must not have removed it. Re-inserting the same (investigation,
    // lineage id) has to fail, or append-only means nothing.
    const writer = new LineageWriter(store);
    const first = await writer.append(firstEdge(INV));
    let threw = false;
    try {
      await store.tx((t) => t.insertLineage({ ...first }));
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });
});
