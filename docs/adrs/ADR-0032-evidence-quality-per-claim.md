---
id: ADR-0032
title: An internal evidence-quality record per batch, and a finding withheld only when its own evidence was incomplete
status: accepted
date: 2026-09-21
touches: [evidence, cli, web]
decision: Summarise every run's CaptureStatus into one `evidence-quality` record per batch, with a fixed table from `claimCategory` to the evidence categories each claim needs; withhold a finding only when a category its claim needs was not complete in a run it cites.
consequences: Incomplete evidence limits exactly the claims it could have supported and nothing else; the record is never shown unless it withholds a finding, and then as one plain line.
---

# ADR-0032 — Evidence quality, per claim

## Governing principle

Playwright produces evidence. Deterministic software normalizes and measures evidence. DeepSeek interprets and prioritizes evidence. Humans authorize consequential transitions.

## Context

ADR-0016 gives every run a CaptureStatus, so a missing category is never mistaken for an absent signal. Across a batch, the question an analysis needs answered is narrower: can this particular claim be vouched for? Blocking a whole analysis because, say, WebSocket frames were unsupported would throw away findings that never depended on them.

## Decision

`buildEvidenceQuality` (packages/evidence) is a pure function of the batch's capture statuses. The record holds:
- per category, how many runs had each status, and the reason codes
- per run, the status of every category a claim can rest on
- the requirements table

The requirements table is keyed by the `claimCategory` values `analyze_failures` already declares:

| Claim | Needs complete |
|---|---|
| network | networkMetadata |
| console | console |
| exception | exceptions |
| dom | domSnapshots |
| storage | storage |
| navigation | navigation |
| timing | networkMetadata, navigation |

After the flow's own reference validation, `analyze` checks each finding: for its claim category and the runs it cites, anything not `complete` withholds **that finding alone**. The finding moves to `withheldFindings` with the internal reason `EVIDENCE_INCOMPLETE_FOR_CLAIM`. A finding with no claim category, or on complete evidence, is untouched. A cited run the record does not know counts as incomplete.

The record never blocks a batch. The page shows nothing about evidence quality unless a finding was withheld, and then only one plain line.

## Consequences

- New schema `evidence-quality.v1.json` and artifact kind `evidence-quality`.
- Measured runs have no quality record, so their analysis is unchanged.
- Tests:
  - `packages/evidence/src/evidence-quality.spec.ts`
  - `apps/cli/src/commands/analyze-withhold.spec.ts`
