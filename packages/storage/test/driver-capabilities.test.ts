import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SqliteMetadataStore, SqliteWorkQueue } from "../src/index.js";
import { isInvestigatorError, systemClock } from "@investigator/core";

/**
 * ADR-0021 requires the twelve-point driver probe to be committed as a test, so that a Node
 * minor upgrade changing `node:sqlite` behaviour surfaces as a named failure rather than as
 * mysterious data corruption.
 *
 * Also covers M1-AT-2 (CHECK constraints), M1-AT-3 (append-only triggers), and M1-AT-4 (no
 * double-claim under contention).
 */

let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "investigator-driver-"));
  dbPath = join(dir, "t.db");
});

afterEach(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* disposable */
  }
});

describe("node:sqlite driver capabilities (ADR-0021)", () => {
  it("supports WAL, busy_timeout, synchronous FULL, and foreign keys", () => {
    const db = new DatabaseSync(dbPath);
    const mode = db.prepare("PRAGMA journal_mode=WAL").get() as Record<string, unknown>;
    expect(String(Object.values(mode)[0]).toLowerCase()).toBe("wal");

    db.exec("PRAGMA busy_timeout=5000");
    expect(Number(Object.values(db.prepare("PRAGMA busy_timeout").get() as object)[0])).toBe(5000);

    db.exec("PRAGMA synchronous=FULL");
    expect(Number(Object.values(db.prepare("PRAGMA synchronous").get() as object)[0])).toBe(2);

    db.exec("PRAGMA foreign_keys=ON");
    expect(Number(Object.values(db.prepare("PRAGMA foreign_keys").get() as object)[0])).toBe(1);
    db.close();
  });

  it("BEGIN IMMEDIATE blocks a second writer, which is what makes claiming safe", () => {
    const a = new DatabaseSync(dbPath);
    a.exec("PRAGMA journal_mode=WAL");
    a.exec("CREATE TABLE t (x INTEGER)");

    const b = new DatabaseSync(dbPath);
    b.exec("PRAGMA busy_timeout=50");

    a.exec("BEGIN IMMEDIATE");
    let blocked = false;
    try {
      b.exec("BEGIN IMMEDIATE");
      b.exec("ROLLBACK");
    } catch {
      blocked = true;
    }
    a.exec("ROLLBACK");
    b.close();
    a.close();

    expect(blocked, "a second BEGIN IMMEDIATE was not blocked").toBe(true);
  });

  it("WAL lets a reader see committed data while a writer holds the database", () => {
    const w = new DatabaseSync(dbPath);
    w.exec("PRAGMA journal_mode=WAL");
    w.exec("CREATE TABLE t (x INTEGER)");
    w.prepare("INSERT INTO t VALUES (?)").run(1);

    const r = new DatabaseSync(dbPath, { readOnly: true });
    const row = r.prepare("SELECT COUNT(*) AS c FROM t").get() as { c: number };
    expect(Number(row.c)).toBe(1);
    r.close();
    w.close();
  });

  it("RAISE(ABORT) in a BEFORE trigger preserves the message", () => {
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE l (id TEXT PRIMARY KEY);
      CREATE TRIGGER l_no_update BEFORE UPDATE ON l
        BEGIN SELECT RAISE(ABORT, 'STORE_APPEND_ONLY_VIOLATION: test'); END;
    `);
    db.prepare("INSERT INTO l VALUES (?)").run("a");
    expect(() => db.prepare("UPDATE l SET id='b'").run()).toThrowError(
      /STORE_APPEND_ONLY_VIOLATION/
    );
    db.close();
  });
});

describe("schema invariants (M1-AT-2, M1-AT-3)", () => {
  async function store(): Promise<SqliteMetadataStore> {
    const s = new SqliteMetadataStore({ path: dbPath });
    await s.migrate();
    await s.tx((t) =>
      t.insertInvestigation({
        investigationId: "INV-001",
        title: "t",
        targetName: null,
        createdAt: systemClock.nowIso(),
        status: "open",
      })
    );
    return s;
  }

  const ILLEGAL: Array<[string, string]> = [
    ["COMPLETED", "INFRASTRUCTURE_FAILED"],
    ["COMPLETED", "INTERRUPTED"],
    ["INTERRUPTED", "VALID_COMPLETED"],
    ["INTERRUPTED", "PRODUCT_FAILED"],
    ["WORKER_ERROR", "PRODUCT_FAILED"],
    ["WORKER_ERROR", "VALID_COMPLETED"],
  ];

  it.each(ILLEGAL)(
    "the database rejects terminal_reason=%s with run_outcome=%s",
    async (reason, outcome) => {
      const s = await store();
      const db = s.raw();
      db.prepare(
        `INSERT INTO jobs (job_id, investigation_id, experiment_id, repetition_index,
           attempt_index, seq, payload_json, state, enqueued_at)
         VALUES ('J1','INV-001','EXP-001',0,0,1,'{}','PENDING', '2026-01-01T00:00:00Z')`
      ).run();

      expect(() =>
        db
          .prepare(
            "UPDATE jobs SET state='TERMINAL', terminal_reason=?, run_outcome=? WHERE job_id='J1'"
          )
          .run(reason, outcome)
      ).toThrowError(/CHECK constraint|constraint failed/);

      await s.close();
    }
  );

  it("the database rejects TERMINAL without a reason, and a reason without TERMINAL", async () => {
    const s = await store();
    const db = s.raw();
    db.prepare(
      `INSERT INTO jobs (job_id, investigation_id, experiment_id, repetition_index,
         attempt_index, seq, payload_json, state, enqueued_at)
       VALUES ('J1','INV-001','EXP-001',0,0,1,'{}','PENDING','2026-01-01T00:00:00Z')`
    ).run();

    expect(() =>
      db.prepare("UPDATE jobs SET state='TERMINAL' WHERE job_id='J1'").run()
    ).toThrowError(/constraint/);
    expect(() =>
      db.prepare("UPDATE jobs SET terminal_reason='COMPLETED' WHERE job_id='J1'").run()
    ).toThrowError(/constraint/);

    await s.close();
  });

  it("lineage and approvals reject update and delete", async () => {
    const s = await store();
    const db = s.raw();

    db.prepare(
      `INSERT INTO lineage (lineage_id, investigation_id, seq, edge, from_kind, from_id,
         to_kind, to_id, actor_kind, actor_component, actor_version, created_at, record_hash)
       VALUES ('LIN-000001','INV-001',1,'executed_as','job','J1','run','RUN-001',
         'deterministic','execution','0.1.0','2026-01-01T00:00:00Z','sha256:x')`
    ).run();

    expect(() =>
      db.prepare("UPDATE lineage SET seq=2 WHERE lineage_id='LIN-000001'").run()
    ).toThrowError(/STORE_APPEND_ONLY_VIOLATION/);
    expect(() =>
      db.prepare("DELETE FROM lineage WHERE lineage_id='LIN-000001'").run()
    ).toThrowError(/STORE_APPEND_ONLY_VIOLATION/);

    db.prepare(
      `INSERT INTO approvals (approval_id, investigation_id, gate, approval_type,
         proposal_checksum, decision, approver_name, decided_at, recorded_at, payload_json)
       VALUES ('APPR-001','INV-001','experiment_selection','gate_decision','sha256:x','approve',
         'tester','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z','{}')`
    ).run();

    expect(() =>
      db.prepare("UPDATE approvals SET decision='reject' WHERE approval_id='APPR-001'").run()
    ).toThrowError(/STORE_APPEND_ONLY_VIOLATION/);
    expect(() =>
      db.prepare("DELETE FROM approvals WHERE approval_id='APPR-001'").run()
    ).toThrowError(/STORE_APPEND_ONLY_VIOLATION/);

    await s.close();
  });

  it("an AI ledger row settles exactly once from IN_FLIGHT and is never deletable", async () => {
    const s = await store();
    const db = s.raw();
    db.prepare(
      `INSERT INTO ai_calls (request_id, investigation_id, provider, attempt_index, state, started_at)
       VALUES ('AIC-0001','INV-001','deepseek',0,'IN_FLIGHT','2026-01-01T00:00:00Z')`
    ).run();

    db.prepare("UPDATE ai_calls SET state='COMPLETE' WHERE request_id='AIC-0001'").run();
    // A settled row cannot settle again, so a recorded spend cannot be edited away.
    expect(() =>
      db.prepare("UPDATE ai_calls SET state='FAILED' WHERE request_id='AIC-0001'").run()
    ).toThrowError(/STORE_APPEND_ONLY_VIOLATION/);
    expect(() => db.prepare("DELETE FROM ai_calls WHERE request_id='AIC-0001'").run()).toThrowError(
      /STORE_APPEND_ONLY_VIOLATION/
    );

    await s.close();
  });

  it("an artifact ref cannot have its hash, kind, or redaction stamp rewritten", async () => {
    const s = await store();
    const db = s.raw();
    db.prepare(
      `INSERT INTO artifact_refs (artifact_id, investigation_id, kind, filename, content_type,
         byte_length, sha256, stored_at, redaction_json)
       VALUES ('ART-1','INV-001','console-log','a.jsonl','application/x-ndjson',10,
         'sha256:aa','2026-01-01T00:00:00Z','{}')`
    ).run();

    for (const sql of [
      "UPDATE artifact_refs SET sha256='sha256:bb' WHERE artifact_id='ART-1'",
      "UPDATE artifact_refs SET byte_length=99 WHERE artifact_id='ART-1'",
      "UPDATE artifact_refs SET kind='trace' WHERE artifact_id='ART-1'",
      "UPDATE artifact_refs SET redaction_json='{\"x\":1}' WHERE artifact_id='ART-1'",
    ]) {
      expect(() => db.prepare(sql).run(), sql).toThrowError(/STORE_APPEND_ONLY_VIOLATION/);
    }
    expect(() =>
      db.prepare("DELETE FROM artifact_refs WHERE artifact_id='ART-1'").run()
    ).toThrowError(/STORE_APPEND_ONLY_VIOLATION/);

    // The one permitted mutation: a retention tombstone.
    db.prepare(
      "UPDATE artifact_refs SET tombstoned=1, tombstoned_at='2026-02-01T00:00:00Z', tombstone_reason='expired' WHERE artifact_id='ART-1'"
    ).run();

    await s.close();
  });

  it("migration is idempotent and reports its version", async () => {
    const s = new SqliteMetadataStore({ path: dbPath });
    await s.migrate();
    const v1 = await s.schemaVersion();
    await s.migrate();
    expect(await s.schemaVersion()).toBe(v1);
    expect(v1).toBeGreaterThanOrEqual(1);
    await s.close();
  });

  it("a nested transaction is refused, keeping transactions short and flat", async () => {
    const s = new SqliteMetadataStore({ path: dbPath });
    await s.migrate();
    await expect(
      s.tx(async () => {
        await s.tx(async () => undefined);
      })
    ).rejects.toThrowError(/Nested/);
    await s.close();
  });
});

describe("claim safety under contention (M1-AT-4)", () => {
  it("concurrent claimants never receive the same job", async () => {
    const s = new SqliteMetadataStore({ path: dbPath });
    await s.migrate();
    await s.tx((t) =>
      t.insertInvestigation({
        investigationId: "INV-001",
        title: "t",
        targetName: null,
        createdAt: systemClock.nowIso(),
        status: "open",
      })
    );

    const q = new SqliteWorkQueue({ store: s, clock: systemClock });
    const total = 12;
    for (let i = 0; i < total; i++) {
      await q.enqueue({
        jobId: `JOB-contend${String(i).padStart(4, "0")}`,
        investigationId: "INV-001",
        experimentId: "EXP-001",
        repetitionIndex: i,
        attemptIndex: 0,
        seq: i + 1,
        approvalId: null,
        effectiveProposalChecksum: null,
        payloadJson: "{}",
      });
    }

    // Interleave claims from several workers against the same store.
    const claims = await Promise.all(
      Array.from({ length: total + 4 }, (_, i) => q.claim(`worker-${i % 4}`, 60_000))
    );
    const got = claims.filter((c) => c !== null).map((c) => c!.jobId);

    expect(got).toHaveLength(total);
    expect(new Set(got).size, "a job was claimed twice").toBe(total);

    // Claims are handed out in seq order.
    const seqs = claims.filter((c) => c !== null).map((c) => c!.seq);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);

    await s.close();
  });

  it("claim returns null rather than throwing when there is no work", async () => {
    const s = new SqliteMetadataStore({ path: dbPath });
    await s.migrate();
    const q = new SqliteWorkQueue({ store: s, clock: systemClock });
    expect(await q.claim("w", 1000)).toBeNull();
    await s.close();
  });

  it("markRunning refuses a job this worker does not hold", async () => {
    const s = new SqliteMetadataStore({ path: dbPath });
    await s.migrate();
    await s.tx((t) =>
      t.insertInvestigation({
        investigationId: "INV-001",
        title: "t",
        targetName: null,
        createdAt: systemClock.nowIso(),
        status: "open",
      })
    );
    const q = new SqliteWorkQueue({ store: s, clock: systemClock });
    await q.enqueue({
      jobId: "JOB-abcdefgh1234",
      investigationId: "INV-001",
      experimentId: "EXP-001",
      repetitionIndex: 0,
      attemptIndex: 0,
      seq: 1,
      approvalId: null,
      effectiveProposalChecksum: null,
      payloadJson: "{}",
    });
    await q.claim("worker-a", 60_000);

    try {
      await q.markRunning("JOB-abcdefgh1234", "worker-b", "RUN-001");
      throw new Error("expected a refusal");
    } catch (e) {
      expect(isInvestigatorError(e)).toBe(true);
    }
    await s.close();
  });
});

/**
 * Job identity: what the jobs table actually guarantees.
 *
 * The M1 gate hit a duplicate-job failure here and the table carries TWO uniqueness
 * constraints -- the (investigation, experiment, repetition, attempt) tuple and job_id -- which
 * produce the same SQLite error class for very different causes. These pin both, and pin that
 * the reported message tells them apart, because conflating them cost real misdiagnosis time.
 */
describe("job identity constraints", () => {
  async function seeded(): Promise<SqliteMetadataStore> {
    const s = new SqliteMetadataStore({ path: dbPath });
    await s.migrate();
    await s.tx((t) =>
      t.insertInvestigation({
        investigationId: "INV-001",
        title: "t",
        targetName: null,
        createdAt: systemClock.nowIso(),
        status: "open",
      })
    );
    return s;
  }

  const job = (over: Record<string, unknown> = {}) => ({
    jobId: "JOB-aaaaaaaaaaaa",
    investigationId: "INV-001",
    experimentId: "EXP-001",
    repetitionIndex: 0,
    attemptIndex: 0,
    seq: 1,
    approvalId: null,
    effectiveProposalChecksum: null,
    payloadJson: "{}",
    ...over,
  });

  it("rejects a second job for the same (investigation, experiment, repetition, attempt)", async () => {
    const s = await seeded();
    const q = new SqliteWorkQueue({ store: s, clock: systemClock });
    await q.enqueue(job());

    // Same work, a different id. The tuple constraint is what keeps duplicate work from being
    // scheduled twice and breaking the one-manifest-per-run bijection.
    let err: unknown;
    try {
      await q.enqueue(job({ jobId: "JOB-bbbbbbbbbbbb", seq: 2 }));
    } catch (e) {
      err = e;
    }
    expect(isInvestigatorError(err), "duplicate work tuple was accepted").toBe(true);
    await s.close();
  });

  it("distinguishes a colliding id from duplicate work in the message it reports", async () => {
    const s = await seeded();
    const q = new SqliteWorkQueue({ store: s, clock: systemClock });
    await q.enqueue(job());

    // Genuinely new work, but the id generator handed back an id already in use.
    let err: unknown;
    try {
      await q.enqueue(job({ repetitionIndex: 1, seq: 2 }));
    } catch (e) {
      err = e;
    }
    expect(isInvestigatorError(err)).toBe(true);
    const message = (err as Error).message;
    expect(message, `blamed the work tuple for an id collision: ${message}`).toMatch(
      /already exists/
    );
    expect(message).toContain("JOB-aaaaaaaaaaaa");
    await s.close();
  });

  it("accepts a retry as a new attempt of the same repetition", async () => {
    const s = await seeded();
    const q = new SqliteWorkQueue({ store: s, clock: systemClock });
    await q.enqueue(job());

    // ADR-0005: a retry is a NEW row with an incremented attempt index. The unique index must
    // permit that, or the bounded-retry path would be dead on arrival.
    await q.enqueue(
      job({
        jobId: "JOB-cccccccccccc",
        attemptIndex: 1,
        seq: 2,
        previousAttemptJobId: "JOB-aaaaaaaaaaaa",
      })
    );

    const jobs = await q.listJobs("INV-001");
    expect(jobs).toHaveLength(2);
    expect(jobs.map((j) => j.attemptIndex).sort()).toEqual([0, 1]);
    await s.close();
  });
});
