# Schemas

## Governing principle

Playwright produces evidence. Deterministic software normalizes and measures evidence. DeepSeek interprets and prioritizes evidence. Humans authorize consequential transitions.

## Status

These are the M0 hand-authored `v1` contracts. From M1 onward they become **build output**: each
schema is authored once in Zod in `packages/core/src/schemas/` and emitted here, with CI failing if
regeneration produces a diff (ADR-0020). The emitted files stay committed and reviewable, and a
round-trip test asserts the Zod object and the emitted JSON Schema accept and reject identical
fixtures.

## Classification

### Record schemas — validated on every write, carry `schemaVersion`

| File | Record | Written by |
| --- | --- | --- |
| `flow.v1.json` | Flow | `intake_to_flow`, edited by a human |
| `experiment-proposal.v1.json` | ExperimentProposal | `propose_experiments` |
| `run-manifest.v1.json` | RunManifest | executor, immutable once sealed |
| `evidence-event.v1.json` | EvidenceEvent | normalization plane |
| `capture-status.v1.json` | CaptureStatus | collector plus extractor |
| `failure-signature.v1.json` | FailureSignature | extractor (candidate), human (approved) |
| `run-classification.v1.json` | RunClassification | `classify_runs` |
| `finding.v1.json` | Finding | `analyze_pass_fail` |
| `minimization-candidate.v1.json` | MinimizationCandidate | `suggest_minimization` plus deterministic measurement |
| `statistic.v1.json` | Statistic | frequency and comparison computation |
| `lineage-record.v1.json` | LineageRecord | every stage, append-only |
| `approval-record.v1.json` | ApprovalRecord | `investigate approve` only |
| `reproducer-package.v1.json` | ReproducerPackage | reporting |
| `final-report.v1.json` | FinalReport | `generate_report` plus the deterministic renderer |
| `tool-call.v1.json` | ToolCall | AI gateway |
| `tool-result.v1.json` | ToolResult | tools |
| `intake-report.v1.json` | IntakeReport | human |
| `intake.input.v1.json` | flow input | AI gateway |
| `intake.output.v1.json` | flow output | `intake_to_flow` |

### Definition and file schemas — exempt from the `schemaVersion` rule

| File | Why exempt |
| --- | --- |
| `common.v1.json` | Definitions only. Has no independent record identity |
| `action.v1.json` | Embedded in Flow, ExperimentProposal, MinimizationCandidate, ReproducerPackage. Versioned with its containers |
| `config.v1.json` | Validates the user-authored `config.yaml`. Demanding a version field in hand-written config is friction with no benefit |
| `flow-artifact.v1.json` | Validates `flow.yaml`, which carries its own `version` (and `promptVersion`) |
| `redaction-policy.v1.json` | Validates `policies/*.yaml`, which carries `policyVersion` |

These five exemptions are enumerated in `docs/acceptance-tests/M0-doc-checks.md` (M0-AT-3a). A
sixth exemption requires an ADR.

## Conventions

- Draft 2020-12. `$id` under `https://investigator.local/schemas/`.
- `additionalProperties: false` on object subschemas, or `unevaluatedProperties: false` where
  `allOf` / `if` / `then` conditionals contribute properties.
- Cross-file references are relative (`common.v1.json#/$defs/runId`), so the directory is
  self-contained and portable.
- Enum vocabularies live in `common.v1.json` and are bidirectionally checked against the prose
  documentation by the M0 doc checks, so `CaptureStatus` categories, finding levels, tool names,
  error codes, and job/outcome combinations cannot drift between docs and enforcement.
- Cross-field rules JSON Schema cannot express (for example `heartbeatMs < leaseMs / 3`) live in an
  explicit assertion layer with their own tests, not in the schema. See ADR-0020.
- A breaking change produces `v2` alongside `v1`. `v1` stays in the repository so historical
  records remain interpretable. That is the entire point of versioning them.

## Schemas added after M0

Per-flow input and output schemas for `propose_experiments`, `classify_runs`,
`analyze_pass_fail`, `suggest_minimization`, and `generate_report` are added in the milestone that
introduces each flow (M3, M4, M6, M7), following the `intake.input` / `intake.output` pattern.
