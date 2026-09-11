import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { InvestigatorError, fail } from "@investigator/core";
import { LATEST_SCHEMA_VERSION, MIGRATIONS } from "./migrations.js";
import type {
  AiCallRecord,
  ApprovalRecordRow,
  ArtifactRefRecord,
  InvestigationRecord,
  LineageRecordRow,
  MetadataReadTx,
  MetadataStore,
  MetadataTx,
  RunRecord,
} from "./interfaces.js";
import type { ArtifactKind, RedactionStamp, RunOutcome } from "@investigator/core";

/**
 * SQLite MetadataStore (ADR-0002, ADR-0021).
 *
 * WAL, single writer, configured busy timeout, and short transactions. No transaction in this
 * file spans a browser action, an artifact write, or a network call: artifact bytes are written
 * and hashed outside the transaction, and only the ref row is inserted inside one.
 *
 * `node:sqlite` is synchronous. The interface is async so it stays portable to PostgreSQL, so
 * these methods wrap synchronous calls in resolved promises. Every query is indexed and bounded
 * and no transaction does I/O, which is what keeps that honest (ADR-0021).
 */

type Row = Record<string, unknown>;

function str(row: Row, key: string): string {
  const v = row[key];
  if (typeof v !== "string") throw new InvestigatorError("INTERNAL", `Column ${key} is not a string`);
  return v;
}
function strOrNull(row: Row, key: string): string | null {
  const v = row[key];
  return v === null || v === undefined ? null : String(v);
}
function num(row: Row, key: string): number {
  const v = row[key];
  if (typeof v !== "number" && typeof v !== "bigint") {
    throw new InvestigatorError("INTERNAL", `Column ${key} is not a number`);
  }
  return Number(v);
}
function numOrNull(row: Row, key: string): number | null {
  const v = row[key];
  return v === null || v === undefined ? null : Number(v);
}

/** Map SQLite errors onto the typed taxonomy. Table-driven so wording changes stay contained. */
function mapSqliteError(e: unknown, context: Record<string, string | number | null> = {}): never {
  const message = e instanceof Error ? e.message : String(e);
  if (message.includes("STORE_APPEND_ONLY_VIOLATION")) {
    throw new InvestigatorError("STORE_APPEND_ONLY_VIOLATION", message, { context, cause: e });
  }
  if (message.includes("MANIFEST_IMMUTABLE")) {
    throw new InvestigatorError("MANIFEST_IMMUTABLE", message, { context, cause: e });
  }
  if (/SQLITE_BUSY|database is locked/i.test(message)) {
    throw new InvestigatorError("STORE_BUSY", message, { context, cause: e });
  }
  if (/disk (is )?full|SQLITE_FULL/i.test(message)) {
    throw new InvestigatorError("STORE_DISK_FULL", message, { context, cause: e });
  }
  if (/CHECK constraint failed|constraint failed|UNIQUE constraint/i.test(message)) {
    throw new InvestigatorError("INPUT_INVALID", message, { context, cause: e });
  }
  throw new InvestigatorError("INTERNAL", message, { context, cause: e });
}

export interface SqliteMetadataStoreOptions {
  path: string;
  busyTimeoutMs?: number;
  synchronous?: "FULL" | "NORMAL";
  readOnly?: boolean;
}

class Tx implements MetadataTx {
  constructor(private readonly db: DatabaseSync) {}

  // ---- reads -------------------------------------------------------------

  async getInvestigation(investigationId: string): Promise<InvestigationRecord | null> {
    const row = this.db
      .prepare("SELECT * FROM investigations WHERE investigation_id = ?")
      .get(investigationId) as Row | undefined;
    return row ? this.mapInvestigation(row) : null;
  }

  async listInvestigations(): Promise<InvestigationRecord[]> {
    const rows = this.db
      .prepare("SELECT * FROM investigations ORDER BY investigation_id")
      .all() as Row[];
    return rows.map((r) => this.mapInvestigation(r));
  }

  private mapInvestigation(row: Row): InvestigationRecord {
    return {
      investigationId: str(row, "investigation_id"),
      title: str(row, "title"),
      targetName: strOrNull(row, "target_name"),
      createdAt: str(row, "created_at"),
      status: str(row, "status") as "open" | "closed",
    };
  }

  async getRun(runId: string): Promise<RunRecord | null> {
    const row = this.db.prepare("SELECT * FROM runs WHERE run_id = ?").get(runId) as Row | undefined;
    return row ? this.mapRun(row) : null;
  }

