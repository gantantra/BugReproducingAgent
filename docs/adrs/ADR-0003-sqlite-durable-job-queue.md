---
id: ADR-0003
title: Durable job queue as a SQLite table with leases and explicit reaping
status: accepted
date: 2026-09-10
touches: [execution, storage]
decision: Implement the work queue as a SQLite job table with application-assigned ordering, leases, heartbeats, and an explicit reaper that converts stale claims to a typed interrupted terminal state without automatic re-enqueue.
consequences: Durable, inspectable, zero-ops queueing whose semantics port cleanly to PostgreSQL or BullMQ, at the cost of polling rather than push delivery.
---

# ADR-0003 — SQLite-backed durable job queue

## Governing principle

Playwright produces evidence. Deterministic software normalizes and measures evidence. DeepSeek interprets and prioritizes evidence. Humans authorize consequential transitions.

## Context

Frozen decision 1. Jobs must survive a crash, must be claimable without double-execution, and must
never silently lose or silently repeat a run. A repeated run is not merely wasted work: it
corrupts frequency statistics, which are load-bearing for the finding level ladder.

Redis plus BullMQ would give push delivery and mature tooling at the cost of a daemon the MVP
explicitly refuses (ADR-0001).

## Decision

A `jobs` table with:

- `state` in `PENDING | CLAIMED | RUNNING | TERMINAL`, `TERMINAL` absorbing.
- `terminal_reason` in `COMPLETED | INTERRUPTED | WORKER_ERROR`.
- `run_outcome` in the six-value `RunOutcome` enum, orthogonal to the above (ADR-0005).
- `seq`, an application-assigned monotonic integer, as the only ordering source.
- `worker_id` and `lease_expires_at` for lease-based claiming.
- `repetition_index`, `attempt_index`, `previous_attempt_job_id` for the separate counters.
- `UNIQUE (investigation_id, experiment_id, repetition_index, attempt_index)` so a retry cannot
  collide with its predecessor.
- `CHECK` constraints encoding every legal `(terminal_reason, run_outcome)` pair.

Claiming is one short `BEGIN IMMEDIATE` transaction selecting the lowest `seq` `PENDING` row and
updating it with a `WHERE state='PENDING'` guard. A claim that cannot acquire the write lock within
`busy_timeout` returns `null`; the worker backs off. It does not throw.

Workers heartbeat every `heartbeatMs`, extending the lease. `heartbeatMs < leaseMs / 3` is enforced
at config load so one missed heartbeat cannot cause a spurious reap.

`reapStale` runs at worker startup, on a timer, and at the start of any command reading run
statistics. For each expired `CLAIMED` or `RUNNING` row it sets
`TERMINAL`/`INTERRUPTED`/`INTERRUPTED`, seals a partial manifest if none exists, appends a lineage
record, and **does not enqueue a replacement**.

## The no-auto-requeue rule

Stale jobs are never silently re-run. An automatic requeue would be invisible in the statistics and
would create an unbounded loop against a broken environment. Re-running is a decision, made by the
operator or by an orchestrating command, and the decision is recorded.

## Portability

The semantics are chosen so that PostgreSQL implements `claim` as
`SELECT ... FOR UPDATE SKIP LOCKED` and BullMQ implements it natively, with no interface change.
Nothing in the interface exposes SQLite specifics.

## Alternatives considered

| Alternative | Why rejected |
| --- | --- |
| Redis + BullMQ | Requires a daemon; contradicts ADR-0001 |
| In-memory queue | Loses work on crash; makes the interrupted-outcome guarantee impossible |
| Filesystem directory queue | Atomic claim across platforms is hard; no transactional link to run records |
| Automatic requeue on reap | Hides failures, risks loops, corrupts statistics |

## Consequences

Positive: durable, queryable with plain SQL, one transaction per state change, trivially
inspectable during an investigation, and every anomaly leaves a row rather than a silence.

Negative: polling rather than push, so there is a small idle latency between enqueue and claim.
At MVP concurrency this is irrelevant. A busy database under many workers would need the
PostgreSQL adapter.
