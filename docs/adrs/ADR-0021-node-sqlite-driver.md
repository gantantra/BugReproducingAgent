---
id: ADR-0021
title: Use node:sqlite as the SQLite driver
status: accepted
date: 2026-09-11
touches: [storage, execution]
decision: Use the built-in node:sqlite DatabaseSync as the MetadataStore driver, after probing that it supports WAL, busy_timeout, synchronous FULL, foreign keys, CHECK constraints, BEFORE UPDATE/DELETE triggers with RAISE(ABORT), BEGIN IMMEDIATE with SQLITE_BUSY contention, partial indexes, and concurrent WAL readers.
consequences: Zero native dependencies and no build toolchain requirement, at the cost of a synchronous API and a module still marked experimental in the Node 24 line.
---

# ADR-0021 — node:sqlite as the driver

## Governing principle

Playwright produces evidence. Deterministic software normalizes and measures evidence. DeepSeek interprets and prioritizes evidence. Humans authorize consequential transitions.

## Context

ADR-0002 deferred the driver choice to an M1 probe: `node:sqlite` (built in, experimental) versus
`better-sqlite3` (mature, native, needs a build toolchain or prebuilds on Windows). The requirement
was clean support for everything the invariants depend on.

## Probe result

Run on Node v24.15.0 on the target Windows machine. All twelve requirements passed:

| Requirement | Result |
| --- | --- |
| `journal_mode=WAL` | `wal` |
| `busy_timeout` settable and readable | 5000 |
| `synchronous=FULL` | 2 |
| `foreign_keys=ON` | 1 |
| `CREATE TABLE` with multi-column `CHECK` | ok |
| `CHECK` rejects an illegal `(terminal_reason, run_outcome)` pair | rejected as required |
| `BEFORE UPDATE` / `BEFORE DELETE` triggers with `RAISE(ABORT, 'STORE_APPEND_ONLY_VIOLATION')` | update and delete both blocked, message preserved |
| `BEGIN IMMEDIATE` / `COMMIT` | ok |
| `ROLLBACK` discards | ok |
| Partial index (`WHERE state = 'PENDING'`) | ok |
| Second connection reads WAL data concurrently | reader sees committed rows |
| Second writer under `BEGIN IMMEDIATE` is blocked | `ERR_SQLITE_ERROR` (SQLITE_BUSY) |

The last two are the ones that mattered most: they are what make the claim semantics in ADR-0003
and the concurrent-reader benefit of WAL in ADR-0002 real rather than assumed.

## Decision

Use `node:sqlite`. `MetadataStore` continues to localise the choice to one adapter file, so
switching to `better-sqlite3` later is a contained change.

## Consequences

Positive: no native module, no node-gyp, no prebuild matrix, no install friction on Windows, and
one fewer dependency in a security-sensitive tool. Install for the whole repository now needs only
Playwright and dev tooling.

Negative: `node:sqlite` is still marked experimental in the Node 24 line, so a minor Node upgrade
could change behaviour. Mitigations: the twelve-point probe is committed as an integration test
(`packages/storage/test/driver-capabilities.test.ts`) and runs in CI, so a regression surfaces as a
named failure rather than as mysterious data corruption; and the Node version is pinned in
`package.json` `engines`.

Negative: the API is synchronous. The `MetadataStore` interface is async, so the adapter wraps
synchronous calls in resolved promises. This is honest for a single-writer embedded database and
keeps the interface portable to PostgreSQL, but it means a long query blocks the event loop. Every
query in the schema is indexed and bounded, and no transaction spans I/O (ADR-0002), so the
exposure is small. Recorded here rather than hidden.