  async listRuns(investigationId: string): Promise<RunRecord[]> {
    const rows = this.db
      .prepare("SELECT * FROM runs WHERE investigation_id = ? ORDER BY seq")
      .all(investigationId) as Row[];
    return rows.map((r) => this.mapRun(r));
  }

  private mapRun(row: Row): RunRecord {
    return {
      runId: str(row, "run_id"),
      jobId: str(row, "job_id"),
      investigationId: str(row, "investigation_id"),
      experimentId: str(row, "experiment_id"),
      repetitionIndex: num(row, "repetition_index"),
      attemptIndex: num(row, "attempt_index"),
      seq: num(row, "seq"),
      seed: num(row, "seed"),
      outcome: strOrNull(row, "outcome") as RunOutcome | null,
      outcomeRuleId: numOrNull(row, "outcome_rule_id"),
      manifestArtifactId: strOrNull(row, "manifest_artifact_id"),
      manifestSealHash: strOrNull(row, "manifest_seal_hash"),
      startedAt: strOrNull(row, "started_at"),
      finishedAt: strOrNull(row, "finished_at"),
      durationMs: numOrNull(row, "duration_ms"),
    };
  }

  async getArtifactRef(artifactId: string): Promise<ArtifactRefRecord | null> {
    const row = this.db
      .prepare("SELECT * FROM artifact_refs WHERE artifact_id = ?")
      .get(artifactId) as Row | undefined;
    return row ? this.mapArtifact(row) : null;
  }

  async listArtifactRefs(investigationId: string, kind?: ArtifactKind): Promise<ArtifactRefRecord[]> {
    const rows = (
      kind
        ? this.db
            .prepare(
              "SELECT * FROM artifact_refs WHERE investigation_id = ? AND kind = ? ORDER BY stored_at, artifact_id"
            )
            .all(investigationId, kind)
        : this.db
            .prepare(
              "SELECT * FROM artifact_refs WHERE investigation_id = ? ORDER BY stored_at, artifact_id"
            )
            .all(investigationId)
    ) as Row[];
    return rows.map((r) => this.mapArtifact(r));
  }

  private mapArtifact(row: Row): ArtifactRefRecord {
    const rec: ArtifactRefRecord = {
      artifactId: str(row, "artifact_id"),
      investigationId: str(row, "investigation_id"),
      kind: str(row, "kind") as ArtifactKind,
      filename: str(row, "filename"),
      contentType: str(row, "content_type"),
      byteLength: num(row, "byte_length"),
      sha256: str(row, "sha256"),
      storedAt: str(row, "stored_at"),
      redactionApplied: JSON.parse(str(row, "redaction_json")) as RedactionStamp,
      tombstoned: num(row, "tombstoned") === 1,
    };
    const runId = strOrNull(row, "run_id");
    if (runId) rec.runId = runId;
    const ts = strOrNull(row, "tombstoned_at");
    if (ts) rec.tombstonedAt = ts;
    const tr = strOrNull(row, "tombstone_reason");
    if (tr) rec.tombstoneReason = tr;
    return rec;
  }

  async listLineage(investigationId: string): Promise<LineageRecordRow[]> {
    const rows = this.db
      .prepare("SELECT * FROM lineage WHERE investigation_id = ? ORDER BY seq")
      .all(investigationId) as Row[];
    return rows.map((r) => this.mapLineage(r));
  }

  async lastLineage(investigationId: string): Promise<LineageRecordRow | null> {
    const row = this.db
      .prepare("SELECT * FROM lineage WHERE investigation_id = ? ORDER BY seq DESC LIMIT 1")
      .get(investigationId) as Row | undefined;
    return row ? this.mapLineage(row) : null;
  }

  private mapLineage(row: Row): LineageRecordRow {
    return {
      lineageId: str(row, "lineage_id"),
      investigationId: str(row, "investigation_id"),
      seq: num(row, "seq"),
      edge: str(row, "edge"),
      fromKind: str(row, "from_kind"),
      fromId: str(row, "from_id"),
      toKind: str(row, "to_kind"),
      toId: str(row, "to_id"),
      actorKind: str(row, "actor_kind"),
      actorComponent: strOrNull(row, "actor_component"),
      actorVersion: strOrNull(row, "actor_version"),
      actorName: strOrNull(row, "actor_name"),
      createdAt: str(row, "created_at"),
      inputsJson: strOrNull(row, "inputs_json"),
      approvalId: strOrNull(row, "approval_id"),
      aiCallId: strOrNull(row, "ai_call_id"),
      flowId: strOrNull(row, "flow_id"),
      flowVersion: strOrNull(row, "flow_version"),
      flowHash: strOrNull(row, "flow_hash"),
      recordHash: str(row, "record_hash"),
      prevRecordHash: strOrNull(row, "prev_record_hash"),
    };
  }

