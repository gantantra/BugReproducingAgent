---
id: ADR-0008
title: Redaction before persistence, enforced at the type level and failing closed
status: accepted
date: 2026-09-10
touches: [evidence, ai, storage]
decision: Require a RedactionStamp parameter on every persistence and transmission entry point, treat a missing stamp as a typed error, classify unknown-shape data as sensitive by default, and add detection-only verification passes before provider transmission and before export.
consequences: Unredacted persistence becomes a compile-time impossibility rather than a review checklist item, at the cost of reduced diagnostic power on redacted categories and real work to redact traces.
---

# ADR-0008 — Redaction before persistence, fail closed

## Governing principle

Playwright produces evidence. Deterministic software normalizes and measures evidence. DeepSeek interprets and prioritizes evidence. Humans authorize consequential transitions.

## Context

Browser evidence is uniquely dangerous. A single trace can contain session cookies, bearer tokens,
authorization headers, OAuth codes in URLs, and response bodies full of personal data. The
investigation needs that evidence to be *comparable*, not to be *complete*.

A policy statement that says "redact before writing" is not a control. Every code path that writes
would have to remember, forever, under deadline.

## Decision

The boundary is stated once and enforced structurally:

Raw sensitive evidence may exist only in bounded process memory during collection and
transformation. It must be redacted before durable persistence, provider transmission, normalized
indexing, diagnostic logging, report generation, or any artifact export. Buffers are released after
processing. The agent disables its own crash-dump, heap-snapshot, and verbose-log paths that would
persist unredacted in-process data. OS-level paging and kernel mechanisms are documented as
residual risk in the security model.

Enforcement:

1. `ArtifactStore.put` and every `MetadataTx.insert*` take a required `RedactionStamp`. No overload
   omits it. A stamp-less call is `REDACTION_NOT_APPLIED` (exit 9).
2. `InvestigatorError.context` accepts only JSON primitives by type signature, closing the most
   common accidental-leak path.
3. The logger passes every field through the redactor. `logging.redactLogs: false` is rejected at
   config load; the flag exists only so that an attempt to disable it fails loudly.
4. `ai-gateway` accepts only `ToolResult` objects and flow-artifact prompt text. A test asserts no
   code path passes an artifact stream or a raw event into an `LlmRequest`.
5. **Strict by default.** `mode: strict` treats any field the policy cannot classify as sensitive.
   `permissive` is permitted only for `fixture` targets and rejected at config load otherwise.
6. Two **detection-only** verification passes: over the serialized `ToolResult` before dispatch,
   and over every artifact before export. A hit is an error, never a silent fix, because a hit
   means an earlier stage has a bug.
7. Collection-time redaction handles rules decidable per-event without whole-run context, so the
   highest-risk values never reach a buffer that outlives the event.

## Trace disposition

Traces are the hardest case because the format is packed and not fully field-addressable. Three
dispositions: `redacted-pipeline` (unpack, redact, repack, drop what is not addressable),
`withhold` (collect for in-process analysis, do not persist, mark `captureStatus.trace =
"redacted"`), and `raw-opt-in` (permitted only for `fixture` targets, recorded in every manifest as
`unsafeTrace: true`). Open question Q11 selects the M1 default; the recommendation is `withhold`
for M1 with the pipeline built in M8.

## Priced-in consequence

Redaction reduces diagnostic power, and that reduction is made visible rather than hidden:
`redacted` is a first-class `CaptureStatus` value, and a finding depending on a `redacted`,
`partial`, `unsupported`, `disabled`, or `corrupted` category for any cited run is capped at
`correlated`. The system cannot claim a strong causal relationship on evidence it cannot show.

`hash-value` and shape descriptors preserve *comparability* without disclosure: two runs can be
shown to differ in a value without either value being revealed.

## Alternatives considered

| Alternative | Why rejected |
| --- | --- |
| Redact on read/export only | Unredacted data at rest; a stolen or copied workspace leaks |
| Optional stamp with a lint rule | Makes the central invariant depend on discipline |
| Allowlist-only capture (capture nothing unless named) | Loses the unknown-unknown evidence that intermittent investigation depends on |
| Permissive default with rules for known secrets | Any novel field leaks until someone notices |

## Consequences

Positive: unredacted persistence is structurally impossible; residue is detected at two further
boundaries; the diagnostic cost is explicit in the level ladder rather than silent.

Negative: real implementation cost for traces; genuine loss of analytic power on sensitive
payloads; and pattern-based redaction cannot recognise a novel secret format, which strict mode
mitigates but does not eliminate.
