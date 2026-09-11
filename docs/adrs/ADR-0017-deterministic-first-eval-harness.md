---
id: ADR-0017
title: Deterministic-first eval harness with recorded replay as the blocking gate and an LLM judge only as advisory
status: accepted
date: 2026-09-10
touches: [ai]
decision: Make replay-mode eval against recorded provider responses the blocking CI gate, run live mode over multiple repetitions as the quality signal, score with deterministic domain-specific scorers, weight negative cases equally, and permit an LLM judge only for undecidable properties with calibration items and never as a sole gate.
consequences: CI needs no API key and never flakes on model sampling, at the cost of maintaining recorded fixtures and refreshing them on deliberate prompt changes.
---

# ADR-0017 — Deterministic-first eval harness

## Governing principle

Playwright produces evidence. Deterministic software normalizes and measures evidence. DeepSeek interprets and prioritizes evidence. Humans authorize consequential transitions.

## Context

M3 is not "integrate DeepSeek." M3 is "pass the eval harness for `intake_to_flow` and
`propose_experiments`." That framing only means something if the harness is trustworthy, which
requires two properties that pull against each other: determinism, so a red build is a real
regression, and realism, so the score reflects actual model quality.

An eval gate built solely on live model calls is flaky, costs money on every PR, needs a key in
CI, and produces red builds that developers learn to re-run. An eval gate built solely on recorded
responses measures our validation machinery and not the model.

## Decision

Both, with clearly separated roles.

| Mode | Provider | Role | Blocks |
| --- | --- | --- | --- |
| `replay` | `RecordedProvider` over `recorded/` fixtures | Deterministic gate over validation, budgets, tools, references, scoring | Every PR |
| `live` | DeepSeek adapter | Actual model quality, 3 repetitions per case, mean with range | A flow version bump; a nightly regression opens an issue |
| `record` | DeepSeek, writes fixtures | Refresh after a deliberate prompt or schema change | Nothing; the refresh is a visible commit |

- Replay is the blocking gate, so CI needs no API key and cannot flake on sampling.
- Live is the quality signal. A single sample from a stochastic model is not a measurement, so
  live mode runs each case multiple times and reports the mean with its range; a case passes only
  if all repetitions pass unless it declares `allowedFailures`.

### No eval privileges

The runner executes flows with their **real** budgets, their **real** allowlists, a frozen `Clock`,
a fixed seed, and `temperature: 0`, against a pre-built redacted store snapshot so that tools
return real facts and reference validation is genuinely exercised. If a flow cannot call a tool in
production, it cannot call it in eval.

### Deterministic scorers, and negative cases

Shared checks apply to every case and fail it outright: schema validity, reference validity, zero
fabrication, budget respected, allowlist respected, replay determinism, and no secret residue.

Per-flow scorers are domain-specific — step-set F1 and `unknowns` recall for intake; confusion
matrix and adjusted Rand index for classify; injected-difference precision/recall with separate
over-leveling scoring for analyze; the reduction-ratio-versus-retained-rate **pair** for minimize;
required-section and claim-traceability checks for report.

Negative cases are first-class and weighted equally, and each declares the exact typed error it
must produce. A system that scores well on positives and silently accepts fabrication is worthless.

### The judge is advisory

An LLM judge is permitted only for properties genuinely not decidable deterministically —
coherence of a hypothesis with its citations, actionability of a report, non-circularity of a
rationale. Constraints: a judge score is never the sole basis for pass or fail; judge prompts are
versioned hashed flow artifacts; judge outputs are schema-validated; and each judge run includes
**calibration items** with known-good and known-bad answers, with all scores from an uncalibrated
run discarded and reported as `judge-uncalibrated`.

### Baselines

`/eval/reports/baselines.json` records accepted metrics per `(flowId, flowVersion, mode)`.
Baselines are raised deliberately in a commit that says so. They are never lowered to make a build
green; a genuine regression is fixed or the milestone slips.

## Consequences

Positive: deterministic blocking gates; no key required in CI; the validation machinery is itself
under test; over-leveling and fabrication are measured separately from ordinary wrongness;
stochastic quality is measured with repetitions rather than a single sample.

Negative: recorded fixtures need maintenance and can go stale after a deliberate prompt change,
which is why `record` mode exists and why the refresh is a reviewable commit. Replay can also mask
a real live regression until the nightly run, which is accepted because a version bump requires
live verification.