  /** Increment and return. Called inside the enclosing write transaction, so it is atomic. */
  async nextSequence(investigationId: string, counter: string): Promise<number> {
    this.db
      .prepare(
        `INSERT INTO sequences (investigation_id, counter, value) VALUES (?, ?, 1)
         ON CONFLICT (investigation_id, counter) DO UPDATE SET value = value + 1`
      )
      .run(investigationId, counter);
    const row = this.db
      .prepare("SELECT value FROM sequences WHERE investigation_id = ? AND counter = ?")
      .get(investigationId, counter) as Row;
    return num(row, "value");
  }

  async peekSequence(investigationId: string, counter: string): Promise<number> {
    const row = this.db
      .prepare("SELECT value FROM sequences WHERE investigation_id = ? AND counter = ?")
      .get(investigationId, counter) as Row | undefined;
    return row ? num(row, "value") : 0;
  }

  // ---- writes ------------------------------------------------------------

  async insertInvestigation(rec: InvestigationRecord): Promise<void> {
    try {
      this.db
        .prepare(
          `INSERT INTO investigations (investigation_id, title, target_name, created_at, status)
           VALUES (?, ?, ?, ?, ?)`
        )
        .run(rec.investigationId, rec.title, rec.targetName, rec.createdAt, rec.status);
    } catch (e) {
      mapSqliteError(e, { investigationId: rec.investigationId });
    }
  }

  async insertRun(rec: RunRecord): Promise<void> {
    try {
      this.db
        .prepare(
          `INSERT INTO runs (run_id, job_id, investigation_id, experiment_id, repetition_index,
             attempt_index, seq, seed, outcome, outcome_rule_id, manifest_artifact_id,
             manifest_seal_hash, started_at, finished_at, duration_ms)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
        )
        .run(
          rec.runId,
          rec.jobId,
          rec.investigationId,
          rec.experimentId,
          rec.repetitionIndex,
          rec.attemptIndex,
          rec.seq,
          rec.seed,
          rec.outcome,
          rec.outcomeRuleId,
          rec.manifestArtifactId,
          rec.manifestSealHash,
          rec.startedAt,
          rec.finishedAt,
          rec.durationMs
        );
    } catch (e) {
      mapSqliteError(e, { runId: rec.runId });
    }
  }

  async updateRunOnSeal(
    runId: string,
    fields: Pick<
      RunRecord,
      "outcome" | "outcomeRuleId" | "manifestArtifactId" | "manifestSealHash" | "finishedAt" | "durationMs"
    >
  ): Promise<void> {
    try {
      const res = this.db
        .prepare(
          `UPDATE runs SET outcome = ?, outcome_rule_id = ?, manifest_artifact_id = ?,
             manifest_seal_hash = ?, finished_at = ?, duration_ms = ?
           WHERE run_id = ? AND manifest_seal_hash IS NULL`
        )
        .run(
          fields.outcome,
          fields.outcomeRuleId,
          fields.manifestArtifactId,
          fields.manifestSealHash,
          fields.finishedAt,
          fields.durationMs,
          runId
        );
      if (res.changes === 0) {
        // Either the run does not exist or it is already sealed. Distinguish, because the second
        // case is an immutability violation and must not be reported as a missing row.
        const row = this.db
          .prepare("SELECT manifest_seal_hash FROM runs WHERE run_id = ?")
          .get(runId) as Row | undefined;
        if (!row) fail("INTERNAL", "Cannot seal an unknown run", { context: { runId } });
        fail("MANIFEST_IMMUTABLE", "Run manifest is already sealed", { context: { runId } });
      }
    } catch (e) {
      mapSqliteError(e, { runId });
    }
  }

  async insertArtifactRef(rec: ArtifactRefRecord): Promise<void> {
    // Fail closed: no artifact row without proof that redaction ran (ADR-0008).
    assertRedactionStamp(rec.redactionApplied, rec.artifactId);
    try {
      this.db
        .prepare(
          `INSERT INTO artifact_refs (artifact_id, investigation_id, run_id, kind, filename,
             content_type, byte_length, sha256, stored_at, redaction_json, tombstoned)
           VALUES (?,?,?,?,?,?,?,?,?,?,0)`
        )
        .run(
          rec.artifactId,
          rec.investigationId,
          rec.runId ?? null,
          rec.kind,
          rec.filename,
          rec.contentType,
          rec.byteLength,
          rec.sha256,
          rec.storedAt,
          JSON.stringify(rec.redactionApplied)
        );
    } catch (e) {
      mapSqliteError(e, { artifactId: rec.artifactId });
    }
  }

  async insertLineageEdge(rec: LineageRecordRow): Promise<void> {
    try {
      this.db
        .prepare(
          `INSERT INTO lineage (lineage_id, investigation_id, seq, edge, from_kind, from_id,
             to_kind, to_id, actor_kind, actor_component, actor_version, actor_name, created_at,
             inputs_json, approval_id, ai_call_id, flow_id, flow_version, flow_hash,
             record_hash, prev_record_hash)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
        )
        .run(
          rec.lineageId,
          rec.investigationId,
          rec.seq,
          rec.edge,
          rec.fromKind,
          rec.fromId,
          rec.toKind,
          rec.toId,
          rec.actorKind,
          rec.actorComponent,
          rec.actorVersion,
          rec.actorName,
          rec.createdAt,
          rec.inputsJson,
          rec.approvalId,
          rec.aiCallId,
          rec.flowId,
          rec.flowVersion,
          rec.flowHash,
          rec.recordHash,
          rec.prevRecordHash
        );
    } catch (e) {
      mapSqliteError(e, { lineageId: rec.lineageId });
    }
  }

