# M1 Reliability Gate — Executable Test Specifications

Status: M0 frozen candidate
Location: `/tests/reliability/`
Precondition for: M2

## Governing principle

Playwright produces evidence. Deterministic software normalizes and measures evidence. DeepSeek interprets and prioritizes evidence. Humans authorize consequential transitions.

## Fixture apps

All in `/packages/test-fixtures`. Plain Node HTTP servers, standard library only, bound to
`127.0.0.1:0`, started and stopped by the harness, no public network access.

| ID | Name | Mechanism |
| --- | --- | --- |
| F1 | `passing-app` | Renders a list, a button, and on click renders three `[data-testid=result-card]` items. Deterministic |
| F2 | `product-failing-deterministic` | Same UI; on click logs `console.error("applyFilters: results undefined")` and renders zero cards |
| F3 | `product-failing-intermittent-seeded` | Same UI; two async fetches (`/api/initial`, `/api/filter`) whose server-side response delays are a pure function of a per-run seed passed as a query parameter. When the initial response lands after the filter response, the page overwrites the filtered list with an empty one and logs the same console error. Exposes `/__meta/expected?seed=N` returning whether that seed fails and the intended rate |
| F4 | `automation-failing` | Renders a page where the approved selector (`role=button[name="Verified"]`) never exists |
| F5 | `infrastructure-failing` | Accepts the TCP connection then destroys the socket before any HTTP response, on a designated port, so failure occurs before the first successful navigation |

Fixture experiments live in `packages/test-fixtures/experiments/*.json` as `ExperimentProposal`-
shaped files consumed via the M1-only `--fixture-experiment` flag.

## Performance fixture

F1 served locally; 4 actions (`goto`, `click`, `waitFor`, `assert`); `video: on`, `trace: on`,
DOM snapshots on action boundaries, response bodies off. Budget: 100 sequential runs in < 600s
wall clock on the CI runner class, p95 per-run < 8s, hard per-run ceiling 20s, disk growth
< 1.5 GB.

## The ten tests

---

### 1. `same_test_100_runs.spec.ts`

**Fixture**: performance fixture (F1).

**Procedure**: fresh temp workspace; `init`; enqueue 100 repetitions of the 4-action sequence;
one worker, `maxParallelRuns: 1`; run to completion; read all manifests.

**Pass criteria** (all must hold):

1. `jobs` contains exactly 100 rows, all `TERMINAL`/`COMPLETED`.
2. All 100 have `RunOutcome = VALID_COMPLETED`.
3. Exactly 100 sealed manifests exist, all schema-valid.
4. For every run, `captureStatus.categories[c].status === "complete"` for
   `actions`, `navigation`, `console`, `exceptions`, `networkMetadata`, `domSnapshots`,
   `screenshots`, `video`, `trace`.
5. Total wall clock < 600_000 ms.
6. p95 per-run duration < 8_000 ms; max < 20_000 ms.
7. Workspace disk growth < 1.5 GB.
8. Zero `INFRASTRUCTURE_FAILED`, zero `AUTOMATION_FAILED`, zero `INCONCLUSIVE`, zero retries.

**Why it matters**: establishes that the harness is stable and affordable at the scale the product
requires. Budget renegotiation, if ever needed, is recorded in `docs/FREEZE-M0.md`.

---

### 2. `one_manifest_per_run.spec.ts`

**Fixture**: F1 (20 runs) and F2 (20 runs).

**Procedure**: run both; enumerate manifests and `jobs` rows; attempt a second write to a sealed
manifest; attempt to mutate a manifest row via the store.

**Pass criteria**:

1. Manifest count equals run count equals `jobs` row count, with a bijection on `runId`.
2. Every manifest validates against `schemas/run-manifest.v1.json`.
3. Every manifest is sealed, and its seal hash recomputes correctly over its recorded contents.
4. Every manifest contains: `investigationId`, `experimentId`, `jobId`, `runId`,
   `repetitionIndex`, `attemptIndex`, resolved emulation (read back from the browser), seed,
   `collectorVersion`, `normalizerVersion`, `playwrightVersion`, observed `browserVersion`,
   effective config source map, `outcomeRuleId`, `captureStatus`, and the artifact digest list.
5. A second write to a sealed manifest raises `MANIFEST_IMMUTABLE`.
6. An attempted `UPDATE` on the manifest table raises `STORE_APPEND_ONLY_VIOLATION`.
7. No orphan manifests (manifest without a job) and no missing manifests (job without a manifest).

---

### 3. `monotonic_timestamps.spec.ts`

**Fixture**: F1, 10 runs, all categories enabled.

**Procedure**: read the raw event log and the normalized event stream for each run.

**Pass criteria**, per run:

