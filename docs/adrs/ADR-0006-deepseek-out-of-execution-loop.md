---
id: ADR-0006
title: DeepSeek is never in the execution loop, enforced by the import graph
status: accepted
date: 2026-09-10
touches: [execution, evidence, ai]
decision: Forbid packages/execution, packages/evidence, and packages/test-fixtures from importing packages/ai-gateway, packages/ai-flows, or any provider SDK, enforced by an ESLint boundary rule and a build-failing import-graph test.
consequences: Evidence capture and measurement remain deterministic and provider-independent, at the cost of no adaptive in-run decision making.
---

# ADR-0006 — DeepSeek out of the execution loop

## Governing principle

Playwright produces evidence. Deterministic software normalizes and measures evidence. DeepSeek interprets and prioritizes evidence. Humans authorize consequential transitions.

## Context

The tempting design is an agent that drives the browser: look at the page, decide the next click,
notice something odd, poke at it. That design produces evidence nobody can compare across runs,
because the runs are not the same experiment. It also makes the browser session a function of
model sampling, provider latency, and provider availability.

The product needs the opposite: N runs of the *identical* sequence, so that differences between
runs are attributable to the application rather than to the agent.

## Decision

`DeepSeek is never in the execution loop.`

Concretely:

- `packages/execution`, `packages/evidence`, and `packages/test-fixtures` may not import
  `packages/ai-gateway`, `packages/ai-flows`, or any provider SDK, transitively.
- `packages/tools` may not import `packages/execution`. Tools are read-only projections.
- Enforced twice: an ESLint `no-restricted-imports` boundary rule for developer feedback, and an
  import-graph test that walks the resolved module graph and fails the build. The test is the
  authority, because lint can be disabled inline.
- The action interpreter executes a **closed vocabulary** defined in `schemas/action.v1.json`.
  There is no `eval`, no `page.evaluate` with model-supplied source, and no shell execution derived
  from model output. A new action type requires a schema change, a code change, and a human gate.
- Model output influences execution only after passing through gate 1 as an approved, edited,
  checksum-bound proposal. The executor reads the *effective* proposal, never a model response.

## What the model may and may not do

| May | May not |
| --- | --- |
| Propose sequences, ranked, with falsifiers | Execute anything |
| Classify and cluster completed runs | Change a recorded outcome |
| Compare pre-computed run differences | Query the browser |
| Suggest reductions from the existing sequence | Add an action mid-minimization |
| Draft a report from approved findings | Introduce a claim or raise a level |

## Consequence for provider outage

Because `ai-gateway` is unimportable from the deterministic packages, provider unavailability
cannot corrupt or block capture. `investigate run`, `investigate frequency run`,
`investigate revalidate`, `investigate suite generate`, and `investigate export` all work with no
key present and no network. Only interpretation is blocked, and it is blocked with a typed
`AI_PROVIDER_UNAVAILABLE` rather than a degraded guess. Asserted by M3-AT and exit criterion 3 of M3.

## Alternatives considered

| Alternative | Why rejected |
| --- | --- |
| Model-driven browsing with evidence capture | Runs are not comparable; intermittency cannot be measured |
| Model in the loop for "just" selector healing | Silently changes the experiment between runs, which is exactly the confound being hunted |
| Model-generated Playwright code executed at run time | Arbitrary code execution against an authorized environment; unbounded action surface |
| Convention plus code review instead of a build gate | The most important boundary in the system would depend on nobody making a mistake |

## Consequences

Positive: comparable runs, reproducible evidence, provider-independent core, a small and auditable
execution surface, and no path from model output to code execution.

Negative: no adaptive exploration within a run. If a sequence is wrong, the investigation learns
that from an `AUTOMATION_FAILED` outcome and a human fixes it at the next gate, which costs a
round trip. That cost is accepted.
