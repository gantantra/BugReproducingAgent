---
id: ADR-0013
title: File-based, SHA-256 checksum-bound approvals with no auto-approval path
status: accepted
date: 2026-09-10
touches: [approvals, execution, ai]
decision: Implement the three gates as file-based approvals bound by SHA-256 to canonical proposal bytes, validated by nine checks including a bounded per-gate edit surface, recorded as immutable records, with no flag, config value, or environment variable that can grant an approval.
consequences: Human authorization is auditable, replayable, and impossible to bypass, at the cost of an edit-a-YAML-file workflow rather than an interactive prompt.
---

# ADR-0013 — File-based checksum-bound approvals

## Governing principle

Playwright produces evidence. Deterministic software normalizes and measures evidence. DeepSeek interprets and prioritizes evidence. Humans authorize consequential transitions.

## Context

Frozen decision 4. Three transitions are consequential enough to require a human:
which experiments run, which failure is being chased, and whether the minimized reproduction is
the deliverable. Interactive prompts are convenient and unauditable: nothing durable records what
was shown, what was chosen, or what was changed.

## Decision

Approvals are file-based and checksum-bound to the proposal. No silent auto-approval.

- Each gate proposal is written as a triple: canonical `.json` (sorted keys, two-space indent, LF,
  UTF-8 without BOM, trailing newline), a `.sha256`, and a generated human-readable `.md`. Only
  the `.json` bytes are the checksum subject, so regenerating the markdown is safe.
- The proposal is also stored via `ArtifactStore`, so a later on-disk edit is detectable as
  `GATE_PROPOSAL_STALE`.
- The human writes (or `--scaffold` pre-fills) a YAML approval file declaring the gate, the
  investigation, the `proposalChecksum`, the decision, the approver, `approvedItemIds`, `edits`
  with `from`/`to`/`rationale`, and `safetyAcknowledgements`.
- `investigate approve <gate> --from <file> --checksum <sha256>` runs nine checks before any state
  change: schema validity; flag checksum equals the on-disk proposal hash; the file agrees with the
  flag; the stored `ArtifactRef` hash still matches; the gate is `AWAITING_APPROVAL` for that
  checksum; every referenced ID exists and belongs to this investigation; every edit is inside the
  gate edit surface and its `from` matches the current value; every deterministically-classified
  destructive action is acknowledged with a justification; and `decidedAt` plus expiry are sane.

Requiring the checksum in **both** the flag and the file is deliberate: it means neither a stale
shell-history command nor a stale file can approve the wrong thing on its own.

- On success, one short transaction writes an immutable `ApprovalRecord`, stores the post-edit
  **effective proposal** as its own artifact, appends a lineage edge, and transitions the gate.
  Execution consumes the effective proposal, and every run manifest records `approvalId` and
  `effectiveProposalChecksum`.
- Partial approval is an approval whose scope is a subset (`approvedItemIds`), not a separate state.
- `request_changes` is recorded as a rejection carrying `requestedChanges`, which the next `plan`
  or `minimize` reads as input, so human intent lives in lineage rather than in a chat log.

## Bounded edit surface

Each gate permits specific paths. Gate 2 is the instructive case: a human may correct the
**predicate** defining the target failure, but may not alter a recorded `RunOutcome` or a
fingerprint. Correcting what we are chasing is judgement; rewriting what was observed is
falsification.

## No bypass

There is no `--yes`, `--force-approve`, `approvals.autoApprove`, or environment variable. The
loader rejects `approvals.required` with fewer than three gates. A test asserts no code path
outside the `approve` handler constructs an `ApprovalRecord`. Non-interactive automation is
supported the only safe way: a human commits an approval file and CI runs `approve` against it,
and the checksum binding means that file approves exactly one proposal.

## Alternatives considered

| Alternative | Why rejected |
| --- | --- |
| Interactive terminal prompts | Not auditable, not replayable, not reviewable in a PR |
| Web UI approval | Contradicts ADR-0001 for MVP; may be added later over the same records |
| Approval by ID without a checksum | A re-planned proposal under the same ID would inherit an old approval |
| Signed approvals (GPG) | Real value for multi-user trust; unnecessary for a single-user local tool, and recorded as a post-MVP option |

## Consequences

Positive: every consequential transition has a durable, diffable, checksum-bound record naming the
approver, the scope, the edits, and the rationale; approvals are reviewable in version control; the
bypass surface is empty.

Negative: editing YAML is more friction than pressing `y`. Mitigated by `--scaffold` and by the
CLI printing the exact next command at every step. Rubber-stamping remains an organisational risk
that no mechanism here can eliminate.
