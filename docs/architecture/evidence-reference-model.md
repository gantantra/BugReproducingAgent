# Evidence Reference Model and Root-Cause Vocabulary

Status: M0 frozen candidate (frozen decision 5)
Schema: `schemas/finding.v1.json`

## Governing principle

Playwright produces evidence. Deterministic software normalizes and measures evidence. DeepSeek interprets and prioritizes evidence. Humans authorize consequential transitions.

## Every analytical claim

```json
{
  "findingId": "FIND-14",
  "level": "correlated_difference",
  "statement": "...",
  "supportingEvidence": [
    { "runId": "RUN-17", "eventIds": ["EV-122"], "artifactIds": ["TRACE-17"] }
  ],
  "contradictingEvidence": [],
  "confidence": 0.89
}
```

Note on `level`: the brief shows the illustrative value `correlated_difference` in the example and
the canonical ladder below in the vocabulary section. The schema accepts **only** the canonical
ladder values. `correlated_difference` is treated as a display label for `correlated`, mapped by a
fixed table in the renderer. Recorded in `docs/FREEZE-M0.md` as a resolved inconsistency.

## The level ladder

| Level | What it asserts | Minimum evidence to be allowed |
| --- | --- | --- |
| `observed` | A specific thing happened in a specific run | >= 1 supporting reference in >= 1 run |
| `correlated` | A difference co-occurs with the failure across runs | References in >= 2 runs spanning >= 1 failing and >= 1 passing run, or >= 2 failing runs sharing a fingerprint |
| `probable_trigger` | Removing or altering X plausibly changes failure incidence | `correlated` plus a frequency statistic with n >= `minRunsForRate` (default 10) and non-overlapping Wilson intervals between groups |
| `high_confidence_trigger` | The relationship survives a controlled comparison | `probable_trigger` plus a matched control run set differing only in the asserted factor |
| `confirmed_trigger` | An approved, revalidated reproduction toggles the failure | `high_confidence_trigger` plus an approved gate-3 reproduction **and** a passing control, both revalidated at the configured repetition count |
| `root_cause_hypothesis` | A mechanism is proposed that would explain the trigger | `confirmed_trigger` or `high_confidence_trigger` plus an explicit mechanism statement. Always labelled a hypothesis |
| `confirmed_root_cause` | The mechanism is established | Approved direct evidence. See below. Hard-fail otherwise |

Levels are monotone in evidence: a claim may always be *demoted*. The deterministic validator
demotes rather than rejects wherever the lower level is fully supported, and records the demotion
as a warning on the finding. Only `confirmed_root_cause` is a hard failure, because silently
demoting a root-cause claim to a hypothesis would hide that the model overreached.

## Confirmed root cause

Hard fail if the model claims `confirmed_root_cause` without approved direct evidence:

- source-code evidence approved by a human,
- instrumented state demonstrating the faulty transition,
- approved engineering diagnosis,
- or a controlled experiment proving the asserted mechanism.

Mechanically: a `confirmed_root_cause` finding must carry at least one reference of kind
`directEvidence` whose `approvalId` resolves to an `ApprovalRecord` of type
`direct_evidence_attestation` that is checksum-bound to the referenced artifact. The MVP does not
have a CLI command that mints that approval type, which means **the MVP can never emit
`confirmed_root_cause`**. That is intentional and is stated in the report template. Adding the
command is a post-MVP decision requiring an ADR.

Violation raises `AI_CLAIM_UNSUPPORTED` (exit 4). The finding is not persisted.

A passing control supports a trigger hypothesis, not a root-cause claim. The validator explicitly
rejects a `confirmed_root_cause` justified solely by a passing control, and this case is an eval
fixture (`eval/datasets/analyze/negative/root-cause-from-control.json`).

## Reference kinds

