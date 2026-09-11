# Queue and Run Outcome Model

Status: M0 frozen decision (frozen decisions 1, 2)

## Governing principle

Playwright produces evidence. Deterministic software normalizes and measures evidence. DeepSeek interprets and prioritizes evidence. Humans authorize consequential transitions.

## Types

```ts
type JobState = "PENDING" | "CLAIMED" | "RUNNING" | "TERMINAL";
type JobTerminalReason = "COMPLETED" | "INTERRUPTED" | "WORKER_ERROR";
type RunOutcome =
  | "VALID_COMPLETED"
  | "PRODUCT_FAILED"
  | "AUTOMATION_FAILED"
  | "INFRASTRUCTURE_FAILED"
  | "INTERRUPTED"
  | "INCONCLUSIVE";
```

## Rules

- Job lifecycle and run outcome are separate dimensions.
- `JobState=TERMINAL`, `JobTerminalReason=COMPLETED`, `RunOutcome=PRODUCT_FAILED` is a successful
  worker execution that captured a valid product failure. It counts toward product-failure
  frequency.
- A worker restart converts stale `CLAIMED` or `RUNNING` jobs to `TERMINAL`/`INTERRUPTED` with
  `RunOutcome=INTERRUPTED`. Stale jobs are never silently re-run.
- Retries are new job attempts linked to the prior attempt, not mutations of history.
- Test repetition and infrastructure retry are separate counters. A product failure is never
  hidden by retry.

## State machine

```
                 enqueue
                    |
                    v
                +--------+
                | PENDING|
                +---+----+
                    | claim(workerId, leaseMs)
                    v
                +--------+     start
                | CLAIMED| ---------------+
                +---+----+                |
                    |                     v
      lease expiry  |                +---------+
      (reapStale)   |                | RUNNING |
                    |                +----+----+
                    |                     | finish(reason, outcome)
                    |                     | or lease expiry (reapStale)
                    v                     v
                +--------------------------------+
                |            TERMINAL            |
                | reason: COMPLETED | INTERRUPTED|
                |         | WORKER_ERROR         |
                +--------------------------------+
```

`TERMINAL` is absorbing. There is no transition out of it. A "retry" is a **new row** with
`attemptIndex = prior.attemptIndex + 1` and `previousAttemptJobId = prior.jobId`.

## The two-dimensional matrix

| `JobTerminalReason` | Legal `RunOutcome` values | Counts toward product-failure frequency? |
| --- | --- | --- |
| `COMPLETED` | `VALID_COMPLETED`, `PRODUCT_FAILED`, `AUTOMATION_FAILED`, `INCONCLUSIVE` | Only `PRODUCT_FAILED` |
| `INTERRUPTED` | `INTERRUPTED` only | No |
| `WORKER_ERROR` | `INFRASTRUCTURE_FAILED`, `AUTOMATION_FAILED`, `INCONCLUSIVE` | No |

Any other combination is a programming error and is rejected by a `CHECK` constraint in SQLite and
by a schema assertion in `RunManifest` validation.

## RunOutcome decision rules (deterministic)

Evaluated in order; the first match wins. The rule that fired is recorded in the manifest as
`outcomeRuleId` so that classification is explainable and testable.

| Order | Rule | Outcome |
| --- | --- | --- |
| 1 | The worker was killed, the lease expired, or the process received a termination signal mid-run | `INTERRUPTED` |
| 2 | Browser launch failed, the artifact store rejected a write, disk was full, the DB was unavailable, or the target host was unreachable at the network layer before the first successful navigation | `INFRASTRUCTURE_FAILED` |
| 3 | A selector referenced by an approved action did not exist, an action precondition was unmet, a navigation left `safety.allowedOrigins`, or the automation script itself threw | `AUTOMATION_FAILED` |
| 4 | At least one declared product assertion failed, or a declared failure predicate matched (console error class, uncaught exception fingerprint, HTTP status class, missing expected DOM state) | `PRODUCT_FAILED` |
| 5 | All declared product assertions passed and required evidence categories are `complete` | `VALID_COMPLETED` |
| 6 | Anything else, including all assertions passing while a required evidence category is `missing` or `corrupted` | `INCONCLUSIVE` |

Rule 3 before rule 4 is deliberate: a broken script must never be reported as a product failure.
Rule 6 after rule 5 is deliberate: a green run with missing required evidence is not a proof of
correctness.

Distinguishing rules 2 and 3 is the hardest classification problem in the system. The tie-breaker
is the *boundary*: failures attributable to the harness, host, or environment are infrastructure;
failures attributable to the automation instructions interacting with the application are
automation. Ambiguous cases go to `INCONCLUSIVE`, never to `PRODUCT_FAILED`.

## Counters, kept separate

Each run manifest carries:

- `repetitionIndex` — which repetition of the approved sequence this is (test repetition).
- `attemptIndex` — which infrastructure retry attempt of *this* repetition this is.
- `previousAttemptJobId` — link to the prior attempt, if any.

Frequency statistics consume `repetitionIndex` and count, per repetition, the outcome of the
*last non-interrupted attempt*, plus an explicit count of repetitions with no valid attempt. A
repetition whose only outcomes are `INFRASTRUCTURE_FAILED` is reported as `no valid observation`,
not as a pass. This is what prevents retry from hiding a product failure, and it is asserted by
`tests/reliability/no_retry_hides_product_failure.spec.ts`.

Retry eligibility:

