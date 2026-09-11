---
id: ADR-0011
title: Per-flow read-only tool allowlists with six-dimension budgets and typed partial results
status: accepted
date: 2026-09-10
touches: [ai, evidence]
decision: Give every flow an explicit tool allowlist enforced both at advertisement and at dispatch; make every MVP tool read-only, returning normalized, redacted, schema-validated facts with provenance and explicit truncation; enforce six budget dimensions; and return typed partial or inconclusive results on exhaustion.
consequences: The model cannot reach raw artifacts, cannot trigger execution, and cannot exceed a bounded cost, at the cost of pre-computing the comparisons the model is allowed to see.
---

# ADR-0011 — Read-only tool allowlists and bounded budgets

## Governing principle

Playwright produces evidence. Deterministic software normalizes and measures evidence. DeepSeek interprets and prioritizes evidence. Humans authorize consequential transitions.

## Context

A model with a general query tool over evidence will find patterns, because there are always
patterns. A model with a general *action* tool will eventually take an action nobody approved. And
a model with an unbounded loop will eventually cost more than the investigation is worth.

## Decision

### Allowlists

Every AI flow has an explicit tool allowlist, declared in its `flow.yaml`:

| Flow | Tools |
| --- | --- |
| `intake_to_flow` | none |
| `propose_experiments` | `get_flow`, `get_application_constraints`, `get_previous_experiment_summary` |
| `classify_runs` | `get_run_summary`, `get_action_timeline`, `get_console_events`, `get_exception_events`, `get_failure_signature` |
| `analyze_pass_fail` | `compare_run_timelines`, `get_request`, `get_response_excerpt`, `get_dom_diff`, `get_storage_diff` |
| `suggest_minimization` | `get_failure_signature`, `get_sequence`, `get_previous_minimization_results` |
| `generate_report` | `get_investigation_summary`, `get_approved_findings`, `get_validation_results`, `get_artifact_references` |

Enforced twice: the allowlist filters which specs are advertised to the provider, and the
dispatcher re-checks the tool ID before execution. A call for an unadvertised tool is
`AI_TOOL_NOT_ALLOWED`, charged against the budget, warned, never executed, and raised at flow
completion so it is never invisible.

### Read-only

Every tool is read-only for MVP. Every tool returns normalized, redacted, schema-validated facts.
No tool returns raw artifacts. No tool triggers execution. Guaranteed by:

- the import boundary (`tools` cannot import `execution` or `ai-gateway`),
- a shared contract test run against every registered tool, which asserts no raw bytes, no base64
  blobs, present provenance including a `RedactionStamp` and a `captureStatusSlice`, explicit
  truncation, determinism on repeat calls, and correct behaviour with the filesystem mounted
  read-only and network stubbed to throw.

Every citable datum carries an `eventId`, `artifactId`, or `statisticId`, so anything the model
says can be reference-validated against what it was actually shown.

### Pre-computed comparisons

`compare_run_timelines` returns a comparison the deterministic extractor already computed over a
bounded feature set, rather than accepting a free-form query. This is the main structural defence
against pattern-fishing: the model chooses among differences we measured, and cannot mine for
coincidences outside that set.

### Budgets

Six dimensions, all enforced: `maxTurns`, `maxToolCalls`, `maxEvidenceBytes`, `maxInputTokens`,
`maxOutputTokens`, `maxCostUsd`, `maxWallClockMs`, plus the investigation-level
`perInvestigationUsd` which always wins.

Budget exhaustion returns a typed partial or inconclusive result:

- Partial-capable flows (`classify_runs`, `analyze_pass_fail`) return `partial` with
  `completedUnits`, `totalUnits`, and a `stopReason`, and persist only individually validated units.
- Non-partial-capable flows (`intake_to_flow`, `propose_experiments`, `suggest_minimization`,
  `generate_report`) return `inconclusive`, because a half-formed flow, ranking, reduction plan, or
  report is worse than none.

Input is never silently trimmed to fit. A partial-capable flow reduces *scope*; a non-partial one
reports `inconclusive`.

## Alternatives considered

| Alternative | Why rejected |
| --- | --- |
| One general `query_evidence` tool | Enables pattern-fishing; makes reference validation the only guard |
| Tools returning raw artifacts | Sends unredacted evidence to the provider; blows context |
| Global allowlist shared by all flows | `intake_to_flow` would gain evidence access it has no business having |
| Silent truncation to fit budgets | The model reasons over a subset while believing it saw everything |
| Retry-until-valid loops | Unbounded cost; hides a systematically failing prompt |

## Consequences

Positive: bounded cost, bounded blast radius for prompt injection, no path from model output to
execution, and every shown fact is validatable.

Negative: adding an analytical capability means adding a deterministic extractor and a tool, not
just a prompt. That is slower, and it is the intended trade.

Any future write tool requires an ADR, a distinct `action` tool category, an explicit per-flow
opt-in, and a human approval gate on the specific action.
