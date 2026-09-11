---
id: ADR-0018
title: Configurable retention with tombstones, preserving lineage and report-referenced artifacts
status: accepted
date: 2026-09-10
touches: [evidence, storage]
decision: Expire artifacts on a configurable schedule while never deleting manifests, lineage, approvals, or the AI call ledger; preserve reproducer packages and any artifact referenced by an approved finding in a rendered report; write a tombstone on every deletion; and require explicit confirmation.
consequences: Disk stays bounded without making past claims unexplainable, at the cost of a growing metadata store and tombstone handling in the report renderer.
---

# ADR-0018 — Retention with tombstones

## Governing principle

Playwright produces evidence. Deterministic software normalizes and measures evidence. DeepSeek interprets and prioritizes evidence. Humans authorize consequential transitions.

## Context

Video plus trace across a hundred runs is the main disk driver, and the M1 gate caps a
hundred-run batch at 1.5 GB. Several investigations later, a workspace is large. Deleting evidence
is therefore necessary. Deleting it carelessly destroys the property the product is built on:
that any claim can be re-verified against the evidence that produced it.

The subtle failure is not the deleted byte. It is a later reference-validation failure that looks
identical to fabrication. "This finding cites an artifact that does not exist" must be
distinguishable from "someone made this up".

## Decision

`investigate retention apply` deletes artifacts older than `retention.artifactDays` (default 30),
with four exemptions and one obligation.

Exemptions — never deleted:

1. Reproducer packages, when `retention.keepReproducers` is true (default).
2. Any artifact referenced by an approved finding in a rendered report.
3. Proposal and effective-proposal artifacts bound to an `ApprovalRecord`.
4. The intake report artifact.

Never deleted at all, regardless of age: run manifests, lineage records, approvals, the AI call
ledger, statistics. These are small, and they are the audit trail.

Obligation — every deletion writes a **tombstone** recording the artifact ID, kind, SHA-256,
byte length, run ID, redaction stamp, original store time, deletion time, and the retention policy
that caused it. Reference validation resolving to a tombstone returns a distinct
`REFERENCE_EXPIRED` result, not `REFERENCE_MISMATCH`, and the report renderer renders the citation
honestly as expired rather than omitting the claim. The hash in the tombstone means a restored
backup copy can still be verified against the original claim.

Safety:

- `--confirm` is required. The command refuses in `--json` mode without it.
- A dry run reports exactly what would be deleted, with sizes.
- Deletion is per artifact and idempotent; a partially completed run leaves a consistent state.

## Why not delete metadata too

Because the metadata is the explanation. A workspace that has expired its artifacts but kept its
lineage can still answer what was reported, what a human approved, what ran with which parameters,
what was concluded, and which now-expired artifact supported it. A workspace that expired its
lineage can answer nothing.

Metadata growth is bounded in practice: rows per investigation are in the thousands, not the
millions, and `docs/architecture/risks.md` records unbounded metadata growth as an accepted
low-severity cost rather than a solved problem.

## Alternatives considered

| Alternative | Why rejected |
| --- | --- |
| Delete whole investigations | Loses the audit trail wholesale; a cited claim becomes unexplainable |
| Silent deletion without tombstones | Expiry becomes indistinguishable from fabrication |
| Content-addressed garbage collection only | Deduplication already happens at write time; age-based expiry is what bounds disk |
| No retention at all | Disk exhaustion is a real operational failure mode (R12) |
| Automatic scheduled expiry | Deleting evidence without a human saying so contradicts the approval philosophy |

## Consequences

Positive: bounded disk; past claims remain explainable; expiry is visibly different from
fabrication; a restored backup is verifiable against the recorded hash.

Negative: the metadata store grows without bound; the report renderer must handle tombstoned
citations, which is an extra rendering path and an extra eval case (M7 negative case, M8-AT-10).
