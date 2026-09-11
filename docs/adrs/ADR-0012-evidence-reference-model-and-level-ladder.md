---
id: ADR-0012
title: Evidence reference model, seven-check validation, and a deterministic level ladder
status: accepted
date: 2026-09-10
touches: [ai, evidence]
decision: Require every analytical claim to carry validated evidence references; validate existence, ownership, type validity, field presence and exact match; gate the finding level ladder on deterministic evidence requirements with automatic demotion; hard-fail confirmed_root_cause without approved direct evidence; and treat model confidence as never load-bearing.
consequences: Fabricated and over-leveled claims cannot be persisted, and confirmed_root_cause is unreachable in MVP, at the cost of requiring the model to cite exact fields and values.
---

# ADR-0012 — Evidence reference model and level ladder

## Governing principle

Playwright produces evidence. Deterministic software normalizes and measures evidence. DeepSeek interprets and prioritizes evidence. Humans authorize consequential transitions.

## Context

The failure mode that would destroy this product is a fluent, well-cited, wrong root cause. Two
sub-failures produce it: references to evidence that does not exist or does not say what the claim
says, and a claim level unsupported by the evidence that does exist.

Neither can be prevented by prompting. Both can be checked mechanically.

## Decision

### Every claim carries references

```json
{ "findingId": "FIND-14", "level": "correlated", "statement": "...",
  "supportingEvidence": [ { "kind": "event", "runId": "RUN-17", "eventIds": ["EV-122"],
                            "artifactIds": ["TRACE-17"], "field": "/response/status",
                            "expectedValue": 503 } ],
  "contradictingEvidence": [], "confidence": 0.89 }
```

`contradictingEvidence` is required to be present, possibly empty, and is validated identically.

### Seven checks

1. Investigation exists. 2. Run belongs to the investigation. 3. Event belongs to the run.
4. Artifact exists (row **and** `head` succeeds). 5. Artifact type is valid for the claim category,
per a fixed table. 6. The cited `field` (a JSON Pointer) resolves and, when `expectedValue` is
present, matches **exactly** — strict deep equality, no coercion, no tolerance. 7. The resolved
value is not a redaction placeholder and the source category is not `missing` or `corrupted`.

Check 6 is the load-bearing anti-fabrication mechanism. Findings at `probable_trigger` and above
must include at least one reference with `field` and `expectedValue`; a purely existential citation
cannot support a causal-flavoured claim.

MVP scope for semantic validation is existence, ownership, type validity, field presence and match.
Free-form semantic entailment is explicitly out of scope (frozen decision 5). A validly cited fact
can still be irrelevant to the sentence built around it, which is why gates 2 and 3 exist.

### The ladder

`observed`, `correlated`, `probable_trigger`, `high_confidence_trigger`, `confirmed_trigger`,
`root_cause_hypothesis`, `confirmed_root_cause`, each with a deterministic minimum-evidence
requirement documented in `docs/architecture/evidence-reference-model.md`.

- **Demotion, not rejection**, wherever the lower level is fully supported, with the demotion
  recorded as a warning. Silent rejection would hide overreach; silent acceptance would launder it.
- A finding whose cited evidence depends on a category that is `partial`, `redacted`,
  `unsupported`, `disabled`, or `corrupted` for any cited run is **capped at `correlated`**.
- `confirmed_root_cause` is the sole hard failure: `AI_CLAIM_UNSUPPORTED`, nothing persisted.

### Confirmed root cause

Requires at least one `directEvidence` reference whose `approvalId` resolves to an
`ApprovalRecord` of type `direct_evidence_attestation`, checksum-bound to the referenced artifact:
human-approved source-code evidence, instrumented state demonstrating the faulty transition, an
approved engineering diagnosis, or a controlled experiment proving the asserted mechanism.

The MVP deliberately ships **no command that mints that approval type**, so
`confirmed_root_cause` is unreachable and the report says so explicitly. A passing control supports
a trigger hypothesis, not a root-cause claim, and a `confirmed_root_cause` justified solely by a
passing control is an eval fixture that must fail.

### Confidence is never a gate

`confidence` is recorded and displayed, never used to promote or block. Self-reported confidence is
uncalibrated. As an internal-consistency check, `confidence > 0.95` on a finding at `correlated`
or below is rejected.

## Consequences

Positive: fabricated references and over-leveled claims cannot reach persistence; the honest
ceiling of the MVP is visible in its own output; reviewers can verify a claim by reading one field.

Negative: the model must cite precisely, which costs tokens and occasionally costs a valid finding
that was expressed too loosely. Accepted, because the alternative is a system whose output cannot
be trusted without redoing the work.
