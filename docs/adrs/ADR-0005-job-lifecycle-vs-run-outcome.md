---
id: ADR-0005
title: Job lifecycle, run outcome, and evidence completeness are three independent dimensions
status: accepted
date: 2026-09-10
touches: [execution, evidence]
decision: Model worker lifecycle (JobState, JobTerminalReason), observation (RunOutcome), and evidence completeness (CaptureStatus) as orthogonal recorded facts, with a deterministic ordered rule set deciding RunOutcome and a recorded rule id, and with retry operating only on lifecycle and completeness.
consequences: A captured product failure is a successful worker execution and can never be masked by retry, at the cost of a vocabulary that is larger than a single pass/fail flag.
---

# ADR-0005 — Three orthogonal dimensions

## Governing principle

Playwright produces evidence. Deterministic software normalizes and measures evidence. DeepSeek interprets and prioritizes evidence. Humans authorize consequential transitions.

## Context

Conventional test tooling collapses everything into pass or fail, then adds retries to reduce
flakiness. For an intermittent-defect investigator, that collapse is fatal in two directions:

- A broken selector reported as a product failure invents defects.
- A retry that replaces a product failure with a pass erases the very observation the
  investigation exists to collect.

Frequency statistics feed the finding level ladder, so a corrupted count does not merely mislead a
human; it mechanically promotes a claim.

## Decision

Three dimensions, recorded separately, never conflated:

1. **Job lifecycle** — `JobState` in `PENDING | CLAIMED | RUNNING | TERMINAL`, plus
   `JobTerminalReason` in `COMPLETED | INTERRUPTED | WORKER_ERROR`. Did the worker run to completion?
2. **Run outcome** — `RunOutcome` in `VALID_COMPLETED | PRODUCT_FAILED | AUTOMATION_FAILED |
   INFRASTRUCTURE_FAILED | INTERRUPTED | INCONCLUSIVE`. What did the run observe?
3. **Evidence completeness** — `CaptureStatus` per category. How much of the intended evidence exists?

`TERMINAL` + `COMPLETED` + `PRODUCT_FAILED` is a **successful worker execution** that captured a
valid product failure, and it counts toward product-failure frequency.

Legal combinations are enumerated in `docs/architecture/queue-model.md` and enforced by SQLite
`CHECK` constraints, so an illegal pair cannot be written even by buggy application code.

## RunOutcome decision rules

Six ordered rules, first match wins, with the matching `outcomeRuleId` recorded in the manifest:

1. Killed, lease expired, or terminated mid-run -> `INTERRUPTED`
2. Harness/host/environment failure before the first successful navigation -> `INFRASTRUCTURE_FAILED`
3. Automation instructions failed against the application -> `AUTOMATION_FAILED`
4. A declared product assertion failed or a failure predicate matched -> `PRODUCT_FAILED`
5. All assertions passed and required categories are `complete` -> `VALID_COMPLETED`
6. Anything else, including green with a missing required category -> `INCONCLUSIVE`

Rule 3 precedes rule 4 so a broken script is never reported as a defect. Rule 6 follows rule 5 so
a green run with missing required evidence is not treated as proof of correctness. Ambiguity
between rules 2 and 3 resolves by boundary — harness/host versus instructions-meet-application —
and genuine ambiguity goes to `INCONCLUSIVE`, never to `PRODUCT_FAILED`.

## Independent recomputation

The Evidence Normalization Plane recomputes `RunOutcome` and `outcomeRuleId` from persisted
evidence and compares against the executor. Disagreement is an integrity failure, not a warning.
This makes the executor's fast in-process classification auditable after the fact.

## Retry discipline

- `INFRASTRUCTURE_FAILED` and `INTERRUPTED` are retryable, as **new job rows** with an incremented
  `attempt_index` and a `previous_attempt_job_id` link.
- `AUTOMATION_FAILED` is not retryable: the approved sequence is wrong, which is a human decision.
- `PRODUCT_FAILED` and `VALID_COMPLETED` are never retried. They are observations.
- `INCONCLUSIVE` is not auto-retried; it is surfaced with its reason.
- `repetition_index` (test repetition) and `attempt_index` (infrastructure retry) are separate
  counters. Statistics take the last non-interrupted attempt per repetition and report separately
  the repetitions with no valid observation.

## Consequences

Positive: no product failure can be hidden by retry (asserted by
`no_retry_hides_product_failure.spec.ts`); harness problems are visibly distinct from defects;
green-with-missing-evidence is visibly distinct from green; and every classification is explainable
by a recorded rule id.

Negative: a larger vocabulary than pass/fail, and a class of genuinely ambiguous runs that land in
`INCONCLUSIVE` rather than being forced into a verdict. Both are the honest cost.
