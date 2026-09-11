import type { DatabaseSync } from "node:sqlite";
import type { Clock, JobTerminalReason, JobState, RunOutcome } from "@investigator/core";
import { InvestigatorError, fail, isLegalTerminalOutcome, systemClock } from "@investigator/core";
import type {
  ClaimedJob,
  JobRow,
  NewJob,
  QueueStats,
  ReapResult,
  WorkQueue,
} from "./interfaces.js";
import type { SqliteMetadataStore } from "./sqlite-metadata-store.js";

/**
 * SQLite-backed durable job queue (ADR-0003, frozen decision 1).
 *
 * Three properties the statistics depend on:
 *  1. A claim cannot double-execute. `BEGIN IMMEDIATE` takes the write lock before the read, and
 *     the UPDATE carries a `state='PENDING'` guard so it is idempotent regardless.
 *  2. `TERMINAL` is absorbing. A retry is a NEW row with attempt_index + 1 and a link to its
 *     predecessor, never a mutation of history.
 *  3. Reaping never auto-requeues. A stale job becomes TERMINAL/INTERRUPTED and stops there; the
 *     decision to run it again belongs to a human or an orchestrating command, and is recorded.
 */

type Row = Record<string, unknown>;

function mapJob(row: Row): JobRow {
  return {
    jobId: String(row["job_id"]),
    investigationId: String(row["investigation_id"]),
    experimentId: String(row["experiment_id"]),
    repetitionIndex: Number(row["repetition_index"]),
    attemptIndex: Number(row["attempt_index"]),
    previousAttemptJobId: row["previous_attempt_job_id"] == null ? null : String(row["previous_attempt_job_id"]),
    seq: Number(row["seq"]),
    approvalId: row["approval_id"] == null ? null : String(row["approval_id"]),
    effectiveProposalChecksum:
      row["effective_proposal_checksum"] == null ? null : String(row["effective_proposal_checksum"]),
    payloadJson: String(row["payload_json"]),
    state: String(row["state"]) as JobState,
    terminalReason: row["terminal_reason"] == null ? null : (String(row["terminal_reason"]) as JobTerminalReason),
    runOutcome: row["run_outcome"] == null ? null : (String(row["run_outcome"]) as RunOutcome),
    workerId: row["worker_id"] == null ? null : String(row["worker_id"]),
    leaseExpiresAt: row["lease_expires_at"] == null ? null : Number(row["lease_expires_at"]),
    enqueuedAt: String(row["enqueued_at"]),
    claimedAt: row["claimed_at"] == null ? null : String(row["claimed_at"]),
    startedAt: row["started_at"] == null ? null : String(row["started_at"]),
    finishedAt: row["finished_at"] == null ? null : String(row["finished_at"]),
    runId: row["run_id"] == null ? null : String(row["run_id"]),
  };
}

export interface SqliteWorkQueueOptions {
  store: SqliteMetadataStore;
  clock?: Clock;
  /** Notified whenever a stale job is reaped, so the caller can seal a partial manifest. */
  onReap?: (job: JobRow) => void | Promise<void>;
}

export class SqliteWorkQueue implements WorkQueue {
  private readonly db: DatabaseSync;
  private readonly clock: Clock;
  private readonly onReap?: (job: JobRow) => void | Promise<void>;

  constructor(opts: SqliteWorkQueueOptions) {
    this.db = opts.store.raw();
    this.clock = opts.clock ?? systemClock;
    if (opts.onReap) this.onReap = opts.onReap;
  }