  async insertApproval(rec: ApprovalRecordRow): Promise<void> {
    try {
      this.db
        .prepare(
          `INSERT INTO approvals (approval_id, investigation_id, gate, approval_type,
             proposal_checksum, effective_proposal_checksum, decision, approver_name,
             decided_at, recorded_at, payload_json)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)`
        )
        .run(
          rec.approvalId,
          rec.investigationId,
          rec.gate,
          rec.approvalType,
          rec.proposalChecksum,
          rec.effectiveProposalChecksum,
          rec.decision,
          rec.approverName,
          rec.decidedAt,
          rec.recordedAt,
          rec.payloadJson
        );
    } catch (e) {
      mapSqliteError(e, { approvalId: rec.approvalId });
    }
  }

  async insertAiCall(rec: AiCallRecord): Promise<void> {
    try {
      this.db
        .prepare(
          `INSERT INTO ai_calls (request_id, investigation_id, flow_id, flow_version, flow_hash,
             prompt_version, alias, provider, model_id, model_version, inference_mode, params_json,
             prompt_tokens, completion_tokens, total_tokens, estimated_usd, latency_ms,
             finish_reason, attempt_index, state, error_class, warnings_json,
             request_content_hash, response_content_hash, started_at, finished_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
        )
        .run(
          rec.requestId,
          rec.investigationId,
          rec.flowId,
          rec.flowVersion,
          rec.flowHash,
          rec.promptVersion,
          rec.alias,
          rec.provider,
          rec.modelId,
          rec.modelVersion,
          rec.inferenceMode,
          rec.paramsJson,
          rec.promptTokens,
          rec.completionTokens,
          rec.totalTokens,
          rec.estimatedUsd,
          rec.latencyMs,
          rec.finishReason,
          rec.attemptIndex,
          rec.state,
          rec.errorClass,
          rec.warningsJson,
          rec.requestContentHash,
          rec.responseContentHash,
          rec.startedAt,
          rec.finishedAt
        );
    } catch (e) {
      mapSqliteError(e, { requestId: rec.requestId });
    }
  }

  async completeAiCall(requestId: string, fields: Partial<AiCallRecord>): Promise<void> {
    try {
      this.db
        .prepare(
          `UPDATE ai_calls SET state = ?, model_id = COALESCE(?, model_id),
             model_version = COALESCE(?, model_version), inference_mode = COALESCE(?, inference_mode),
             prompt_tokens = ?, completion_tokens = ?, total_tokens = ?, estimated_usd = ?,
             latency_ms = ?, finish_reason = ?, error_class = ?, warnings_json = ?,
             response_content_hash = ?, finished_at = ?
           WHERE request_id = ?`
        )
        .run(
          fields.state ?? "COMPLETE",
          fields.modelId ?? null,
          fields.modelVersion ?? null,
          fields.inferenceMode ?? null,
          fields.promptTokens ?? null,
          fields.completionTokens ?? null,
          fields.totalTokens ?? null,
          fields.estimatedUsd ?? null,
          fields.latencyMs ?? null,
          fields.finishReason ?? null,
          fields.errorClass ?? null,
          fields.warningsJson ?? null,
          fields.responseContentHash ?? null,
          fields.finishedAt ?? null,
          requestId
        );
    } catch (e) {
      mapSqliteError(e, { requestId });
    }
  }
}

export function assertRedactionStamp(stamp: RedactionStamp | undefined, what: string): void {
  if (
    !stamp ||
    typeof stamp.policyId !== "string" ||
    typeof stamp.policyVersion !== "string" ||
    typeof stamp.policyHash !== "string" ||
    (stamp.mode !== "strict" && stamp.mode !== "permissive") ||
    !Array.isArray(stamp.appliedRules)
  ) {
    fail("REDACTION_NOT_APPLIED", "Refusing to persist without a valid RedactionStamp", {
      context: { subject: what },
    });
  }
}

export class SqliteMetadataStore implements MetadataStore {
  private readonly db: DatabaseSync;
  private inTx = false;

  constructor(opts: SqliteMetadataStoreOptions) {
    if (opts.path !== ":memory:") mkdirSync(dirname(opts.path), { recursive: true });
    try {
      this.db = new DatabaseSync(opts.path);
    } catch (e) {
      mapSqliteError(e, { path: opts.path });
    }
    // WAL first: concurrent readers while one writer works (ADR-0002).
    this.db.exec("PRAGMA journal_mode=WAL");
    this.db.exec(`PRAGMA busy_timeout=${Math.max(0, opts.busyTimeoutMs ?? 5000)}`);
    this.db.exec(`PRAGMA synchronous=${opts.synchronous ?? "FULL"}`);
    this.db.exec("PRAGMA foreign_keys=ON");
  }

  async migrate(): Promise<void> {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.exec(
        "CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)"
      );
      const row = this.db.prepare("SELECT MAX(version) AS v FROM schema_version").get() as Row;
      const current = numOrNull(row, "v") ?? 0;
      if (current > LATEST_SCHEMA_VERSION) {
        fail("WORKSPACE_VERSION_MISMATCH", "Workspace schema is newer than this binary", {
          context: { workspaceVersion: current, binaryVersion: LATEST_SCHEMA_VERSION },
        });
      }
      for (const m of MIGRATIONS) {
        if (m.version <= current) continue;
        this.db.exec(m.sql);
        this.db
          .prepare("INSERT INTO schema_version (version, applied_at) VALUES (?, ?)")
          // Migration timestamps are metadata about the install, not evidence, so a plain
          // ISO string here does not cross the ADR-0007 determinism boundary.
          .run(m.version, new Date().toISOString());
      }
      this.db.exec("COMMIT");
    } catch (e) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        /* already rolled back */
      }
      mapSqliteError(e, { op: "migrate" });
    }
  }

  async schemaVersion(): Promise<number> {
    const row = this.db.prepare("SELECT MAX(version) AS v FROM schema_version").get() as Row;
    return numOrNull(row, "v") ?? 0;
  }

  /**
   * Short write transaction. `BEGIN IMMEDIATE` takes the write lock up front so two claimants
   * cannot both read then both write (ADR-0003).
   */
  async tx<T>(fn: (t: MetadataTx) => Promise<T>): Promise<T> {
    if (this.inTx) {
      fail("INTERNAL", "Nested MetadataStore transaction. Transactions must stay short and flat.");
    }
    try {
      this.db.exec("BEGIN IMMEDIATE");
    } catch (e) {
      mapSqliteError(e, { op: "begin" });
    }
    this.inTx = true;
    try {
      const result = await fn(new Tx(this.db));
      this.db.exec("COMMIT");
      return result;
    } catch (e) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        /* nothing to roll back */
      }
      if (e instanceof InvestigatorError) throw e;
      return mapSqliteError(e, { op: "tx" });
    } finally {
      this.inTx = false;
    }
  }

  async read<T>(fn: (t: MetadataReadTx) => Promise<T>): Promise<T> {
    // WAL lets readers proceed without a transaction and without blocking the writer.
    return fn(new Tx(this.db));
  }

  /** Escape hatch for the queue adapter, which needs raw statements in one short transaction. */
  raw(): DatabaseSync {
    return this.db;
  }

  async close(): Promise<void> {
    this.db.close();
  }
}