1. `seq` values are a gap-free ascending integer sequence starting at 1.
2. `tMonoMs` is non-decreasing in `seq` order across **all** categories in one merged stream.
3. `tDeltaMs` (delta from run start) is non-decreasing in `seq` order and non-negative.
4. `tWallMs` is non-decreasing in `seq` order. (Guaranteed because it comes from the injected
   `Clock`, which is monotonic in tests.)
5. For every action, `actionEnd.seq > actionStart.seq` and `actionEnd.tMonoMs >=
   actionStart.tMonoMs`.
6. The normalized stream preserves the raw `seq` ordering exactly.

---

### 4. `network_action_correlation.spec.ts`

**Fixture**: purpose-built F6 (`straddling-requests-app`) that issues: a request starting and
finishing inside action 2; a request starting in action 2 and finishing in action 4; a request
starting before the first action; and a request starting after the last action.

**Procedure**: run 10 repetitions; read the session timeline.

**Pass criteria**:

1. Every network event is attributed to exactly one action window.
2. Attribution is by **start** `seq`: the straddling request belongs to action 2.
3. The straddling request carries `finishedInActionId` naming action 4.
4. The pre-first-action request is attributed to the synthetic `pre-first-action` window; the
   post-last request to `post-last-action`.
5. Zero unattributed network events.
6. Attribution is identical across all 10 repetitions.
7. The same attribution results from rebuilding the timeline offline from persisted artifacts.

---

### 5. `no_retry_hides_product_failure.spec.ts`

**Fixture**: F3 (seeded intermittent) plus an injected infrastructure-fault wrapper that fails the
first attempt of specific repetitions at the transport layer.

**Procedure**: 30 repetitions with `maxInfraRetriesPerRepetition: 2`. Seeds chosen so that
repetitions 3, 11, 19, 27 are product-failing per `/__meta/expected`. The fault injector fails
attempt 1 of repetitions 3, 5, 19, 22 with an infrastructure error. Repetitions 5 and 22 are
seed-passing; 3 and 19 are seed-failing.

**Pass criteria**:

1. Repetitions 3 and 19 are counted as product failures. Their attempt-1 infrastructure failure
   did not remove their attempt-2 `PRODUCT_FAILED` observation.
2. Repetitions 5 and 22 are counted as passes, from their attempt-2 `VALID_COMPLETED`.
3. The product-failure count equals exactly 4 (repetitions 3, 11, 19, 27).
4. `attemptIndex` and `repetitionIndex` are recorded separately, and `previousAttemptJobId` links
   each retry to its predecessor.
5. No repetition is reported as passing on the strength of a retry that replaced a
   `PRODUCT_FAILED` observation. Constructed as an additional sub-case: force a repetition whose
   attempt 1 is `PRODUCT_FAILED`, then artificially trigger a retry; the counting rule must still
   report that repetition as failed, and `AUTOMATION_FAILED`/`PRODUCT_FAILED` must be shown as
   non-retryable by the eligibility table.
6. Zero mutations of prior attempt rows; retries are new rows.

---

### 6. `artifact_integrity_hashes.spec.ts`

**Fixture**: F1, 5 runs.

**Procedure**: verify every artifact; then corrupt one byte of one artifact on disk and re-verify;
then tamper with one field of a sealed manifest and re-verify.

**Pass criteria**:

1. Every `ArtifactRef.sha256` matches a fresh recomputation over the stored bytes.
2. Every `ArtifactRef.byteLength` matches the file size.
3. Every artifact referenced by a manifest exists and every artifact on disk is referenced.
4. The corrupted byte is detected as `ARTIFACT_HASH_MISMATCH` (exit 9), naming the artifact.
5. The tampered manifest field is detected as `MANIFEST_SEAL_INVALID` (exit 9).
6. `ArtifactStore.put` computes the hash itself; a caller-supplied hash is ignored or rejected
   (asserted by type and by test).

---

### 7. `redaction_before_persistence.spec.ts`

**Fixture**: F7 (`sensitive-app`) which emits, on the exercised path:

- a `Set-Cookie` with a session value
- an outbound request carrying `Authorization: Bearer <jwt-shaped token>`
- a navigation URL containing `?access_token=<high-entropy>&q=laptop`
- a JSON response body containing an email, an Indian phone number, a Luhn-valid card number, and
  a PAN-shaped string
- a `console.log` containing the same JWT
- `localStorage` keys `authToken` and `cartCount`

**Procedure**: run 5 repetitions with the default policy in `strict` mode. Then enumerate: every
file under `artifacts/`, every row in every DB table, every line of captured log output, and every
normalized index entry. Then attempt a store call without a `RedactionStamp`.

**Pass criteria**:

1. None of the seeded secret or PII values appears, in any encoding checked (raw, URL-encoded,
   base64, base64url), in any persisted artifact, DB row, log line, or index entry.
2. `cartCount` **is** present (proving redaction is targeted, not blanket destruction).
3. Cookie names, header names, and `localStorage` key names are retained; values are masked or
   hashed per policy.