  async enqueue(job: NewJob): Promise<string> {
    try {
      this.db
        .prepare(
          `INSERT INTO jobs (job_id, investigation_id, experiment_id, repetition_index,
             attempt_index, previous_attempt_job_id, seq, approval_id,
             effective_proposal_checksum, payload_json, state, enqueued_at)
           VALUES (?,?,?,?,?,?,?,?,?,?, 'PENDING', ?)`
        )
        .run(
          job.jobId,
          job.investigationId,
          job.experimentId,
          job.repetitionIndex,
          job.attemptIndex,
          job.previousAttemptJobId ?? null,
          job.seq,
          job.approvalId,
          job.effectiveProposalChecksum,
          job.payloadJson,
          this.clock.nowIso()
        );
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (/UNIQUE constraint/.test(message)) {
        // Name the constraint that actually fired. `jobs` has exactly one uniqueness constraint
        // -- job_id -- so blaming the (experiment, repetition, attempt) tuple sent every reader
        // hunting a duplicate-work bug when the real cause was a colliding generated id.
        const onJobId = /job_id/.test(message);
        fail(
          "INPUT_INVALID",
          onJobId
            ? `Generated jobId ${job.jobId} already exists (investigation=${job.investigationId} experiment=${job.experimentId} repetition=${job.repetitionIndex} attempt=${job.attemptIndex}). The id generator collided; the work itself may be new.`
            : `Job insert violated ${message} (investigation=${job.investigationId} experiment=${job.experimentId} repetition=${job.repetitionIndex} attempt=${job.attemptIndex})`,
          {
            context: {
              jobId: job.jobId,
              constraint: message,
              investigationId: job.investigationId,
              experimentId: job.experimentId,
              repetitionIndex: job.repetitionIndex,
              attemptIndex: job.attemptIndex,
            },
            cause: e,
          }
        );
      }
      if (/SQLITE_BUSY|database is locked/i.test(message)) {
        fail("STORE_BUSY", message, { context: { jobId: job.jobId }, cause: e });
      }
      throw new InvestigatorError("INTERNAL", message, { context: { jobId: job.jobId }, cause: e });
    }
    return job.jobId;
  }

