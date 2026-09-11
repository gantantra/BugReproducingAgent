---
id: ADR-0022
title: Trace disposition defaults to withhold in M1
status: accepted
date: 2026-09-11
touches: [evidence]
decision: Default capture.tracePolicy to withhold, so traces are collected for in-process analysis but not persisted, and captureStatus.trace is recorded as redacted with a POLICY_REDACTED reason. raw-opt-in remains available for fixture-classified targets so the reliability gate still exercises trace handling. The redacted-pipeline disposition is deferred to M8.
consequences: No unredacted trace ever reaches disk in M1 and the milestone stays scoped, at the cost of losing trace-derived diagnostic power on non-fixture targets until M8.
---

# ADR-0022 — Trace disposition: withhold by default

## Governing principle

Playwright produces evidence. Deterministic software normalizes and measures evidence. DeepSeek interprets and prioritizes evidence. Humans authorize consequential transitions.

## Context

Open question Q11. Playwright traces are the richest client-side artifact and the riskiest: they
carry network bodies, DOM snapshots, and action metadata in a packed format that is not fully
field-addressable. ADR-0008 specified three dispositions and left the M1 default to be decided.

`redacted-pipeline` means unpacking a trace, redacting each resource, dropping what is not
field-addressable, and repacking. It is real work with real failure modes, and getting it wrong
means persisting unredacted secrets — the exact outcome ADR-0008 exists to prevent.

## Decision

M1 default is `withhold`:

- The trace is still collected, because it is useful in-process and because the collector path
  must be exercised.
- It is **not** persisted. `captureStatus.trace` is `redacted` with a `POLICY_REDACTED` reason and
  a generated limitation string.
- `raw-opt-in` remains permitted only when every configured target is classified `fixture`, and
  every manifest produced in such a session records `unsafeTrace: true`. This is what lets the
  reliability gate exercise trace writing, hashing, and integrity checking on fixture apps without
  ever risking real evidence.
- `redacted-pipeline` is accepted in the schema and rejected at config load in M1 with a message
  naming this ADR. It is an M8 deliverable.

## Consequence for the level ladder

Because `trace` is `redacted` by default, any finding whose evidence depends on the trace category
is capped at `correlated` by ADR-0016. That is the intended behaviour: the system declines to make
a strong causal claim on evidence it cannot show. Findings built on actions, console, exceptions,
network metadata, DOM snapshots, and storage — all of which are persisted redacted — are unaffected,
and those are the categories the analysis flows actually read.

## Alternatives considered

| Alternative | Why rejected for M1 |
| --- | --- |
| `redacted-pipeline` as the M1 default | Highest-risk redaction work in the milestone with the least payoff; a bug means the exact leak ADR-0008 forbids |
| `raw-opt-in` as the default | Persists unredacted secrets on any non-fixture target. Not acceptable at any milestone |
| Drop trace collection entirely in M1 | The collector and integrity paths would then be untested until M8, and `trace` would be `disabled` rather than `redacted`, which is a less accurate description of why it is absent |

## Consequences

Positive: zero risk of unredacted trace bytes on disk; M1 scope reduced by the largest single
redaction task; the reliability gate still covers trace collection, hashing, and integrity via
fixtures; the diagnostic cost is explicit in `CaptureStatus` and priced into the level ladder
rather than hidden.

Negative: on `test` and `staging` targets, traces contribute nothing to persisted evidence until
M8. An investigator who wants a trace to open in Playwright tooling must either use a fixture
target or wait for the pipeline. Stated as a known limitation in the M1 report.