- `INFRASTRUCTURE_FAILED`: retryable, up to `execution.maxInfraRetriesPerRepetition` (default 2).
- `INTERRUPTED`: retryable, and the retry is a new attempt.
- `AUTOMATION_FAILED`: **not** retryable. It indicates the approved sequence is wrong; that is a
  human decision, surfaced at the next gate.
- `PRODUCT_FAILED`, `VALID_COMPLETED`: never retried. These are observations.
- `INCONCLUSIVE`: not auto-retried; surfaced with the reason.

## SQLite schema sketch

```sql
CREATE TABLE jobs (
  job_id                TEXT PRIMARY KEY,
  investigation_id      TEXT NOT NULL,
  experiment_id         TEXT NOT NULL,
  repetition_index      INTEGER NOT NULL,
  attempt_index         INTEGER NOT NULL,
  previous_attempt_job_id TEXT NULL REFERENCES jobs(job_id),
  seq                   INTEGER NOT NULL,          -- monotonic, app-assigned ordering
  state                 TEXT NOT NULL CHECK (state IN ('PENDING','CLAIMED','RUNNING','TERMINAL')),
  terminal_reason       TEXT NULL CHECK (terminal_reason IN ('COMPLETED','INTERRUPTED','WORKER_ERROR')),
  run_outcome           TEXT NULL,
  worker_id             TEXT NULL,
  lease_expires_at      INTEGER NULL,
  enqueued_at           INTEGER NOT NULL,
  claimed_at            INTEGER NULL,
  started_at            INTEGER NULL,
  finished_at           INTEGER NULL,
  run_id                TEXT NULL,
  CHECK ( (state = 'TERMINAL') = (terminal_reason IS NOT NULL) ),
  CHECK ( (terminal_reason IS NULL) OR (run_outcome IS NOT NULL) ),
  CHECK ( terminal_reason IS NOT 'INTERRUPTED' OR run_outcome = 'INTERRUPTED' ),
  CHECK ( terminal_reason IS NOT 'COMPLETED' OR run_outcome IN
          ('VALID_COMPLETED','PRODUCT_FAILED','AUTOMATION_FAILED','INCONCLUSIVE') ),
  CHECK ( terminal_reason IS NOT 'WORKER_ERROR' OR run_outcome IN
          ('INFRASTRUCTURE_FAILED','AUTOMATION_FAILED','INCONCLUSIVE') ),
  UNIQUE (investigation_id, experiment_id, repetition_index, attempt_index)
);

CREATE INDEX jobs_claimable ON jobs (state, seq) WHERE state = 'PENDING';
CREATE INDEX jobs_lease ON jobs (state, lease_expires_at) WHERE state IN ('CLAIMED','RUNNING');
```

## Claim semantics under SQLite

Frozen decision 2: WAL mode, single writer, configured busy timeout, short transactions.

Claim is a single short `IMMEDIATE` transaction:

```sql
BEGIN IMMEDIATE;
  SELECT job_id FROM jobs WHERE state='PENDING' ORDER BY seq LIMIT 1;
  UPDATE jobs SET state='CLAIMED', worker_id=?, claimed_at=?, lease_expires_at=?
   WHERE job_id=? AND state='PENDING';
COMMIT;
```

- `BEGIN IMMEDIATE` acquires the write lock up front, so two workers cannot both read the same
  `PENDING` row and then both attempt the update.
- The `AND state='PENDING'` guard makes the update idempotent and safe even if the lock model
  changes.
- `busy_timeout` (default 5000ms) handles contention. A claim that cannot acquire the lock returns
  `null` and the worker backs off; it does not throw.
- MVP runs a single writer (`execution.workers = 1`), so contention is limited to the reaper and
  the CLI. The design nevertheless assumes multiple claimants so that the PostgreSQL adapter
  (`SELECT ... FOR UPDATE SKIP LOCKED`) is a drop-in replacement.

Every transaction in the system is short: no transaction spans a browser action, a network call, or
a provider call. Artifact bytes are written to the filesystem *outside* the transaction; the
`ArtifactRef` row is inserted after the bytes are durable and hashed.

## Reaping

`reapStale(now)` runs:

1. at worker startup, before the first claim,
2. on a timer every `heartbeatMs * 2`,
3. at the start of any command that reads run statistics.

For each row in `CLAIMED` or `RUNNING` with `lease_expires_at < now`:

- set `state='TERMINAL'`, `terminal_reason='INTERRUPTED'`, `run_outcome='INTERRUPTED'`,
  `finished_at=now`,
- write a partial run manifest if one does not exist, sealed with
  `captureStatus` reflecting whatever was collected and `limitations` naming the interruption,
- append a lineage edge recording the reap,
- **do not** enqueue a replacement automatically. The operator or the orchestrating command
  decides, and that decision is recorded.

The last bullet is what "stale jobs are never silently re-run" means concretely.

## Heartbeat

A running worker calls `heartbeat` every `heartbeatMs`, extending `lease_expires_at` to
`now + leaseMs`. `heartbeatMs < leaseMs / 3` is enforced at config load so that a single missed
heartbeat cannot cause a spurious reap.

## Crash-consistency ordering

For any single run, the durable write order is:

1. `jobs` row -> `RUNNING`
2. run manifest **opened** (immutable header: IDs, resolved config, emulation, seed, versions)
3. artifact bytes written and hashed, `artifact_refs` rows inserted incrementally
4. redacted normalized evidence written
5. run manifest **sealed** (outcome, `outcomeRuleId`, `captureStatus`, artifact digest list, seal hash)
6. `jobs` row -> `TERMINAL`

A crash between any two steps leaves a state that the reaper can classify without guessing: an
unsealed manifest plus an expired lease is unambiguously `INTERRUPTED`.