```ts
type EvidenceReference =
  | { kind: "event";      runId: RunId; eventIds: EventId[]; artifactIds?: ArtifactId[];
      field?: string; expectedValue?: JsonPrimitive }
  | { kind: "artifact";   runId: RunId; artifactIds: ArtifactId[] }
  | { kind: "statistic";  investigationId: InvestigationId; statisticId: StatisticId;
      field?: string; expectedValue?: JsonPrimitive }
  | { kind: "comparison"; comparisonId: ComparisonId; runIdsA: RunId[]; runIdsB: RunId[] }
  | { kind: "approval";   approvalId: ApprovalId }
  | { kind: "directEvidence"; artifactIds: ArtifactId[]; approvalId: ApprovalId };
```

## Reference validation

Reference validation confirms:

1. the investigation exists,
2. the run belongs to the investigation,
3. the event belongs to the run,
4. the artifact exists,
5. the artifact type is valid for the claim,
6. the cited field exists and matches,
7. no reference to redacted or inaccessible content.

MVP scope for semantic validation: existence, ownership, type validity, field presence and match.
Free-form entailment is out of scope.

### Check-by-check mechanics

| # | Check | Implementation |
| --- | --- | --- |
| 1 | Investigation exists | `MetadataStore` lookup |
| 2 | Run ownership | `runs.investigation_id` equals the claim scope |
| 3 | Event ownership | `EV-nnn` is scoped per run; the index lookup `(runId, eventId)` must resolve |
| 4 | Artifact exists | `artifact_refs` row exists **and** `ArtifactStore.head` succeeds |
| 5 | Type validity | Table below |
| 6 | Field presence and exact match | `field` is a JSON Pointer into the normalized event or statistic payload. It must resolve, and if `expectedValue` is present it must be *exactly* equal (strict deep equality on primitives, no coercion, no tolerance) |
| 7 | Redaction and accessibility | The resolved value must not be a redaction placeholder, and the source category must not be `missing`/`corrupted` for that run |

Check 6 is the load-bearing anti-fabrication mechanism. A model that says "RUN-17 returned HTTP
503" must cite `field: "/response/status"`, `expectedValue: 503`, and the validator reads the
actual normalized event and compares. A wrong number is `AI_REFERENCE_MISMATCH`, not a warning.

Findings at `probable_trigger` and above **must** include at least one reference with `field` and
`expectedValue`. A purely existential citation is insufficient to support a causal-flavoured claim.

### Artifact-type validity table (check 5)

| Claim category | Allowed artifact kinds |
| --- | --- |
| network timing / status | `network-log`, `trace` |
| console / exception | `console-log`, `trace` |
| DOM state | `dom-snapshot`, `screenshot`, `trace` |
| storage state | `storage-snapshot` |
| navigation | `network-log`, `trace` |
| visual appearance | `screenshot`, `video` |
| frequency statistic | `statistics` |
| reproduction behaviour | `reproducer-package`, `run-manifest` |

Citing a `video` for an HTTP status, or a `screenshot` for a request duration, is a type error.

## Confidence

`confidence` is a number in `[0, 1]` the model supplies. It is recorded, displayed, and **never
used as a gate**. Gates are the level ladder plus deterministic evidence checks. A confidence of
0.99 does not promote a level, and a confidence of 0.4 does not block one. Rationale: self-reported
confidence is not calibrated and must not be load-bearing.

The validator additionally rejects `confidence > 0.95` on any finding at `correlated` or below, as
an internal-consistency check on the model output.

## Contradicting evidence

`contradictingEvidence` is required to be present (possibly empty) and is reference-validated
identically. Flows that compare pass and fail are instructed to populate it. A finding at
`high_confidence_trigger` or above with a non-empty `contradictingEvidence` array is demoted one
level unless the finding also carries a `contradictionResolution` string, which the report renders
verbatim.

## Persistence

No AI output is persisted if it fails schema or reference validation. Findings are written in one
short transaction per flow result, all-or-nothing for `complete` results, and per-unit for
`partial` results where each unit is independently validated.
