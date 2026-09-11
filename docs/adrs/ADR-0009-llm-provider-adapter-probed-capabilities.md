---
id: ADR-0009
title: One LlmProvider adapter with config-driven aliases and probed, never-assumed capabilities
status: accepted
date: 2026-09-10
touches: [ai]
decision: Access the provider only through an LlmProvider interface implemented by a fetch-based DeepSeek adapter; resolve models from three config-driven aliases with no guessing and no silent substitution; determine jsonMode, toolCalls, and thinkingMode by bounded startup probes cached with a TTL; disable unsupported functionality explicitly.
consequences: The system never depends on an unverified provider capability and never leaks provider shapes upward, at the cost of probe calls, a degradation matrix to maintain, and no provider SDK conveniences.
---

# ADR-0009 — LlmProvider adapter with probed capabilities

## Governing principle

Playwright produces evidence. Deterministic software normalizes and measures evidence. DeepSeek interprets and prioritizes evidence. Humans authorize consequential transitions.

## Context

Provider behaviour is not a stable contract. JSON mode may or may not exist for a given model,
tool calling may be partially implemented, "thinking" modes are expressed differently across
vendors and versions, and model catalogues may not be exposed at all. Hard-coding any of this
produces a system that works until a model ID changes and then fails in a way that looks like a
bug in our reasoning layer.

## Decision

- All provider access goes through `LlmProvider` with two methods: `complete` and `capabilities`.
- Three aliases only: `FAST_MODEL`, `REASONING_MODEL`, `FALLBACK_MODEL`. Each resolves through
  config, typically via `env:` indirection. **Never guess. Never silently substitute.** An
  unresolvable alias is a load-time `USAGE` error, not a mid-flow surprise.
- `FALLBACK_MODEL` is used only when a flow explicitly declares `fallbackAlias`, and every use is
  a recorded warning.
- **Do not assume the provider exposes a model catalog.** Capabilities come from, in order:
  a cached probe result keyed by `(provider, modelId, inferenceMode, adapterVersion)`; a bounded
  startup probe (one minimal request per capability, `maxTokens: 64`, 15s timeout, one retry);
  and config, which may only *narrow* an observed capability, never widen it.
- A probe that fails with `TIMEOUT`, `RATE_LIMIT`, or `PROVIDER_UNAVAILABLE` yields `unknown`, not
  `unsupported`. Absence of evidence is recorded as absence of evidence.
- `contextWindow` and `maxOutputTokens` are not safely probeable. They come from config when
  declared; otherwise a `CAPABILITY_UNKNOWN` warning is attached and budgets are enforced by our
  own token accounting rather than by trusting an unverified limit.
- Unsupported functionality is **disabled explicitly** per the degradation matrix in
  `docs/architecture/llm-provider-contract.md`. Tool-using flows return `AI_CAPABILITY_MISSING`
  rather than silently proceeding without tools.
- Provider-specific response shapes never leak past the adapter. Error classification is
  table-driven and unit-tested against recorded fixture responses so a wording change cannot
  reclassify an `AUTH` failure as retryable.
- Every call records provider, model ID, model version, inference mode, prompt/flow version,
  parameters, usage, latency, and warnings. The ledger row is written **before** dispatch as
  `IN_FLIGHT`, so a crash leaves an auditable spend rather than a silence.
- `inferenceMode` maps to concrete parameters through a config-declared table. An inexpressible
  mode emits `INFERENCE_MODE_UNSUPPORTED` and sends the neutral form; it never switches models.
- Retry, backoff, and circuit-breaker policy are explicit and share one wall-clock deadline derived
  from the flow budget.

## Why fetch rather than an SDK

An SDK encodes assumptions about JSON mode, tool calling, and error semantics that this ADR
obliges us to *observe* instead. The surface used is one endpoint. A thin `fetch` call plus a
classification table is smaller than the adapter needed to normalise an SDK's types into ours, and
it keeps the assumptions in one reviewable file.

## Alternatives considered

| Alternative | Why rejected |
| --- | --- |
| Hard-code model IDs | Guessing is forbidden; a rename becomes a silent failure |
| Trust documented capabilities | Documentation and deployed behaviour diverge; the contract requires observation |
| Automatic fallback on any failure | Silently changes which model produced a persisted finding |
| Treat probe failure as `unsupported` | Disables working functionality because of one flaky network moment |
| Provider SDK | Second source of truth for exactly the assumptions we refuse to make |

## Consequences

Positive: the system degrades visibly and predictably; no persisted result is attributable to an
unknown model; provider outage is isolated from the deterministic core (ADR-0006).

Negative: a handful of probe calls per cache miss; a degradation matrix that must be tested in all
four quadrants; and no SDK conveniences such as streaming helpers or automatic pagination.
