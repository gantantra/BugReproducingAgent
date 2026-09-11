---
id: ADR-0004
title: Local filesystem artifact store, content-hashed and immutable, with a mandatory redaction stamp
status: accepted
date: 2026-09-10
touches: [evidence, storage]
decision: Store artifacts on the local filesystem as immutable, SHA-256 content-hashed files whose store API requires a RedactionStamp parameter, computes the hash itself, and offers no update path.
consequences: Tamper-evident, verifiable evidence with a type-level guarantee that nothing is persisted unredacted, at the cost of no remote sharing until the S3 adapter exists.
---

# ADR-0004 — Local artifact store, content-hashed, redaction-stamped

## Governing principle

Playwright produces evidence. Deterministic software normalizes and measures evidence. DeepSeek interprets and prioritizes evidence. Humans authorize consequential transitions.

## Context

Artifacts are the evidence: traces, video, screenshots, DOM snapshots, network logs, console logs,
storage snapshots, proposals, reports, reproducer packages. Every analytical claim eventually
points at one. Three properties matter more than anything else about how they are stored:

1. They must be verifiable later, offline, by someone who was not present.
2. They must be immutable, so a claim cannot be retroactively re-justified.
3. They must never contain unredacted secrets or PII.

## Decision

`ArtifactStore.put` takes `{ investigationId, runId?, kind, filename, bytes, contentType,
redactionApplied: RedactionStamp }` and returns an `ArtifactRef` containing the store-computed
`sha256`, `byteLength`, and `storedAt`.

- **The store computes the hash.** A caller-supplied hash is rejected. This removes the class of
  bug where a wrong hash is recorded alongside correct bytes.
- **`redactionApplied` is required, not optional.** There is no overload without it. A persistence
  attempt without a stamp raises `REDACTION_NOT_APPLIED` (exit 9). This is the type-level form of
  the redaction boundary, and it is what makes "fail closed" more than an aspiration.
- **Artifacts are immutable.** There is no `update`. Deletion exists only through the retention
  command, which writes a tombstone (ADR-0018).
- `head` returns the ref without bytes; `verify` recomputes the hash and reports the observed value;
  `get` returns a stream.
- Access is by opaque `ArtifactRef`, never by filesystem path, so the S3 adapter is a drop-in.

## Layout

```
.investigator/investigations/INV-001/artifacts/<kind>/<sha256[0:2]>/<sha256>.<ext>
```

Content-addressed with a two-character shard prefix. Identical bytes across runs are stored once
and referenced twice, which matters when 100 runs produce identical fixture screenshots. The
`ArtifactRef` carries the logical `filename` and `runId`, so deduplication does not lose provenance.

## Integrity

- Every manifest records the digest list of its artifacts, and the manifest seal hash covers that
  list. Corrupting an artifact is detected by `verify`; corrupting the digest list is detected by
  the seal.
- `investigate revalidate` and `investigate export` re-verify every referenced artifact.
- `artifact_integrity_hashes.spec.ts` asserts detection of a single corrupted byte and of a
  tampered manifest field.

This is detection, not prevention. A local user who can write the workspace can rewrite bytes and
hashes consistently. Stated as residual risk in `docs/security/security-model.md`.

## Alternatives considered

| Alternative | Why rejected |
| --- | --- |
| Store artifacts as BLOBs in SQLite | Bloats the database, complicates backup, makes video streaming awkward, and couples artifact lifetime to metadata lifetime |
| Path-based API | Leaks filesystem assumptions into every caller and blocks the S3 adapter |
| Optional redaction stamp | Makes the most important invariant in the system a matter of caller discipline |
| Mutable artifacts | Would allow a claim to be re-justified after the fact |

## Consequences

Positive: verifiable, deduplicated, immutable, streamable, trivially backed up, and unredacted
persistence is a compile-time impossibility rather than a review checklist item.

Negative: no sharing beyond copying the directory or running `investigate export`. Disk is the
binding constraint at scale, which is why the M1 gate asserts a disk-growth ceiling and why
`video: on-failure` is the default.
