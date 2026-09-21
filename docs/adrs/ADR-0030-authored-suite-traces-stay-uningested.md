---
id: ADR-0030
title: An authored suite's traces stay in its own folder, uningested; raw opt-in is deferred
status: accepted
date: 2026-09-21
touches: [execution, evidence]
decision: Keep the authored suite's Playwright trace at `retain-on-failure` in `suite/artifacts/`, where it has always been, and do not ingest traces or HAR into the evidence store; an opt-in raw capture per target is deferred.
consequences: No model can read a trace (ADR-0022 holds for authored runs too); an operator can still open a failing run's trace from the suite folder until the next rerun replaces it.
---

# ADR-0030 — Authored-suite traces stay uningested

## Governing principle

Playwright produces evidence. Deterministic software normalizes and measures evidence. DeepSeek interprets and prioritizes evidence. Humans authorize consequential transitions.

## Context

ADR-0022 withholds traces by default because a trace holds page content that no text rule can redact. When ADR-0029 gave `rerun` full capture, the question was whether the suite's own traces should be stored as well. The approved plan proposed an opt-in raw trace and HAR per target.

## Decision

Not now. The suite's config keeps `trace: "retain-on-failure"`, and traces stay under `suite/artifacts/`, outside the evidence store, as before. The redacted evidence ADR-0029 stores covers what analysis needs. An opt-in raw capture would need:
- its own `*-raw-unredactable` stamping
- a config key
- a decision about retention

None of that is required by anything shipped.

## Consequences

- Traces are never part of a batch, never reachable through a tool, and never sent to a model.
- A later opt-in is additive: a config key and one more artifact kind stamped like video.
