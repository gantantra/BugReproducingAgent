---
id: ADR-0015
title: Versioned schemas with strict validation and unknown-field rejection for every persisted record
status: accepted
date: 2026-09-10
touches: [core, ai, evidence]
decision: Version every domain schema, validate every persisted record and every AI output strictly with additionalProperties false, reject unknown fields, and treat a config typo as an error rather than a warning.
consequences: Silent data-shape drift and silently ignored fields become impossible, at the cost of migration work whenever a schema evolves.
---

# ADR-0015 — Versioned schemas, strict validation

## Governing principle

Playwright produces evidence. Deterministic software normalizes and measures evidence. DeepSeek interprets and prioritizes evidence. Humans authorize consequential transitions.

## Context

Two distinct dangers. First, a persisted record whose shape drifts over months becomes
uninterpretable, and evidence that cannot be interpreted later is not evidence. Second, a lenient
validator silently ignores fields, which is how a model output containing a plausible-but-unknown
key gets accepted as if the key had been honoured, and how a typo in a safety config field
silently disables the safety field.

## Decision

Versioned schemas are required for: `Flow`, `Action`, `ExperimentProposal`, `RunManifest`,
`EvidenceEvent`, `CaptureStatus`, `FailureSignature`, `RunClassification`, `Finding` (with evidence
references), `LineageRecord`, `ApprovalRecord`, `ReproducerPackage`, `FinalReport`, `FlowArtifact`,
`ToolCall`, `ToolResult`, plus `Config`, `IntakeReport`, `RedactionPolicy`, `Statistic`, and the
per-flow input/output schemas.

Rules:

- Every schema declares `$id`, `$schema` (2020-12), and a `schemaVersion` property with a `const`
  value. Every object-typed subschema sets `additionalProperties: false`.
- Every persisted record is validated on write. A validation failure is an error, never a warning,
  and nothing partial is persisted.
- Every AI output is validated strictly, with unknown fields rejected, before reference validation.
- Config validation rejects unknown keys with a `USAGE` error. A misspelled `safety.allowedOrigins`
  must not become a silently absent allowlist.
- Version negotiation: a record whose `schemaVersion` is older than current is read through an
  explicit upgrade function or rejected with a clear message. There is no best-effort coercion.
- Breaking changes produce `v2` alongside `v1`. Both schemas remain in the repository so historical
  records stay interpretable, which is the entire point of versioning them.
- Enum vocabularies are bidirectionally checked against the documentation by the M0 doc checks
  (`CaptureStatus` categories, finding levels, tool names, error codes, job/outcome combinations),
  so prose and enforcement cannot drift apart.

## Where strictness is relaxed, and why not

There is exactly one place leniency is tempting: accepting an AI output with an extra field that
looks harmless. It is rejected because "harmless extra field" and "the model believed it was
setting a parameter we ignored" are indistinguishable from the outside, and the second case
produces a persisted record that does not mean what the model meant.

## Alternatives considered

| Alternative | Why rejected |
| --- | --- |
| Unversioned schemas | Old records become uninterpretable; the evidence claim collapses |
| Lenient validation with warnings | Warnings are not read; silently ignored fields cause exactly the failures this system exists to prevent |
| TypeScript types only | No runtime enforcement, no language-neutral contract, no provider structured-output schema |
| Coerce on version mismatch | Best-effort coercion invents data |

## Consequences

Positive: every persisted record is interpretable from its schema alone; unknown fields surface
immediately; config typos fail loudly; provider structured output and internal validation share
one source of truth (ADR-0020).

Negative: schema evolution requires migration work and keeping old versions around. Accepted as
the cost of long-lived evidence.
