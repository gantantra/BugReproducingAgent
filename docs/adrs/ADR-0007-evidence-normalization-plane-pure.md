---
id: ADR-0007
title: The Evidence Normalization Plane is a versioned pure function
status: accepted
date: 2026-09-10
touches: [evidence, execution]
decision: Implement normalization, redaction, feature extraction, timeline construction, and indexing as a pure function of (raw artifacts, redactionPolicyVersion, normalizerVersion, extractorVersion), producing byte-identical output for identical inputs and rebuildable offline with no browser and no network.
consequences: Evidence differences between runs are attributable to the application rather than to the tooling, at the cost of banning ambient time, randomness, and locale from the entire evidence path.
---

# ADR-0007 — Normalization Plane as a pure function

## Governing principle

Playwright produces evidence. Deterministic software normalizes and measures evidence. DeepSeek interprets and prioritizes evidence. Humans authorize consequential transitions.

## Context

The product compares runs. If the comparison layer is itself nondeterministic, every comparison
contains tooling noise, and the model will faithfully find patterns in that noise. Worse, the
noise is invisible: nothing in the output says "this difference is mine, not the application's".

Sources of accidental nondeterminism in a browser-evidence pipeline are numerous: wall-clock
timestamps, absolute durations, attribute ordering in serialized DOM, unsorted query parameters,
volatile IDs, bundle hashes in stack frames, locale-dependent formatting, map iteration order,
and unstable floating-point formatting.

## Decision

```
Raw Chrome evidence -> parsing -> normalization -> redaction and policy enforcement
  -> deterministic feature extraction -> evidence index and session timeline -> AI Gateway
```

Each stage is a pure function. The plane as a whole is a pure function of
`(raw artifacts, redactionPolicyVersion, normalizerVersion, extractorVersion)`.

Rules:

- No `Date.now()`, no `Math.random()`, no ambient locale or timezone anywhere in `packages/evidence`
  or `packages/execution`. `Clock` and a seeded `Rng` are injected; the seed is recorded per run.
- Canonicalisation is explicit and versioned: sorted query keys, ID-pattern placeholders in path
  segments, sorted DOM attributes, collapsed whitespace-only text nodes, masked volatile
  attributes, normalized stack frames with bundle hashes stripped, volatile substrings in console
  text replaced by stable placeholders for fingerprinting.
- Timings are recorded both absolutely and as `deltaFromRunStartMs`; comparison uses deltas.
  Durations are reported both raw and bucketed into stable bands.
- Every derived record stamps the versions that produced it. Changing a version invalidates cached
  derived data rather than silently mixing generations.
- The plane must rebuild from persisted artifacts alone, offline, with `fetch` stubbed to throw
  and no browser binary reachable, producing byte-identical output. Asserted by
  `offline_session_reconstruction.spec.ts`.
- Redaction sits *inside* the plane, before persistence of normalized data, so the pure-function
  property and the redaction boundary are the same property.

## Network-to-action correlation

An event belongs to the action whose `[actionStartSeq, actionEndSeq]` window contains its `seq`.
Requests that start in one window and finish in a later one are attributed to their **start**
window and carry `finishedInActionId`. Events outside any window belong to synthetic
`pre-first-action` or `post-last-action` windows. Zero unattributed events is a gate criterion.

Attribution by `seq` rather than by timestamp is deliberate: `seq` comes from a single in-process
counter and is total, whereas timestamps from different sources can tie.

## Consequences

Positive: a difference in the normalized output is a difference in the application. Comparisons
are meaningful. Evidence is re-derivable years later from the artifacts alone. Caching is safe
because cache keys include the version triple.

Negative: strict discipline in a large surface of code, and canonicalisation that can hide a real
difference (two runs whose only difference is an ID that got placeholdered). Mitigated by
retaining the original alongside the normalized form where policy permits, and by reporting both
raw and bucketed durations.

Negative: cross-platform ICU and locale differences are a real risk to byte-identity. Locale and
timezone are pinned per run and the byte-identity assertion runs on both Windows and Linux in CI.
