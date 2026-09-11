# Reliability Strategy and the M1 Reliability Gate

Status: M0 frozen candidate (frozen decision 3)

## Governing principle

Playwright produces evidence. Deterministic software normalizes and measures evidence. DeepSeek interprets and prioritizes evidence. Humans authorize consequential transitions.

## Why a gate

The entire product rests on one claim: the evidence is trustworthy. If the harness itself is
flaky, mis-attributes network events, loses a manifest, hides a product failure behind a retry, or
persists unredacted data, then every downstream inference is worthless and the AI layer becomes an
elaborate way to launder noise. So M1 ends with an executable gate, and M2 may not begin until it
passes in CI.

## Fixture apps

Required in `/packages/test-fixtures`:

| Fixture | Behaviour | Expected outcome |
| --- | --- | --- |
| `passing-app` | Deterministically correct | `VALID_COMPLETED` on every run |
| `product-failing-deterministic` | Always violates a declared assertion (missing DOM state after a click, plus a console error) | `PRODUCT_FAILED` on every run |
| `product-failing-intermittent-seeded` | Fails on a *seed-determined* subset of runs at a configured target rate | `PRODUCT_FAILED` on exactly the predicted runs |
| `automation-failing` | Renders a page whose expected selector never exists, so the approved action cannot execute | `AUTOMATION_FAILED` on every run |
| `infrastructure-failing` | Refuses connections / closes the socket before response on a designated port | `INFRASTRUCTURE_FAILED` on every run |

Design constraints:

- Each fixture is a plain Node HTTP server with no dependencies beyond the standard library, bound
  to `127.0.0.1` on an ephemeral port, started and stopped by the test harness. No public network.
- The intermittent fixture is **seeded, not random**. Given the run seed, whether that run fails is
  a pure function. The test therefore asserts an exact set of failing runs, not a statistical
  range, which makes it a real assertion rather than a flaky one. The fixture also exposes its
  intended rate so the frequency statistics can be checked against a known truth in M5.
- The intermittent fixture reproduces a *realistic* intermittency mechanism rather than a coin
  flip: a race between two in-page async operations whose ordering is decided by a seeded delay,
  producing a genuine ordering difference in the network timeline. This gives M4 real injected
  differences to detect.
- `infrastructure-failing` fails at the transport layer *before* the first successful navigation,
  which is what distinguishes it from `automation-failing` under the `RunOutcome` decision rules.

## The performance fixture

Frozen decision 3: a deterministic local fixture sized for 100 sequential runs inside the agreed CI
budget.

Definition: `passing-app` served locally, a 4-action sequence (`goto`, `click`, `waitFor`,
`assert`), video and trace **on**, DOM snapshots on action boundaries, response bodies off.

Agreed CI budget: **10 minutes wall clock** for 100 sequential runs on the CI runner class, with a
per-run soft target of 4 seconds and a hard per-run ceiling of 20 seconds. The gate asserts:

- 100 of 100 runs reach `TERMINAL`/`COMPLETED`,
- 100 of 100 have `RunOutcome=VALID_COMPLETED`,
- total wall clock < 600s,
- p95 per-run duration < 8s,
- zero runs with any `CaptureStatus` category worse than `complete` for the required categories,
- disk growth < 1.5 GB for the batch (bounds artifact bloat, which is a real operational failure
  mode for video plus trace at 100 runs).

If the runner class cannot meet the budget, the *budget* is renegotiated in writing and the change
is recorded in `docs/FREEZE-M0.md`; the assertion is never quietly relaxed to make CI green.

## The ten gate tests

Located in `/tests/reliability/`. Each has a fixture app, a fixture test, and a pass criterion.
Full specifications, including exact assertions, are in `docs/acceptance-tests/M1-reliability-gate.md`.

| Spec file | Fixture | Pass criterion in one line |
| --- | --- | --- |
| `same_test_100_runs.spec.ts` | performance fixture | 100/100 `VALID_COMPLETED` within budget, complete evidence, bounded disk |
| `one_manifest_per_run.spec.ts` | passing + product-failing | Exactly one sealed, schema-valid, immutable manifest per run; 1:1 with `jobs` rows; second write attempt raises `MANIFEST_IMMUTABLE` |
| `monotonic_timestamps.spec.ts` | passing | For every run, `seq` is gap-free and `tMonoMs` and `tDeltaMs` are non-decreasing in `seq` order across all categories |
| `network_action_correlation.spec.ts` | purpose-built fixture with requests straddling action boundaries | Every network event is attributed to the action window containing its start `seq`; cross-window requests carry `finishedInActionId`; zero unattributed events |
| `no_retry_hides_product_failure.spec.ts` | product-failing intermittent + injected infra faults | With infra retries enabled, every repetition that produced a `PRODUCT_FAILED` observation is counted as a failure in the statistics; no repetition is reported as passing on the strength of a retry |
| `artifact_integrity_hashes.spec.ts` | passing | Every artifact ref hash matches recomputation; a deliberately corrupted byte is detected as `ARTIFACT_HASH_MISMATCH`; manifest seal detects tampering |
| `redaction_before_persistence.spec.ts` | fixture emitting cookies, auth headers, tokens in URLs, PII in a response body and in console | No unredacted secret appears in any persisted artifact, DB row, log line, or normalized index; every persisted record carries a `RedactionStamp`; a store call without a stamp raises `REDACTION_NOT_APPLIED` |
| `interrupted_worker_typed_outcome.spec.ts` | passing, killed mid-run | Stale job becomes `TERMINAL`/`INTERRUPTED`/`INTERRUPTED`; a partial manifest exists and is sealed with the interruption in `limitations`; no automatic re-enqueue |
| `fixture_app_classification.spec.ts` | all five fixtures | Each fixture yields its expected `RunOutcome` on every run, and `outcomeRuleId` matches the expected rule; confusion matrix is the identity |
| `offline_session_reconstruction.spec.ts` | passing + product-failing | With the network stubbed to throw and no browser available, the plane rebuilds normalized evidence, the timeline, and the evidence index from persisted artifacts alone, byte-identically to the original |

## Anti-flake discipline for the gate itself

A reliability gate that is itself flaky is worse than no gate.

- No wall-clock `sleep` in assertions. Waits are on observable conditions with generous ceilings.
- No assertion on absolute timing except the explicitly budgeted performance test, which asserts a
  ceiling, not a range.
- The intermittent fixture is seeded, so its expected failing set is exact.
- All fixtures bind to `127.0.0.1:0` and the harness passes the resolved port; no fixed ports, no
  port-collision flake.
- Every test cleans its workspace into a temp directory and never touches `.investigator/` in the
  repo.
- The gate runs on Windows and Linux in CI. Path handling, file locking, and process-kill semantics
  differ enough between them that a Windows-only developer machine is not sufficient evidence.
- CI runs the gate twice in the same job (`--repeat-each 2` semantics) for the nine non-performance
  tests. A test that passes once and fails once fails the gate.

## Beyond M1

The gate is a floor, not a ceiling. Later milestones add:

- M2: lineage chain verification and approval-bypass negative tests.
- M4: injected-difference detection precision/recall, and the hard-fail test for unsupported
  `confirmed_root_cause`.
- M5: statistics validated against the seeded fixture's known true rate.
- M6: minimization reduction ratio versus retained reproduction rate on a fixture with a known
  minimal reproducing subsequence.
- M8: redaction policy fuzzing, retention correctness, and a full re-run of every prior gate.

Every gate, once added, runs in CI forever. No gate is ever removed to unblock a milestone; a gate
that is wrong is fixed and the fix is recorded as an ADR.
