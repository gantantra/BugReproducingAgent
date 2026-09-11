---
id: ADR-0016
title: Capture completeness is recorded per run and per category, including an explicit disabled state
status: accepted
date: 2026-09-10
touches: [evidence, ai]
decision: Record a required status for every evidence category on every run with machine-readable reason codes and generated human limitations; add `disabled` to distinguish operator choice from collector inability; and make completeness gate run outcome, tool results, finding levels, report rendering, and export.
consequences: The system cannot reason over incomplete evidence as if it were complete, at the cost of a larger status vocabulary and findings capped below their apparent strength.
---

# ADR-0016 — Explicit capture completeness

## Governing principle

Playwright produces evidence. Deterministic software normalizes and measures evidence. DeepSeek interprets and prioritizes evidence. Humans authorize consequential transitions.

## Context

Missing, partial, redacted, unsupported, and corrupted evidence is represented explicitly, because
the alternative is confident reasoning over absence. A model shown a response-body set that was
truncated at 256 KB will conclude the body did not contain the field. That conclusion is wrong and
indistinguishable from a correct one unless the truncation is in the data.

## Decision

Every run records a `CaptureStatus` covering **every** category — `actions`, `navigation`,
`console`, `exceptions`, `networkMetadata`, `responseBodies`, `domSnapshots`, `storage`,
`screenshots`, `video`, `trace`, `webSocketFrames`. No key may be absent; an omitted key is
indistinguishable from a forgotten one, so the schema requires all of them.

Status values: `complete`, `partial`, `missing`, `redacted`, `unsupported`, `corrupted`,
**`disabled`**.

`disabled` is an addition to the set named in the brief. Rationale: "the operator turned video off
to save disk" and "this collector cannot capture WebSocket frames" have different remediations, and
collapsing them into `unsupported` loses the actionable distinction. Recorded as a deliberate
extension in `docs/FREEZE-M0.md` and raised as open question Q8.

Each category carries machine-readable `reasons` with codes (`SIZE_LIMIT`,
`CONTENT_TYPE_NOT_CAPTURED`, `POLICY_REDACTED`, `CONFIG_OFF`, `COLLECTOR_UNSUPPORTED`,
`RUN_INTERRUPTED`, `PARSE_FAILED`, `HASH_MISMATCH`, `DROPPED_BACKPRESSURE`, `TARGET_DETACHED`) and
counts. The human-readable `limitations` array is **generated** from those reasons by a template
table, so the prose and the machine data cannot drift.

## Five places completeness changes behaviour

1. **RunOutcome rule 6**: all assertions passing while a *required* category is `missing` or
   `corrupted` yields `INCONCLUSIVE`, not `VALID_COMPLETED`. Required categories are declared per
   experiment.
2. **Tool results**: every tool returns the completeness slice for the categories it read, in band.
   `get_response_excerpt` refuses outright when the category is `missing`/`disabled`/`unsupported`.
3. **Finding levels**: a finding whose evidence depends on a non-`complete` category for any cited
   run is capped at `correlated`, enforced deterministically in reference validation rather than by
   prompting.
4. **Report rendering**: the report must contain a completeness section listing every non-`complete`
   category for every cited run, asserted consistent with the aggregate. Rendering refuses if absent.
5. **Export**: the bundle carries the aggregate completeness summary.

## Aggregation never improves a status

Aggregate completeness is the per-category **worst** status across cited runs, ordered
`complete > partial > redacted > disabled > unsupported > missing > corrupted`. One `corrupted`
run in the cited set makes the aggregate `corrupted` and forces the report to say so.

## Language discipline

Coverage is described as "the configured, technically accessible, authorized, and successfully
collected client-observable evidence." The phrases "all browser data", "complete browser state",
"full session capture", "everything the browser saw", and "nothing was missed" are forbidden and
checked by a deterministic lint over rendered reports.

## Alternatives considered

| Alternative | Why rejected |
| --- | --- |
| Boolean `complete` flag per run | Cannot express which category degraded or why |
| Optional per-category keys | An absent key is ambiguous between "fine" and "forgotten" |
| Human-written limitations | Drifts from the machine data; cannot be validated |
| Best-status aggregation | Would let one good run mask a corrupted one |

## Consequences

Positive: no silent reasoning over absence; the level ladder automatically respects evidence
quality; reports disclose their own gaps; a truncated body is visible as truncation rather than as
absence.

Negative: a larger vocabulary, and genuinely useful findings capped at `correlated` because the
supporting category was partial. That is the intended trade.
