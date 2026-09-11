import type {
  ArtifactKind,
  ArtifactRef,
  JobTerminalReason,
  JobState,
  RedactionStamp,
  RunOutcome,
} from "@investigator/core";
import type { Secret } from "@investigator/core";

/**
 * The four storage seams. These interfaces are the entire portability story (ADR-0001), so they
 * must not leak SQLite or filesystem specifics:
 *
 *  - IDs are supplied by the application, never returned by the store. No `last_insert_rowid()`.
 *  - Ordering is by an explicit application-assigned `seq`, never implicit rowid order.
 *  - Artifacts are addressed by opaque `ArtifactRef`, never by filesystem path.
 *  - Claim semantics are expressible by both `BEGIN IMMEDIATE` (SQLite) and
 *    `SELECT ... FOR UPDATE SKIP LOCKED` (PostgreSQL).
 *  - No method assumes a single process or synchronous execution.
 */

// ---------------------------------------------------------------------------
// MetadataStore
// ---------------------------------------------------------------------------

export interface InvestigationRecord {
  investigationId: string;
  title: string;
  targetName: string | null;
  createdAt: string;
  status: "open" | "closed";
}

export interface RunRecord {
  runId: string;
  jobId: string;
  investigationId: string;
  experimentId: string;
  repetitionIndex: number;
  attemptIndex: number;
  seq: number;
  seed: number;
  outcome: RunOutcome | null;
  outcomeRuleId: number | null;
  manifestArtifactId: string | null;
  manifestSealHash: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
}

export interface ArtifactRefRecord extends ArtifactRef {
  investigationId: string;
}

export interface LineageRecordRow {
  lineageId: string;
  investigationId: string;
  seq: number;
  edge: string;
  fromKind: string;
  fromId: string;
  toKind: string;
  toId: string;
  actorKind: string;
  actorComponent: string | null;
  actorVersion: string | null;
  actorName: string | null;
  createdAt: string;
  inputsJson: string | null;
  approvalId: string | null;
  aiCallId: string | null;
  flowId: string | null;
  flowVersion: string | null;
  flowHash: string | null;
  recordHash: string;
  prevRecordHash: string | null;
}

export interface ApprovalRecordRow {
  approvalId: string;
  investigationId: string;
  gate: string;
  approvalType: string;
  proposalChecksum: string;
  effectiveProposalChecksum: string | null;
  decision: string;
  approverName: string;
  decidedAt: string;
  recordedAt: string;
  payloadJson: string;
}