4. The URL retains origin, path, and `q=laptop`; `access_token` is masked with the key retained.
5. Every persisted artifact and every persisted normalized record carries a `RedactionStamp` with
   `policyId`, `policyVersion`, `policyHash`, `mode`, and non-empty `appliedRules`.
6. A store call without a `RedactionStamp` raises `REDACTION_NOT_APPLIED` (exit 9).
7. `captureStatus.categories.storage.status === "redacted"` with a `POLICY_REDACTED` reason.
8. Running the same fixture twice produces byte-identical redacted output.
9. `DEEPSEEK_API_KEY` set in the environment appears nowhere in any output of the run.

---

### 8. `interrupted_worker_typed_outcome.spec.ts`

**Fixture**: F1 with a slow action (a fixture endpoint that delays 5s), so the kill lands mid-run.

**Procedure**: start a run; kill the worker process mid-action (`SIGKILL` on POSIX,
`TerminateProcess` semantics on Windows); wait past `leaseMs`; run the reaper; inspect state.

**Pass criteria**:

1. The job is `TERMINAL` / `INTERRUPTED` / `RunOutcome = INTERRUPTED`.
2. A partial manifest exists and is sealed, with `captureStatus` reflecting what was collected and
   `limitations` naming the interruption (`RUN_INTERRUPTED` reasons on affected categories).
3. No replacement job was enqueued automatically. The queue contains no new `PENDING` row for that
   repetition.
4. A lineage-adjacent record of the reap exists with `actor.kind = "deterministic"`.
5. Partially written artifacts are either absent or present-and-hash-consistent; no artifact ref
   exists whose bytes are incomplete.
6. The temp profile directory for that run is removed by the startup orphan sweep.
7. The same assertions hold on both Windows and Linux.
8. A subsequent normal run in the same workspace succeeds (no poisoned state, no stuck lock).

---

### 9. `fixture_app_classification.spec.ts`

**Fixtures**: F1–F5, 10 runs each (F3 with seeds covering both failing and passing cases).

**Pass criteria**:

1. F1 -> `VALID_COMPLETED` on all runs, `outcomeRuleId = 5`.
2. F2 -> `PRODUCT_FAILED` on all runs, `outcomeRuleId = 4`.
3. F3 -> `PRODUCT_FAILED` on exactly the seeds `/__meta/expected` predicts, `VALID_COMPLETED` on
   the rest. Exact set match, not a rate check.
4. F4 -> `AUTOMATION_FAILED` on all runs, `outcomeRuleId = 3`.
5. F5 -> `INFRASTRUCTURE_FAILED` on all runs, `outcomeRuleId = 2`.
6. The confusion matrix over expected-vs-actual outcome is the identity matrix.
7. For every run, the extractor independently recomputes `RunOutcome` from persisted evidence and
   agrees with the executor, including `outcomeRuleId`.
8. An additional case asserts rule ordering: a fixture that both fails an assertion **and** has a
   missing selector is classified `AUTOMATION_FAILED`, not `PRODUCT_FAILED`.
9. An additional case asserts rule 6: a fixture where all assertions pass but a required category
   is forced `missing` is classified `INCONCLUSIVE`, not `VALID_COMPLETED`.

---

### 10. `offline_session_reconstruction.spec.ts`

**Fixture**: F1 (5 runs) and F2 (5 runs).

**Procedure**: run normally; snapshot the normalized output, timeline, and evidence index; delete
all derived data; then, with `fetch`/`http`/`https` stubbed to throw and no browser binary
reachable, rebuild from persisted artifacts alone; compare.

**Pass criteria**:

1. Rebuild succeeds with zero network calls and zero browser launches (asserted by the stubs
   throwing if touched).
2. Rebuilt normalized records are **byte-identical** to the originals.
3. Rebuilt session timeline is identical, including network-to-action attribution.
4. Rebuilt evidence index is identical.
5. Rebuilt `captureStatus` is identical.
6. Rebuilt `RunOutcome` and `outcomeRuleId` are identical.
7. The rebuild is byte-identical on Linux and Windows for the same artifacts.
8. A rebuild with a changed `normalizerVersion` produces output stamped with the new version and
   does not silently reuse cached derived data.

---

## Anti-flake requirements for the gate

1. No wall-clock `sleep` in assertions; waits are on observable conditions with generous ceilings.
2. No timing assertions except the explicitly budgeted performance test, which asserts ceilings.
3. F3 is seeded, so expected failing sets are exact.
4. All fixtures bind `127.0.0.1:0`; the harness passes the resolved port.
5. Each test uses its own temp workspace and never touches the repository `.investigator/`.
6. CI runs tests 1–10 on Linux and Windows; tests 2–10 run twice in the same job, and a test that
   passes once and fails once fails the gate.
7. No test depends on another test's state or ordering.
8. `DEEPSEEK_API_KEY` is set to a dummy value in the gate job to prove the execution path never
   uses it and never leaks it.
