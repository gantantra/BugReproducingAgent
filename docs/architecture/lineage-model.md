# Lineage Model

Status: M0 frozen candidate
Package: `packages/lineage`
Schema: `schemas/lineage-record.v1.json`

## Governing principle

Playwright produces evidence. Deterministic software normalizes and measures evidence. DeepSeek interprets and prioritizes evidence. Humans authorize consequential transitions.

## The chain to preserve

```
user-reported flow
  -> agent interpretation
  -> proposed experiment
  -> user-approved experiment
  -> executed run
  -> approved failure signature
  -> minimized candidate
  -> validated reproduction
  -> generated static test
  -> final issue report
```

## Node types

| Node kind | ID prefix | Created by |
| --- | --- | --- |
| `intake_report` | `RPT-` | `investigate intake` (the raw human file, stored as an artifact) |
| `flow` | `FLOW-` | `intake_to_flow` |
| `experiment_proposal` | `EXP-` | `propose_experiments` |
| `approved_experiment` | `AEXP-` | gate 1 approval (the effective post-edit proposal) |
| `job` | `JOB-` | `investigate run` |
| `run` | `RUN-` | executor (run manifest) |
| `failure_signature` | `SIG-` | deterministic extractor (candidate) |
| `approved_failure_signature` | `ASIG-` | gate 2 approval |
| `run_classification` | `CLS-` | `classify_runs` |
| `finding` | `FIND-` | `analyze_pass_fail` |
| `minimization_candidate` | `MIN-` | `suggest_minimization` |
| `validated_reproduction` | `REPRO-` | `investigate revalidate` |
| `approved_reproduction` | `AREPRO-` | gate 3 approval |
| `static_test` | `TEST-` | `investigate suite generate` / reproducer packaging |
| `report` | `RPTOUT-` | `generate_report` |
| `approval` | `APPR-` | `investigate approve` |
| `ai_call` | `AIC-` | `ai-gateway` |
| `artifact` | `ART-`, plus kind-specific aliases such as `TRACE-` | `ArtifactStore` |
| `statistic` | `STAT-` | deterministic frequency computation |

## Edge types

| Edge | From -> To | Meaning |
| --- | --- | --- |
| `interpreted_as` | `intake_report` -> `flow` | AI interpretation |
| `proposed_from` | `flow` -> `experiment_proposal` | AI proposal |
| `approved_as` | `experiment_proposal` -> `approved_experiment` | Human gate 1 |
| `scheduled_as` | `approved_experiment` -> `job` | Deterministic enqueue |
| `executed_as` | `job` -> `run` | Deterministic execution |
| `retry_of` | `job` -> `job` | New attempt linked to the prior attempt |
| `extracted_signature` | `run` -> `failure_signature` | Deterministic extraction |
| `classified_as` | `run` -> `run_classification` | AI classification |
| `approved_signature` | `failure_signature` -> `approved_failure_signature` | Human gate 2 |
| `derived_finding` | `run`* -> `finding` | AI analysis, many-to-one |
| `supported_by` | `finding` -> `run`/`artifact`/`statistic`/`approval` | Evidence reference |
| `contradicted_by` | `finding` -> same targets | Contradicting reference |
| `proposed_reduction` | `approved_experiment` -> `minimization_candidate` | AI minimization |
| `validated_as` | `minimization_candidate` -> `validated_reproduction` | Deterministic revalidation |
| `controlled_by` | `validated_reproduction` -> `run`* | The passing control runs |
| `approved_reproduction` | `validated_reproduction` -> `approved_reproduction` | Human gate 3 |
| `emitted_test` | `approved_reproduction` -> `static_test` | Deterministic codegen |
| `reported_in` | `finding`* -> `report` | AI report generation |
| `produced_by` | any AI-produced node -> `ai_call` | Provenance of every model output |
| `governed_by` | any node -> `approval` | Which approval authorised this node |
| `superseded_by` | node -> node | A later revision replaced this one |

## Record shape

```json
{
  "schemaVersion": "1.0.0",
  "lineageId": "LIN-000412",
  "investigationId": "INV-001",
  "seq": 412,
  "edge": "executed_as",
  "fromKind": "job",
  "fromId": "JOB-0f3a",
  "toKind": "run",
  "toId": "RUN-17",
  "actor": { "kind": "deterministic", "component": "execution", "version": "0.1.0" },
  "createdAt": "2026-09-10T14:22:07.114Z",
  "inputs": { "effectiveProposalChecksum": "sha256:...", "seed": 918273, "approvalId": "APPR-001" },
  "aiCallId": null,
  "flowId": null,
  "flowVersion": null,
  "flowHash": null,
  "recordHash": "sha256:...",
  "prevRecordHash": "sha256:..."
}
```

`actor.kind` is one of `human`, `deterministic`, `ai`. This single field answers the question the
governing principle exists to protect: for any node in the graph, who produced it. An `ai` actor
must carry `aiCallId`, `flowId`, `flowVersion`, and `flowHash`. A `human` actor must carry an
`approvalId`. A `deterministic` actor must carry `component` and `version`.

## Append-only and tamper-evident

- The `lineage` table has no update or delete path in the interface, and SQLite `BEFORE UPDATE` /
  `BEFORE DELETE` triggers raise `STORE_APPEND_ONLY_VIOLATION`.
- `seq` is a per-investigation monotonic integer assigned inside the same short transaction as the
  insert, so ordering is total and gap-free within an investigation.
- `recordHash = sha256(canonical(record without recordHash) || prevRecordHash)` forms a per
  investigation hash chain. `investigate doctor --verify-lineage` walks the chain and reports the
  first break. This does not prevent a determined local user from rewriting the DB; it makes such a
  rewrite detectable, which is the honest guarantee for a local single-user tool. Stated as
  residual risk in the security model.

## Queries the model must support

| Question | Query |
| --- | --- |
| Why does this report claim X? | `report -> reported_in^-1 -> finding -> supported_by -> run/artifact/statistic` |
| What authorised this run? | `run -> executed_as^-1 -> job -> scheduled_as^-1 -> approved_experiment -> governed_by -> approval` |
| Which prompt produced this finding? | `finding -> produced_by -> ai_call` (then `flowId`, `flowVersion`, `flowHash`) |
| What did the human change at gate 1? | `approval` record `edits[]` plus the pre/post proposal artifacts |
| Which runs did minimization drop, and did the signature survive? | `minimization_candidate -> validated_as -> validated_reproduction -> controlled_by` plus the retention statistic |
| Is this reproduction traceable to the original report? | walk `superseded_by`-free ancestors to `intake_report` |
| Did anything AI-produced reach the executor un-approved? | `run -> ... -> approval` must exist; absence is a bug and a test asserts none exist |

`investigate lineage <id>` prints the ancestor and descendant closure for any node, with
`actor.kind` on every hop, so the human/AI/deterministic boundary is visible at a glance.

## Reconstruction guarantee

Lineage plus artifacts plus manifests are sufficient to answer, offline and without the browser or
the provider: what was reported, how it was interpreted, what was proposed, what a human approved
and how they edited it, what ran with which resolved parameters and seed, what was observed, what
was inferred and from which evidence, what was minimized away, what was revalidated, and what was
reported. This is asserted end-to-end by the M2 and M7 acceptance tests.
