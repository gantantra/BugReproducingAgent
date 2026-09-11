# Acceptance Criteria and Success Metrics

Status: M0 frozen candidate

## Governing principle

Playwright produces evidence. Deterministic software normalizes and measures evidence. DeepSeek interprets and prioritizes evidence. Humans authorize consequential transitions.

## Product acceptance criteria

The product is acceptable when all of the following hold on a fixture-based end-to-end run and on
at least one real authorized test-environment investigation.

| # | Criterion | How it is demonstrated |
| --- | --- | --- |
| A1 | An informal report becomes a schema-valid `Flow` with ungroundable values in `unknowns` rather than invented | M3 eval, `unknowns` recall 100% |
| A2 | Experiments are ranked, each with a hypothesis, a varied factor, and a falsifier | M3 eval, schema requires a falsifier |
| A3 | No experiment executes without a checksum-bound human approval | M2 negative tests: every execution path without an approval returns `GATE_REQUIRED` |
| A4 | Execution is deterministic and evidence is uniform across runs | M1 gate: 100 runs, complete evidence, byte-identical rebuild |
| A5 | Job lifecycle, run outcome, and evidence completeness are recorded independently and never conflated | M1 gate: `fixture_app_classification`, `interrupted_worker_typed_outcome`, `no_retry_hides_product_failure` |
| A6 | Missing, partial, redacted, unsupported, disabled, and corrupted evidence is explicit per run per category | M1 gate plus schema requiring all categories |
| A7 | Runs are clustered against deterministically computed failure signatures, and the human approves the target | M4 eval plus M2 gate tests |
| A8 | Failure incidence is measured with intervals, achieved n, and no-valid-observation counts | M5 acceptance gate |
| A9 | Every analytical claim carries validated evidence references, including exact field matches at `probable_trigger` and above | M4 eval, hard gates |
| A10 | No AI output is persisted if it fails schema or reference validation | M3/M4 negative cases; a test asserts zero persisted records for failing outputs |
| A11 | `confirmed_root_cause` cannot be emitted without approved direct evidence, and is unreachable in MVP | M4 hard gate `root-cause-from-control` |
| A12 | A minimized reproduction is produced with a measured retained reproduction rate and a passing control | M6 gate |
| A13 | A Jira-ready report is produced whose every claim maps to an approved finding, with completeness and emulation boundaries disclosed | M7 hard gates |
| A14 | Full lineage from report to deliverable is queryable offline, with `actor.kind` on every hop | M2 and M7 acceptance tests |
| A15 | No secret or PII appears in any persisted artifact, DB row, log line, index entry, or export | M1 gate `redaction_before_persistence`, M7 export verification, M8 fuzzing |
| A16 | The API key never appears in any output, artifact, log, or error | M3 secret-hygiene tests |
| A17 | No AI code path can reach the executor or the collector | Import-graph test fails the build otherwise |
| A18 | Provider outage does not block capture, frequency measurement, or revalidation | M3 test with the provider stubbed to fail |
| A19 | Budget exhaustion returns a typed partial or inconclusive result, never a truncated pretend-complete one | M3/M4 budget-starved negative cases |
| A20 | Destructive actions cannot execute without a per-sequence acknowledged approval, and `production` targets are rejected | M2 negative tests |

## Success metrics

Split into three tiers, because they answer different questions.

### Tier 1 — trustworthiness (must hold; regressions are defects)

| Metric | Target |
| --- | --- |
| Fabricated evidence references reaching persistence | 0 |
| Over-leveled findings reaching persistence | 0 |
| `confirmed_root_cause` without approved direct evidence | 0 |
| Product failures hidden by infrastructure retry | 0 |
| Runs with a `RunOutcome` the extractor cannot independently reproduce | 0 |
| Secret/PII residue in persisted or exported evidence | 0 |
| Executions without a valid approval | 0 |
| Reliability gate pass rate in CI | 100% |

These are binary. There is no acceptable non-zero value, which is why each has an executable gate
rather than a dashboard.

### Tier 2 — investigative effectiveness

| Metric | Definition | Initial target |
| --- | --- | --- |
| Reproduction rate | Fraction of accepted investigations that produce a reproduction with a lower interval bound above 0 | >= 0.6 on issues that are genuinely reproducible at >= 1% |
| Control rate | Fraction of reproductions accompanied by a disjoint-interval passing control | >= 0.8 |
| Minimization reduction | Median action-count reduction on accepted candidates | >= 0.3 |
| Signature retention | Fraction of accepted candidates retaining the approved signature | 1.0 |
| Injected-difference recall | M4 eval recall at `correlated`+ | >= 0.85 replay, >= 0.70 live |
| Finding precision | M4 eval precision | >= 0.80 replay, >= 0.70 live |
| Inconclusive rate | Fraction of investigations ending `INCONCLUSIVE` | Reported, not targeted. A high rate on rare defects is honest, not a failure |

Tier 2 targets are provisional until there is real usage data. They are recorded so that later
measurement has a baseline to argue with, not so that they can be gamed.

### Tier 3 — operational

| Metric | Initial target |
| --- | --- |
| Wall clock for 100 sequential fixture runs | < 600s on the CI runner class |
| p95 per-run duration, 4-action fixture with video and trace | < 8s |
| Disk per 100 runs, video and trace on | < 1.5 GB |
| Cost per investigation (all flows, typical) | < $5, enforced by `perInvestigationUsd` |
| Cost per `intake_to_flow` call | < $0.05, enforced by flow budget |
| Time from report file to gate-1 proposal | < 3 minutes |
| Provider-independent commands (`run`, `frequency run`, `revalidate`, `export`) working with no key present | 100% |

## Explicit non-goals, restated as anti-metrics

The following are deliberately **not** success metrics, and optimising for them would damage the
product:

| Anti-metric | Why |
| --- | --- |
| Number of findings per investigation | Rewards speculation |
| Average confidence score | Self-reported confidence is uncalibrated and is never a gate |
| Fraction of investigations reaching `confirmed_root_cause` | Unreachable by design in MVP; making it reachable cheaply would break the central guarantee |
| Fraction of runs passing | The product exists to find failures |
| Reduction in `INCONCLUSIVE` outcomes | `INCONCLUSIVE` is the correct answer when evidence is insufficient |
| Model token efficiency | Cheaper reasoning that skips reference citation is worse, not better |
| Time to report when evidence is incomplete | Speed at the expense of the completeness gate is negative value |

## Definition of done, per milestone

A milestone is done when: its exit criteria in `docs/milestones/M<n>.md` are met; its acceptance
tests pass; its eval gates pass if it touches AI; every prior gate still passes; the demo command
runs from a clean workspace; and the milestone report lists files changed, tests added, commands
run, results, known limitations, and unfinished requirements.

No milestone is done because the code exists. It is done because the gates pass and the demo runs.
