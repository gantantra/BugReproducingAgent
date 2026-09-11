---
adr: 0026
title: Gate proposal bundles, the report.body redaction scope, and an injected destructive classifier
status: accepted
date: 2026-09-11
touches: [approvals, evidence, execution]
supersedes: none
---

# ADR-0026 — Gate proposal bundles, the `report.body` scope, and an injected destructive classifier

## Governing principle

Playwright produces evidence. Deterministic software normalizes and measures evidence. DeepSeek interprets and prioritizes evidence. Humans authorize consequential transitions.

## Context

M2 implements the three approval gates. Three decisions were needed that the frozen M0 artifacts
did not settle, and each is small enough to be tempting to make silently. They are recorded here
because each one moves a boundary that the approval mechanism depends on.

## Decision 1 — a gate proposal is a BUNDLE, with its own versioned schema

`schemas/experiment-proposal.v1.json` describes exactly one experiment. A gate-1 decision is over
a SET: the approval file's `approvedItemIds` exists precisely so a human can approve two of five.
There was no schema for the document a human actually reads.

`schemas/gate-proposal.v1.json` is that document: `{ gate, investigationId, renderedAt, items[] }`,
where each item carries an `itemId` and the gate-appropriate payload. All three gates use it, so
the checksum, approval, edit-surface and effective-proposal machinery is written once rather than
three times.

Consequences:

- The canonical bytes of the bundle are the checksum subject. One document, one checksum, one
  decision.
- Gate-specific shapes (`signature` and `clusters` for gate 2, `sequence` and `control` for gate 3)
  live as optional properties on the item rather than as separate schemas. Every object subschema
  closes `additionalProperties`, so a typo in a safety field is rejected rather than ignored
  (ADR-0015).
- `experiment-proposal.v1.json` is untouched and still describes a single proposal.

## Decision 2 — `report.body` is a redaction scope

`investigate intake` stores a human's bug report as a durable artifact. `FieldScope` had no scope
covering free text a person wrote, so the report would have been persisted unredacted.

That would have been a real hole, and a quiet one. Bug reports routinely contain a session id, a
signed URL, or a customer name pasted from a console — the report is often the FIRST place a
secret enters the system, before any browser has run. ADR-0008 says raw sensitive evidence must be
redacted before durable persistence; it does not exempt text merely because a person typed it
rather than a collector capturing it.

`report.body` is added to `FieldScope`, to `common.v1.json`'s `fieldScope` enum, and to the nine
generic free-text rules in `policies/default.yaml` (high-entropy strings, JWTs, bearer tokens,
AWS-shaped keys, query secrets, e-mail, phone, card and PAN patterns).

## Decision 3 — the destructive classifier is INJECTED into `@investigator/approvals`

Approval check 8 requires every destructive action in an approved item to carry an
acknowledgement. That needs the deterministic classifier, which lives in `@investigator/execution`.

Importing it would make the approvals package depend on the executor, so evaluating an approval
would transitively pull in Playwright. The gate would then sit downstream of the thing it exists
to guard.

Instead `validateApproval` takes `classifyDestructive: (item) => string[]`. The CLI — which
legitimately depends on everything — wires the real classifier in. Asserted by
`tests/docs/approval-authority.spec.ts`: `packages/approvals` may not import
`@investigator/execution` or `playwright`, and `packages/execution` may not import
`@investigator/approvals`.

Enforcement is not weakened by the indirection: `enqueueExperiment` independently refuses a
destructive action without an acknowledgement, so a job cannot be scheduled merely because some
earlier step believed it was approved.

## Alternatives rejected

| Alternative | Why rejected |
| --- | --- |
| Reuse `experiment-proposal.v1.json` and wrap it in an untyped array | The bundle is the checksum subject and the thing `approvedItemIds` refers into. An untyped envelope would leave the most security-relevant document in the system unvalidated |
| Store the intake report unredacted, "because a human wrote it" | The report is frequently where a secret first enters. Authorship is not a property that makes bytes safe |
| Import the classifier into `approvals` | Puts the executor upstream of its own gate |
| Drop check 8 and rely on enqueue alone | Approval is where a human is present to accept the side effect; discovering it at enqueue time means the decision was never actually put to them |