  /**
   * Claim the lowest-seq PENDING job. Returns null when there is nothing to claim, including
   * when the write lock is contended: a busy database means "no work available right now", not
   * an error, so the worker backs off instead of crashing a batch.
   */
  async claim(workerId: string, leaseMs: number): Promise<ClaimedJob | null> {
    const nowIso = this.clock.nowIso();
    const leaseExpiresAt = this.clock.nowMs() + leaseMs;

    try {
      this.db.exec("BEGIN IMMEDIATE");
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (/SQLITE_BUSY|database is locked/i.test(message)) return null;
      throw new InvestigatorError("INTERNAL", message, { cause: e });
    }

    try {
      const candidate = this.db
        .prepare("SELECT * FROM jobs WHERE state = 'PENDING' ORDER BY seq LIMIT 1")
        .get() as Row | undefined;
      if (!candidate) {
        this.db.exec("COMMIT");
        return null;
      }
      const jobId = String(candidate["job_id"]);
      const res = this.db
        .prepare(
          `UPDATE jobs SET state = 'CLAIMED', worker_id = ?, claimed_at = ?, lease_expires_at = ?
           WHERE job_id = ? AND state = 'PENDING'`
        )
        .run(workerId, nowIso, leaseExpiresAt, jobId);
      if (res.changes === 0) {
        // Someone else took it between the read and the write. With BEGIN IMMEDIATE this should
        // be unreachable; the guard is what makes it safe if the locking model ever changes.
        this.db.exec("COMMIT");
        return null;
      }
      this.db.exec("COMMIT");

      const job = mapJob(candidate);
      return {
        ...job,
        state: "CLAIMED",
        workerId,
        leaseExpiresAt,
        claimedAt: nowIso,
        previousAttemptJobId: job.previousAttemptJobId ?? null,
      };
    } catch (e) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        /* nothing to roll back */
      }
      const message = e instanceof Error ? e.message : String(e);
      if (/SQLITE_BUSY|database is locked/i.test(message)) return null;
      throw new InvestigatorError("INTERNAL", message, { context: { workerId }, cause: e });
    }
  }

  async markRunning(jobId: string, workerId: string, runId: string): Promise<void> {
    const res = this.db
      .prepare(
        `UPDATE jobs SET state = 'RUNNING', started_at = ?, run_id = ?
         WHERE job_id = ? AND worker_id = ? AND state = 'CLAIMED'`
      )
      .run(this.clock.nowIso(), runId, jobId, workerId);
    if (res.changes === 0) {
      fail("INTERNAL", "Cannot mark running: job is not CLAIMED by this worker", {
        context: { jobId, workerId },
      });
    }
  }

  async heartbeat(jobId: string, workerId: string, leaseMs: number): Promise<void> {
    const res = this.db
      .prepare(
        `UPDATE jobs SET lease_expires_at = ?
         WHERE job_id = ? AND worker_id = ? AND state IN ('CLAIMED','RUNNING')`
      )
      .run(this.clock.nowMs() + leaseMs, jobId, workerId);
    if (res.changes === 0) {
      // The job was reaped out from under us. The worker should stop rather than keep writing.
      fail("EXEC_INTERRUPTED", "Lease lost: job is no longer held by this worker", {
        context: { jobId, workerId },
      });
    }
  }

  async finish(
    jobId: string,
    terminal: { reason: JobTerminalReason; runOutcome: RunOutcome }
  ): Promise<void> {
    // Check in code as well as in the CHECK constraint, so the error names the domain rule
    // rather than surfacing as a constraint-violation string.
    if (!isLegalTerminalOutcome(terminal.reason, terminal.runOutcome)) {
      fail("INTERNAL", "Illegal (terminalReason, runOutcome) combination", {
        context: { jobId, reason: terminal.reason, outcome: terminal.runOutcome },
      });
    }
    try {
      const res = this.db
        .prepare(
          `UPDATE jobs SET state = 'TERMINAL', terminal_reason = ?, run_outcome = ?,
             finished_at = ?, lease_expires_at = NULL
           WHERE job_id = ? AND state IN ('CLAIMED','RUNNING')`
        )
        .run(terminal.reason, terminal.runOutcome, this.clock.nowIso(), jobId);
      if (res.changes === 0) {
        const row = this.db.prepare("SELECT state FROM jobs WHERE job_id = ?").get(jobId) as Row | undefined;
        if (!row) fail("INTERNAL", "Cannot finish an unknown job", { context: { jobId } });
        fail("INTERNAL", "Job is already TERMINAL. TERMINAL is absorbing.", {
          context: { jobId, state: String(row["state"]) },
        });
      }
    } catch (e) {
      if (e instanceof InvestigatorError) throw e;
      const message = e instanceof Error ? e.message : String(e);
      throw new InvestigatorError("INTERNAL", message, { context: { jobId }, cause: e });
    }
  }

  /**
   * Convert expired CLAIMED/RUNNING leases into TERMINAL/INTERRUPTED/INTERRUPTED.
   * Deliberately does not enqueue a replacement (ADR-0003).
   */
  async reapStale(nowMs: number): Promise<ReapResult> {
    const stale = this.db
      .prepare(
        `SELECT * FROM jobs WHERE state IN ('CLAIMED','RUNNING')
           AND lease_expires_at IS NOT NULL AND lease_expires_at < ?
         ORDER BY seq`
      )
      .all(nowMs) as Row[];

    const reaped: ReapResult["reaped"] = [];
    for (const row of stale) {
      const job = mapJob(row);
      const res = this.db
        .prepare(
          `UPDATE jobs SET state = 'TERMINAL', terminal_reason = 'INTERRUPTED',
             run_outcome = 'INTERRUPTED', finished_at = ?, lease_expires_at = NULL
           WHERE job_id = ? AND state IN ('CLAIMED','RUNNING')`
        )
        .run(this.clock.nowIso(), job.jobId);
      if (res.changes === 0) continue;
      reaped.push({ jobId: job.jobId, previousState: job.state, runId: job.runId });
      if (this.onReap) await this.onReap(job);
    }
    return { reaped };
  }

  async getJob(jobId: string): Promise<JobRow | null> {
    const row = this.db.prepare("SELECT * FROM jobs WHERE job_id = ?").get(jobId) as Row | undefined;
    return row ? mapJob(row) : null;
  }

  async listJobs(investigationId: string): Promise<JobRow[]> {
    const rows = this.db
      .prepare("SELECT * FROM jobs WHERE investigation_id = ? ORDER BY seq")
      .all(investigationId) as Row[];
    return rows.map(mapJob);
  }

  async stats(investigationId: string): Promise<QueueStats> {
    const rows = this.db
      .prepare(
        `SELECT state, terminal_reason, run_outcome, COUNT(*) AS c
         FROM jobs WHERE investigation_id = ?
         GROUP BY state, terminal_reason, run_outcome`
      )
      .all(investigationId) as Row[];

    const out: QueueStats = {
      pending: 0,
      claimed: 0,
      running: 0,
      terminal: 0,
      byOutcome: {},
      byTerminalReason: {},
    };
    for (const r of rows) {
      const count = Number(r["c"]);
      switch (String(r["state"])) {
        case "PENDING":
          out.pending += count;
          break;
        case "CLAIMED":
          out.claimed += count;
          break;
        case "RUNNING":
          out.running += count;
          break;
        case "TERMINAL":
          out.terminal += count;
          break;
      }
      const outcome = r["run_outcome"] == null ? null : (String(r["run_outcome"]) as RunOutcome);
      if (outcome) out.byOutcome[outcome] = (out.byOutcome[outcome] ?? 0) + count;
      const reason = r["terminal_reason"] == null ? null : (String(r["terminal_reason"]) as JobTerminalReason);
      if (reason) out.byTerminalReason[reason] = (out.byTerminalReason[reason] ?? 0) + count;
    }
    return out;
  }

  /**
   * Frequency counting rule, frozen: per repetition, take the LAST non-interrupted attempt.
   * A repetition whose every attempt was interrupted or infrastructure-failed counts as
   * `noValidObservation`, never as a pass. This is the rule that stops retry from hiding a
   * product failure, and `no_retry_hides_product_failure.spec.ts` asserts it.
   */
  async repetitionOutcomes(
    investigationId: string,
    experimentId?: string
  ): Promise<{
    perRepetition: Map<number, { outcome: RunOutcome | null; jobId: string | null; attemptIndex: number }>;
    noValidObservation: number[];
  }> {
    const rows = (
      experimentId
        ? this.db
            .prepare(
              `SELECT * FROM jobs WHERE investigation_id = ? AND experiment_id = ? AND state = 'TERMINAL'
               ORDER BY repetition_index, attempt_index`
            )
            .all(investigationId, experimentId)
        : this.db
            .prepare(
              `SELECT * FROM jobs WHERE investigation_id = ? AND state = 'TERMINAL'
               ORDER BY repetition_index, attempt_index`
            )
            .all(investigationId)
    ) as Row[];

    const perRepetition = new Map<
      number,
      { outcome: RunOutcome | null; jobId: string | null; attemptIndex: number }
    >();
    const seen = new Set<number>();

    for (const row of rows) {
      const job = mapJob(row);
      seen.add(job.repetitionIndex);
      // An interrupted attempt carries no observation, so it never overwrites a real one.
      if (job.runOutcome === "INTERRUPTED") continue;
      const current = perRepetition.get(job.repetitionIndex);
      if (!current || job.attemptIndex >= current.attemptIndex) {
        perRepetition.set(job.repetitionIndex, {
          outcome: job.runOutcome,
          jobId: job.jobId,
          attemptIndex: job.attemptIndex,
        });
      }
    }

    // A repetition is a valid observation only if its surviving attempt actually observed the
    // product. Infrastructure failure is not an observation about the product.
    const noValidObservation: number[] = [];
    for (const rep of [...seen].sort((a, b) => a - b)) {
      const entry = perRepetition.get(rep);
      if (!entry || entry.outcome === null || entry.outcome === "INFRASTRUCTURE_FAILED") {
        noValidObservation.push(rep);
        perRepetition.delete(rep);
      }
    }
    return { perRepetition, noValidObservation };
  }
}
