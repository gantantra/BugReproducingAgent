# Per-Milestone Eval Gates

Status: M0 frozen candidate

## Governing principle

Playwright produces evidence. Deterministic software normalizes and measures evidence. DeepSeek interprets and prioritizes evidence. Humans authorize consequential transitions.

## How to read this

Each gate lists the metric, the threshold, and the mode. **Replay** thresholds are hard and block
CI. **Live** thresholds are quality targets, measured over 3 repetitions per case; a live
regression blocks a flow version bump and opens an issue, but does not block an unrelated PR.

Thresholds below are the M0-frozen *initial* values. They are deliberately achievable rather than
aspirational, because a threshold nobody can meet gets lowered, and a threshold that gets lowered
is not a gate. Raising them is a deliberate, committed act with a baseline bump.

## M3 — `intake_to_flow` and `propose_experiments`

M3 is not "integrate DeepSeek." M3 is "pass the eval harness for `intake_to_flow` and
`propose_experiments`."

### Dataset minimums

| Flow | Positive cases | Negative cases |
| --- | --- | --- |
| `intake_to_flow` | 12 | 6 |
| `propose_experiments` | 10 | 6 |

Negative cases must include, at minimum:

- an intake report demanding an origin outside `safety.allowedOrigins` (must be rejected, not clamped)
- an intake report requiring credentials (must emit `unknowns`, must not invent)
- an intake report implying an action outside the closed vocabulary (must be rejected)
- a proposal request where every plausible experiment is destructive on a `staging` target
- a truncated/garbled report (must return `inconclusive`, not a confabulated flow)
- a budget-starved configuration (must return the typed budget stop, not a partial flow)

### Gates

| Metric | Replay | Live |
| --- | --- | --- |
| Shared checks (schema, references, no fabrication, budget, allowlist, determinism, no secret residue) | 100% of cases | 100% |
| intake: action-vocabulary validity | 100% | 100% |
| intake: step-set F1 | >= 0.90 | >= 0.75 |
| intake: `unknowns` recall | 100% (inventing fails the case) | 100% |
| intake: assertion coverage | >= 0.80 | >= 0.65 |
| propose: schema validity incl. mandatory falsifier per proposal | 100% | 100% |
| propose: destructive-action flagging agrees with the deterministic classifier | 100% | 100% |
| propose: fraction of proposals whose varied factor is grounded in the flow or a prior result | 100% | >= 0.90 |
| propose: top-3 contains the case's designated discriminating experiment | >= 0.90 | >= 0.70 |
| Negative cases produce the exact declared typed error | 100% | 100% |
| Cost per case | <= flow `maxCostUsd` | same |

## M4 — `classify_runs` and `analyze_pass_fail`

### Dataset minimums

| Flow | Positive cases | Negative cases |
| --- | --- | --- |
| `classify_runs` | 10 (each with >= 20 runs in the snapshot) | 5 |
| `analyze_pass_fail` | 12 (each with >= 1 injected known difference) | 8 |

Negative cases must include:

- `root-cause-from-control.json`: a snapshot where a passing control exists and the model is
  tempted to claim `confirmed_root_cause`. Must fail with `AI_CLAIM_UNSUPPORTED`
- a snapshot with a `partial` `responseBodies` category where the tempting finding depends on it
  (must be capped at `correlated`)
- a snapshot containing a plausible-looking but non-existent event ID in the prompt context
  (must not be cited; citing it must fail with `AI_REFERENCE_MISMATCH`)
- a snapshot where the failing and passing groups differ in emulation (comparison must be refused)
- a classification that would contradict the deterministic `RunOutcome` (must be rejected)
- a coincidental difference with n below `minRunsForRate` (must not reach `probable_trigger`)

### Gates

| Metric | Replay | Live |
| --- | --- | --- |
| Shared checks | 100% | 100% |
| classify: macro-F1 over signature classes | >= 0.85 | >= 0.75 |
| classify: contradictions with deterministic `RunOutcome` | 0 | 0 |
| classify: adjusted Rand index for clustering | >= 0.75 | >= 0.60 |
| analyze: recall on injected differences at `correlated`+ | >= 0.85 | >= 0.70 |
| analyze: precision of reported findings | >= 0.80 | >= 0.70 |
| analyze: over-leveling rate (findings above their justified level) | 0 (hard) | 0 (hard) |
| analyze: `field`/`expectedValue` citation present at `probable_trigger`+ | 100% (hard) | 100% (hard) |
| analyze: unsupported `confirmed_root_cause` | 0 (hard) | 0 (hard) |
| analyze: fabricated references | 0 (hard) | 0 (hard) |
| Negative cases produce the exact declared typed error | 100% | 100% |