export interface AiCallRecord {
  requestId: string;
  investigationId: string;
  flowId: string | null;
  flowVersion: string | null;
  flowHash: string | null;
  promptVersion: string | null;
  alias: string | null;
  provider: string;
  modelId: string | null;
  modelVersion: string | null;
  inferenceMode: string | null;
  paramsJson: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  estimatedUsd: number | null;
  latencyMs: number | null;
  finishReason: string | null;
  attemptIndex: number;
  state: "IN_FLIGHT" | "COMPLETE" | "FAILED";
  errorClass: string | null;
  warningsJson: string | null;
  requestContentHash: string | null;
  responseContentHash: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface MetadataReadTx {
  getInvestigation(investigationId: string): Promise<InvestigationRecord | null>;
  listInvestigations(): Promise<InvestigationRecord[]>;
  getRun(runId: string): Promise<RunRecord | null>;
  listRuns(investigationId: string): Promise<RunRecord[]>;
  getArtifactRef(artifactId: string): Promise<ArtifactRefRecord | null>;
  listArtifactRefs(investigationId: string, kind?: ArtifactKind): Promise<ArtifactRefRecord[]>;
  listLineage(investigationId: string): Promise<LineageRecordRow[]>;
  lastLineage(investigationId: string): Promise<LineageRecordRow | null>;
  /** Every approval for an investigation, oldest first. Gate state is derived from these. */
  listApprovals(investigationId: string): Promise<ApprovalRecordRow[]>;
  getApproval(approvalId: string): Promise<ApprovalRecordRow | null>;
  nextSequence(investigationId: string, counter: string): Promise<number>;
  peekSequence(investigationId: string, counter: string): Promise<number>;
}

export interface MetadataTx extends MetadataReadTx {
  insertInvestigation(rec: InvestigationRecord): Promise<void>;
  insertRun(rec: RunRecord): Promise<void>;
  updateRunOnSeal(
    runId: string,
    fields: Pick<
      RunRecord,
      | "outcome"
      | "outcomeRuleId"
      | "manifestArtifactId"
      | "manifestSealHash"
      | "finishedAt"
      | "durationMs"
    >
  ): Promise<void>;
  insertArtifactRef(rec: ArtifactRefRecord): Promise<void>;
  insertLineageEdge(rec: LineageRecordRow): Promise<void>;
  insertApproval(rec: ApprovalRecordRow): Promise<void>;
  insertAiCall(rec: AiCallRecord): Promise<void>;
  completeAiCall(requestId: string, fields: Partial<AiCallRecord>): Promise<void>;
  // Deliberately absent: any update or delete for lineage, approvals, ai_calls, and sealed
  // manifests. Absence in the interface plus SQLite triggers is what makes append-only real.
}

export interface MetadataStore {
  migrate(): Promise<void>;
  schemaVersion(): Promise<number>;
  /** Short write transaction. Never spans a browser action, a file write, or a network call. */
  tx<T>(fn: (t: MetadataTx) => Promise<T>): Promise<T>;
  read<T>(fn: (t: MetadataReadTx) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// ArtifactStore
// ---------------------------------------------------------------------------

export interface PutArtifactRequest {
  investigationId: string;
  runId?: string;
  kind: ArtifactKind;
  filename: string;
  bytes: Uint8Array | string;
  contentType: string;
  /**
   * Required, not optional. There is no overload without it, and a call that somehow arrives
   * without one raises REDACTION_NOT_APPLIED (ADR-0008). This is "fail closed" as a type.
   */
  redactionApplied: RedactionStamp;
  /** Explicit id, for artifacts a report will cite by a readable name such as TRACE-17. */
  artifactId?: string;
}

export interface ArtifactFilter {
  kind?: ArtifactKind;
  runId?: string;
  includeTombstoned?: boolean;
}

export interface ArtifactStore {
  /** Hashes the bytes itself. A caller-supplied hash is ignored. */
  put(req: PutArtifactRequest): Promise<ArtifactRef>;
  get(ref: ArtifactRef | string): Promise<Uint8Array>;
  getText(ref: ArtifactRef | string): Promise<string>;
  head(ref: ArtifactRef | string): Promise<ArtifactRef>;
  verify(ref: ArtifactRef | string): Promise<{ ok: boolean; observedSha256: string }>;
  list(investigationId: string, filter?: ArtifactFilter): Promise<ArtifactRef[]>;
  /** Retention only. Writes a tombstone so expiry stays distinguishable from fabrication. */
  tombstone(ref: ArtifactRef | string, reason: string): Promise<ArtifactRef>;
  // Deliberately absent: update. Artifacts are immutable (ADR-0004).
}

// ---------------------------------------------------------------------------
// WorkQueue
// ---------------------------------------------------------------------------

export interface NewJob {
  jobId: string;
  investigationId: string;
  experimentId: string;
  repetitionIndex: number;
  attemptIndex: number;
  previousAttemptJobId?: string | null;
  seq: number;
  approvalId: string | null;
  effectiveProposalChecksum: string | null;
  payloadJson: string;
}

export interface ClaimedJob extends NewJob {
  state: JobState;
  workerId: string;
  leaseExpiresAt: number;
  enqueuedAt: string;
  claimedAt: string;
}

export interface JobRow extends NewJob {
  state: JobState;
  terminalReason: JobTerminalReason | null;
  runOutcome: RunOutcome | null;
  workerId: string | null;
  leaseExpiresAt: number | null;
  enqueuedAt: string;
  claimedAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  runId: string | null;
}

export interface ReapResult {
  reaped: Array<{ jobId: string; previousState: JobState; runId: string | null }>;
}

export interface QueueStats {
  pending: number;
  claimed: number;
  running: number;
  terminal: number;
  byOutcome: Partial<Record<RunOutcome, number>>;
  byTerminalReason: Partial<Record<JobTerminalReason, number>>;
}

export interface WorkQueue {
  enqueue(job: NewJob): Promise<string>;
  /** Returns null when there is no claimable work, including when the write lock is contended. */
  claim(workerId: string, leaseMs: number): Promise<ClaimedJob | null>;
  markRunning(jobId: string, workerId: string, runId: string): Promise<void>;
  heartbeat(jobId: string, workerId: string, leaseMs: number): Promise<void>;
  finish(
    jobId: string,
    terminal: { reason: JobTerminalReason; runOutcome: RunOutcome }
  ): Promise<void>;
  /** Stale CLAIMED/RUNNING become TERMINAL/INTERRUPTED. Never auto-requeued (ADR-0003). */
  reapStale(nowMs: number): Promise<ReapResult>;
  getJob(jobId: string): Promise<JobRow | null>;
  listJobs(investigationId: string): Promise<JobRow[]>;
  stats(investigationId: string): Promise<QueueStats>;
}

// ---------------------------------------------------------------------------
// SecretStore
// ---------------------------------------------------------------------------

export interface SecretStore {
  has(name: string): Promise<boolean>;
  /** The only method that yields a value, and it yields a Secret, not a string. */
  reveal(name: string): Promise<Secret>;
}
