---
id: ADR-0001
title: Standalone local CLI MVP with no external infrastructure
status: accepted
date: 2026-09-10
touches: [execution, evidence, storage, ai]
decision: Ship the MVP as a local CLI agent requiring only Node.js, Chromium, a DeepSeek API key, and local disk. Implement PostgreSQL, S3/MinIO, Redis/BullMQ, central secret management, and distributed workers as designed-but-unimplemented adapters behind four interfaces.
consequences: Zero-ops adoption and a fast path to the first real investigation, at the cost of single-machine throughput and single-user access control.
---

# ADR-0001 — Standalone local CLI MVP

## Governing principle

Playwright produces evidence. Deterministic software normalizes and measures evidence. DeepSeek interprets and prioritizes evidence. Humans authorize consequential transitions.

## Context

The product needs to run many browser experiments and reason over the evidence. The obvious
architecture is a service: PostgreSQL for metadata, S3 for artifacts, Redis for a queue,
Kubernetes for browser workers. That architecture is correct at scale and wrong at the start: it
puts weeks of infrastructure between the team and the first answered question, and none of it is
what makes the product trustworthy.

What makes the product trustworthy is deterministic evidence, explicit completeness, validated
references, and human gates. None of those require a distributed system.

## Decision

The initial product runs as a local CLI agent without PostgreSQL, Redis, S3, MinIO, Kubernetes, or
a separate API service.

Required runtime: Node.js, Chrome or bundled Chromium, DeepSeek API key, local disk.

Storage and orchestration sit behind four interfaces — `MetadataStore`, `ArtifactStore`,
`WorkQueue`, `SecretStore` — with these initial adapters:

- SQLite metadata and lineage storage (WAL mode, single writer, configured busy timeout, short transactions)
- Local filesystem artifact storage
- SQLite-backed durable job table
- Environment-variable secret access
- One local Playwright worker with bounded concurrency

Designed but not implemented: PostgreSQL, S3 or MinIO, BullMQ and Redis, central secret manager,
distributed browser workers.

## Interface discipline

The interfaces are authored with both adapters in mind. SQLite-only semantics must not leak:

- IDs are application-generated. No `last_insert_rowid()` in any signature.
- Ordering is by explicit monotonic sequence columns, never implicit rowid order.
- Claim semantics are expressed so that `BEGIN IMMEDIATE` (SQLite) and `SELECT ... FOR UPDATE SKIP
  LOCKED` (PostgreSQL) are both valid implementations.
- Artifact access is by opaque `ArtifactRef`, not by filesystem path.
- No interface method assumes synchronous execution or a single process.

## Alternatives considered

| Alternative | Why rejected |
| --- | --- |
| Full service architecture from day one | Weeks of infrastructure before the first investigation; none of it addresses the trust problem |
| Docker Compose bundle (Postgres + Redis + MinIO) | Still an ops burden for a single-user tool, and hides the interface discipline that makes the migration cheap later |
| No interfaces, direct SQLite calls | Cheaper now, but the migration would then touch every package instead of four adapters |

## Consequences

Positive: one command to start; no daemons; every command works offline except the AI flows; CI
needs no services; the whole workspace is a directory a developer can zip and send.

Negative: throughput is bounded by one machine and, in MVP, one worker. Rare defects requiring
thousands of runs are out of reach. There is no access control beyond OS file permissions, which
is why `docs/security/security-model.md` states artifact access as local-user only.

## Status of the deferred adapters

Deferred means designed and unimplemented, not forgotten. `storage.metadata: postgres`,
`storage.artifacts: s3`, and `storage.queue: redis` are rejected at config load with an explicit
message naming this ADR, rather than failing obscurely.
