---
id: ADR-0002
title: SQLite metadata store in WAL mode with a single writer and short transactions
status: accepted
date: 2026-09-10
touches: [storage, execution]
decision: Use SQLite for metadata and lineage with WAL journalling, a single writer, a configured busy timeout, and short transactions that never span a browser action, a network call, or a provider call.
consequences: Zero-ops durable metadata with predictable concurrency, at the cost of limited write parallelism until the PostgreSQL adapter exists.
---

# ADR-0002 — SQLite, WAL, single writer, short transactions

## Governing principle

Playwright produces evidence. Deterministic software normalizes and measures evidence. DeepSeek interprets and prioritizes evidence. Humans authorize consequential transitions.

## Context

Frozen decision 2. The metadata store holds jobs, run records, lineage, approvals, the AI call
ledger, artifact refs, and statistics. Lineage and approvals are append-only and integrity-critical.
The store is read by CLI commands while a worker writes.

SQLite in its default rollback-journal mode blocks readers during a write, which would make
`investigate status` contend with an active batch. WAL mode allows concurrent readers with one
writer, which matches the access pattern exactly.

## Decision

- `journal_mode = WAL`. Non-WAL configuration is rejected at config load.
- `busy_timeout` configured, default 5000 ms, applied on every connection.
- One writer. `execution.workers` is asserted to be 1 in MVP; the reaper and CLI writes go through
  the same short-transaction discipline and rely on `busy_timeout` for the rare overlap.
- `foreign_keys = ON`, `synchronous = FULL` for durability of approvals and lineage.
- Every transaction is short. No transaction spans a browser action, a filesystem artifact write,
  an HTTP call, or a provider call. Artifact bytes are written and hashed outside the transaction;
  the `ArtifactRef` row is inserted afterwards.
- Job claiming uses `BEGIN IMMEDIATE` plus a `WHERE state='PENDING'` guard so the update is
  idempotent and two claimants cannot both win.
- Append-only tables (`lineage`, `approvals`, `ai_calls`, `run_manifests`) have `BEFORE UPDATE`
  and `BEFORE DELETE` triggers raising `STORE_APPEND_ONLY_VIOLATION`.
- Invariants that must never be violated live in `CHECK` constraints, not only in application code.
  The job-lifecycle-versus-run-outcome matrix is enforced this way.
- Migrations are numbered SQL files with a `schema_version` table. No migration framework.

## Why not an ORM

The correctness of this system rests on `CHECK` constraints, trigger-enforced append-only
semantics, and explicit transaction boundaries. Those are precisely what an ORM abstracts away.
Hand-written SQL over ten tables is readable and auditable; an ORM would make the invariants
invisible.

## Driver choice

Deferred to M1 with a documented probe: `node:sqlite` (built in, no native build) versus
`better-sqlite3` (mature, native). The requirement is clean support for WAL, `busy_timeout`,
`BEGIN IMMEDIATE`, triggers, and `CHECK` constraints. The choice is recorded as ADR-0021.
`MetadataStore` localises the consequence to one adapter file.

## Consequences

Positive: no daemon, durable, transactional, one file to back up, readers never blocked by the
writer, invariants enforced by the engine.

Negative: write parallelism is limited; a multi-worker future needs either careful queue sharding
or the PostgreSQL adapter. `STORE_BUSY` is a retryable error class rather than an impossibility,
and the queue treats a failed claim as "no work available" rather than an error.

## Consequence for the CLI

Long-running commands hold no long transaction, so `Ctrl+C` at any point leaves a consistent
database. The crash-consistency ordering in `docs/architecture/queue-model.md` depends on this.