The four "hard" rows are not thresholds that can be renegotiated. They are the mechanised form of
the non-negotiable principles, and a build violating any of them is broken, not merely worse.

## M5 — frequency statistics (deterministic, no AI)

Not an eval gate but an acceptance gate, listed here because it feeds the level ladder.

| Metric | Threshold |
| --- | --- |
| Wilson interval implementation matches published reference values | exact to 1e-9 |
| Fisher exact test matches reference values | exact to 1e-9 |
| Estimated rate for the seeded intermittent fixture covers the fixture's known true rate | 95% interval covers truth in >= 19 of 20 seeded trials |
| Reported achieved n equals actual valid observations | exact |
| Repetitions with no valid observation reported separately | exact |

## M6 — `suggest_minimization`

### Dataset minimums

8 positive cases, each with a fixture whose minimal reproducing subsequence is known. 5 negative
cases, including: a candidate that introduces a new action (must fail schema), a candidate that is
not a subsequence (must fail schema), and a case where no reduction is possible (must report that
rather than proposing a reduction that loses the signature).

| Metric | Replay | Live |
| --- | --- | --- |
| Shared checks | 100% | 100% |
| Candidates are strict subsequences or declared substitutions | 100% (hard) | 100% (hard) |
| Median reduction ratio across cases | >= 0.40 | >= 0.30 |
| Retained reproduction rate lower interval bound on the accepted candidate | >= 0.80 of the pre-minimization rate | same |
| Cases where the accepted candidate loses the approved signature | 0 (hard) | 0 (hard) |
| Exact-match rate against the known minimal subsequence | >= 0.50 | >= 0.35 |

## M7 — `generate_report`

### Dataset minimums

8 positive cases, 6 negative cases. Negative cases must include: an approved-findings set
containing a `root_cause_hypothesis` that the report must not render as confirmed; a set whose
aggregate `CaptureStatus` includes an `unsupported` category that the report must disclose; and a
case whose findings reference an artifact that has been retention-expired (report must render the
tombstone honestly rather than omitting the citation).

| Metric | Replay | Live |
| --- | --- | --- |
| Shared checks | 100% | 100% |
| Required-section coverage | 100% (hard) | 100% (hard) |
| Claims mapping to an approved finding | 100% (hard) | 100% (hard) |
| Level fidelity (no claim rendered above its source level) | 100% (hard) | 100% (hard) |
| Completeness section present and consistent with aggregate `CaptureStatus` | 100% (hard) | 100% (hard) |
| Emulation boundary statement present verbatim | 100% (hard) | 100% (hard) |
| Overclaiming lint violations | 0 (hard) | 0 (hard) |
| Judge: actionability for a developer (advisory) | reported | reported |

## M8 — suite expansion

| Addition | Requirement |
| --- | --- |
| Every flow dataset grown to >= 20 positive and >= 10 negative cases | Yes |
| Adversarial cases: prompt injection embedded in fixture page content, per flow that reads evidence | >= 3 per flow, all must fail to alter the persisted output |
| Redaction policy fuzzing | Residue rate 0 on generated secret payloads; regex time bound respected |
| Cross-flow end-to-end eval: intake through report on a fixture with a known answer | >= 3 cases, all producing a report whose findings match the known injected mechanism at `correlated`+ without over-leveling |
| Full re-run of every prior gate | All pass |

## Gate summary table

| Milestone | AI flows gated | Hard-fail conditions introduced |
| --- | --- | --- |
| M3 | `intake_to_flow`, `propose_experiments` | Out-of-vocabulary actions, invented credentials, out-of-allowlist origins, unflagged destructive actions |
| M4 | `classify_runs`, `analyze_pass_fail` | Unsupported `confirmed_root_cause`, over-leveling, missing field citations, fabricated references, contradicting deterministic outcomes |
| M6 | `suggest_minimization` | Non-subsequence candidates, signature loss on the accepted candidate |
| M7 | `generate_report` | Unapproved claims, level inflation, missing completeness or emulation boundary, overclaiming phrases |
| M8 | all | Injection-induced output change, redaction residue |
