/**
 * Numbered migrations. No framework: ten tables, and the invariants live in CHECK constraints and
 * triggers that a migration framework would abstract away (ADR-0002).
 *
 * Two things in here are load-bearing rather than incidental:
 *
 *  1. The `jobs` CHECK constraints encode the legal (terminal_reason, run_outcome) matrix from
 *     ADR-0005. An illegal pair cannot be written even by buggy application code.
 *  2. The BEFORE UPDATE / BEFORE DELETE triggers on lineage, approvals, ai_calls, and
 *     run_manifests make append-only a property of the database, not of caller discipline.
 */

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: "initial",
    sql: `
CREATE TABLE schema_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE investigations (
  investigation_id TEXT PRIMARY KEY,
  title            TEXT NOT NULL,
  target_name      TEXT NULL,
  created_at       TEXT NOT NULL,
  status           TEXT NOT NULL CHECK (status IN ('open','closed'))
);

-- Per-investigation monotonic counters. Application-assigned ids everywhere, so no adapter ever
-- needs last_insert_rowid() and the PostgreSQL swap stays mechanical.
CREATE TABLE sequences (
  investigation_id TEXT NOT NULL,
  counter          TEXT NOT NULL,
  value            INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (investigation_id, counter)
);

CREATE TABLE jobs (
  job_id                  TEXT PRIMARY KEY,
  investigation_id        TEXT NOT NULL REFERENCES investigations(investigation_id),
  experiment_id           TEXT NOT NULL,
  repetition_index        INTEGER NOT NULL,
  attempt_index           INTEGER NOT NULL,
  previous_attempt_job_id TEXT NULL REFERENCES jobs(job_id),
  seq                     INTEGER NOT NULL,
  approval_id             TEXT NULL,
  effective_proposal_checksum TEXT NULL,
  payload_json            TEXT NOT NULL,
  state                   TEXT NOT NULL CHECK (state IN ('PENDING','CLAIMED','RUNNING','TERMINAL')),
  terminal_reason         TEXT NULL CHECK (terminal_reason IN ('COMPLETED','INTERRUPTED','WORKER_ERROR')),
  run_outcome             TEXT NULL CHECK (run_outcome IN
                            ('VALID_COMPLETED','PRODUCT_FAILED','AUTOMATION_FAILED',
                             'INFRASTRUCTURE_FAILED','INTERRUPTED','INCONCLUSIVE')),
  worker_id               TEXT NULL,
  lease_expires_at        INTEGER NULL,
  enqueued_at             TEXT NOT NULL,
  claimed_at              TEXT NULL,
  started_at              TEXT NULL,
  finished_at             TEXT NULL,
  run_id                  TEXT NULL,

  -- TERMINAL and a terminal reason imply each other.
  CHECK ((state = 'TERMINAL') = (terminal_reason IS NOT NULL)),
  -- A terminal job always records what the run observed.
  CHECK ((terminal_reason IS NULL) OR (run_outcome IS NOT NULL)),
  -- ADR-0005 matrix. An interruption observes only INTERRUPTED.
  CHECK (terminal_reason IS NOT 'INTERRUPTED' OR run_outcome = 'INTERRUPTED'),
  -- A completed worker execution observed one of four things. PRODUCT_FAILED here is a success.
  CHECK (terminal_reason IS NOT 'COMPLETED' OR run_outcome IN
         ('VALID_COMPLETED','PRODUCT_FAILED','AUTOMATION_FAILED','INCONCLUSIVE')),
  -- A worker error cannot yield a product observation.
  CHECK (terminal_reason IS NOT 'WORKER_ERROR' OR run_outcome IN
         ('INFRASTRUCTURE_FAILED','AUTOMATION_FAILED','INCONCLUSIVE')),

  UNIQUE (investigation_id, experiment_id, repetition_index, attempt_index)
);

CREATE INDEX jobs_claimable ON jobs (seq) WHERE state = 'PENDING';
CREATE INDEX jobs_lease     ON jobs (lease_expires_at) WHERE state IN ('CLAIMED','RUNNING');
CREATE INDEX jobs_by_inv    ON jobs (investigation_id, seq);

CREATE TABLE runs (
  run_id             TEXT PRIMARY KEY,
  job_id             TEXT NOT NULL REFERENCES jobs(job_id),
  investigation_id   TEXT NOT NULL REFERENCES investigations(investigation_id),
  experiment_id      TEXT NOT NULL,
  repetition_index   INTEGER NOT NULL,
  attempt_index      INTEGER NOT NULL,
  seq                INTEGER NOT NULL,
  seed               INTEGER NOT NULL,
  outcome            TEXT NULL,
  outcome_rule_id    INTEGER NULL CHECK (outcome_rule_id BETWEEN 1 AND 6),
  manifest_artifact_id TEXT NULL,
  manifest_seal_hash TEXT NULL,
  started_at         TEXT NULL,
  finished_at        TEXT NULL,
  duration_ms        INTEGER NULL,
  UNIQUE (job_id)
);

CREATE INDEX runs_by_inv ON runs (investigation_id, seq);

CREATE TABLE artifact_refs (
  artifact_id       TEXT PRIMARY KEY,
  investigation_id  TEXT NOT NULL REFERENCES investigations(investigation_id),
  run_id            TEXT NULL,
  kind              TEXT NOT NULL,
  filename          TEXT NOT NULL,
  content_type      TEXT NOT NULL,
  byte_length       INTEGER NOT NULL CHECK (byte_length >= 0),
  sha256            TEXT NOT NULL,
  stored_at         TEXT NOT NULL,
  -- Non-null by constraint, not by convention: no artifact exists without proof redaction ran.
  redaction_json    TEXT NOT NULL,
  tombstoned        INTEGER NOT NULL DEFAULT 0 CHECK (tombstoned IN (0,1)),
  tombstoned_at     TEXT NULL,
  tombstone_reason  TEXT NULL,
  CHECK ((tombstoned = 0) = (tombstoned_at IS NULL))
);

CREATE INDEX artifacts_by_inv ON artifact_refs (investigation_id, kind);
CREATE INDEX artifacts_by_run ON artifact_refs (run_id);
CREATE INDEX artifacts_by_hash ON artifact_refs (sha256);

CREATE TABLE lineage (
  lineage_id        TEXT PRIMARY KEY,
  investigation_id  TEXT NOT NULL REFERENCES investigations(investigation_id),
  seq               INTEGER NOT NULL,
  edge              TEXT NOT NULL,
  from_kind         TEXT NOT NULL,
  from_id           TEXT NOT NULL,
  to_kind           TEXT NOT NULL,
  to_id             TEXT NOT NULL,
  actor_kind        TEXT NOT NULL CHECK (actor_kind IN ('human','deterministic','ai')),
  actor_component   TEXT NULL,
  actor_version     TEXT NULL,
  actor_name        TEXT NULL,
  created_at        TEXT NOT NULL,
  inputs_json       TEXT NULL,
  approval_id       TEXT NULL,
  ai_call_id        TEXT NULL,
  flow_id           TEXT NULL,
  flow_version      TEXT NULL,
  flow_hash         TEXT NULL,
  record_hash       TEXT NOT NULL,
  prev_record_hash  TEXT NULL,
  -- An AI-produced edge must name the call and the exact prompt bytes; a human edge must name
  -- the approval; a deterministic edge must name the component and version (ADR-0012).
  CHECK (actor_kind IS NOT 'ai' OR (ai_call_id IS NOT NULL AND flow_id IS NOT NULL AND flow_hash IS NOT NULL)),
  CHECK (actor_kind IS NOT 'human' OR approval_id IS NOT NULL),
  CHECK (actor_kind IS NOT 'deterministic' OR (actor_component IS NOT NULL AND actor_version IS NOT NULL)),
  UNIQUE (investigation_id, seq)
);

CREATE INDEX lineage_from ON lineage (investigation_id, from_kind, from_id);
CREATE INDEX lineage_to   ON lineage (investigation_id, to_kind, to_id);

CREATE TABLE approvals (
  approval_id                  TEXT PRIMARY KEY,
  investigation_id             TEXT NOT NULL REFERENCES investigations(investigation_id),
  gate                         TEXT NOT NULL CHECK (gate IN
                                 ('experiment_selection','target_failure','final_reproduction')),
  approval_type                TEXT NOT NULL CHECK (approval_type IN
                                 ('gate_decision','direct_evidence_attestation')),
  proposal_checksum            TEXT NOT NULL,
  effective_proposal_checksum  TEXT NULL,
  decision                     TEXT NOT NULL CHECK (decision IN ('approve','reject','request_changes')),
  approver_name                TEXT NOT NULL,
  decided_at                   TEXT NOT NULL,
  recorded_at                  TEXT NOT NULL,
  payload_json                 TEXT NOT NULL
);

CREATE INDEX approvals_by_gate ON approvals (investigation_id, gate, recorded_at);

CREATE TABLE ai_calls (
  request_id            TEXT PRIMARY KEY,
  investigation_id      TEXT NOT NULL,
  flow_id               TEXT NULL,
  flow_version          TEXT NULL,
  flow_hash             TEXT NULL,
  prompt_version        TEXT NULL,
  alias                 TEXT NULL,
  provider              TEXT NOT NULL,
  model_id              TEXT NULL,
  model_version         TEXT NULL,
  inference_mode        TEXT NULL,
  params_json           TEXT NULL,
  prompt_tokens         INTEGER NULL,
  completion_tokens     INTEGER NULL,
  total_tokens          INTEGER NULL,
  estimated_usd         REAL NULL,
  latency_ms            INTEGER NULL,
  finish_reason         TEXT NULL,
  attempt_index         INTEGER NOT NULL,
  state                 TEXT NOT NULL CHECK (state IN ('IN_FLIGHT','COMPLETE','FAILED')),
  error_class           TEXT NULL,
  warnings_json         TEXT NULL,
  request_content_hash  TEXT NULL,
  response_content_hash TEXT NULL,
  started_at            TEXT NOT NULL,
  finished_at           TEXT NULL
);

CREATE INDEX ai_calls_by_inv ON ai_calls (investigation_id, started_at);

-- Capability probe cache, so a fresh process does not re-probe unnecessarily (ADR-0009).
CREATE TABLE capability_cache (
  cache_key    TEXT PRIMARY KEY,
  provider     TEXT NOT NULL,
  model_id     TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  observed_at  TEXT NOT NULL,
  expires_at   TEXT NOT NULL
);

-- ------------------------------------------------------------------
-- Append-only enforcement. The interface omits update/delete methods;
-- these triggers mean a raw SQL mistake cannot bypass that.
-- ------------------------------------------------------------------
CREATE TRIGGER lineage_no_update BEFORE UPDATE ON lineage
  BEGIN SELECT RAISE(ABORT, 'STORE_APPEND_ONLY_VIOLATION: lineage is append-only'); END;
CREATE TRIGGER lineage_no_delete BEFORE DELETE ON lineage
  BEGIN SELECT RAISE(ABORT, 'STORE_APPEND_ONLY_VIOLATION: lineage is append-only'); END;

CREATE TRIGGER approvals_no_update BEFORE UPDATE ON approvals
  BEGIN SELECT RAISE(ABORT, 'STORE_APPEND_ONLY_VIOLATION: approvals are append-only'); END;
CREATE TRIGGER approvals_no_delete BEFORE DELETE ON approvals
  BEGIN SELECT RAISE(ABORT, 'STORE_APPEND_ONLY_VIOLATION: approvals are append-only'); END;

-- The AI ledger allows exactly one transition: IN_FLIGHT -> COMPLETE/FAILED. Nothing else, so a
-- recorded spend can never be edited away.
CREATE TRIGGER ai_calls_no_delete BEFORE DELETE ON ai_calls
  BEGIN SELECT RAISE(ABORT, 'STORE_APPEND_ONLY_VIOLATION: ai_calls are append-only'); END;
CREATE TRIGGER ai_calls_only_settle BEFORE UPDATE ON ai_calls
  WHEN OLD.state IS NOT 'IN_FLIGHT' OR NEW.state = 'IN_FLIGHT'
  BEGIN SELECT RAISE(ABORT, 'STORE_APPEND_ONLY_VIOLATION: ai_calls settle once from IN_FLIGHT'); END;

-- A sealed run is immutable. Before sealing, the outcome columns may be filled in once.
CREATE TRIGGER runs_no_delete BEFORE DELETE ON runs
  BEGIN SELECT RAISE(ABORT, 'STORE_APPEND_ONLY_VIOLATION: runs are append-only'); END;
CREATE TRIGGER runs_seal_once BEFORE UPDATE ON runs
  WHEN OLD.manifest_seal_hash IS NOT NULL
  BEGIN SELECT RAISE(ABORT, 'MANIFEST_IMMUTABLE: run manifest is sealed'); END;

-- Artifacts are immutable; the single permitted mutation is the retention tombstone.
CREATE TRIGGER artifacts_no_delete BEFORE DELETE ON artifact_refs
  BEGIN SELECT RAISE(ABORT, 'STORE_APPEND_ONLY_VIOLATION: artifact refs are append-only; use tombstone'); END;
CREATE TRIGGER artifacts_tombstone_only BEFORE UPDATE ON artifact_refs
  WHEN OLD.sha256 IS NOT NEW.sha256
    OR OLD.byte_length IS NOT NEW.byte_length
    OR OLD.kind IS NOT NEW.kind
    OR OLD.redaction_json IS NOT NEW.redaction_json
    OR OLD.tombstoned = 1
  BEGIN SELECT RAISE(ABORT, 'STORE_APPEND_ONLY_VIOLATION: only a retention tombstone may modify an artifact ref'); END;
`,
  },
];

export const LATEST_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.version;
