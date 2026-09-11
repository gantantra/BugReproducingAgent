---
id: ADR-0010
title: AI flows are versioned filesystem artifacts, hash-pinned per version
status: accepted
date: 2026-09-10
touches: [ai]
decision: Store each flow as a directory containing flow.yaml, system.md, examples.jsonl, and eval/, content-hash the directory into a flowHash recorded on every AI call and every produced record, and reject loading a flow whose bytes changed without a version bump.
consequences: Any produced finding is traceable to the exact prompt bytes that produced it, at the cost of version-bump discipline and a lint rule banning long inline prompt literals.
---

# ADR-0010 — AI flows as versioned artifacts

## Governing principle

Playwright produces evidence. Deterministic software normalizes and measures evidence. DeepSeek interprets and prioritizes evidence. Humans authorize consequential transitions.

## Context

Prompts are behaviour. A finding produced last month is only auditable if the prompt, the schema,
the examples, the model alias, the budget, and the validation settings that produced it are all
recoverable. Prompts embedded as template literals in TypeScript are diffable but not
addressable: nothing in a persisted finding says which version of the prompt produced it.

## Decision

Each flow is a versioned artifact, not an inline prompt:

```
/ai/flows/<flow-id>/
  flow.yaml          # id, version, modelAlias, tools, input/output schemas, budget, validation
  system.md          # the system prompt
  examples.jsonl     # few-shot examples
  eval/              # the flow author regression set
  repair.md          # optional repair-instruction override
  tools.md           # optional prose describing allowlisted tools
  CHANGELOG.md       # required once version > 1.0.0
```

Rules:

- `flow.yaml` validates against `schemas/flow-artifact.v1.json` at load.
- `flowHash` is the SHA-256 over the canonical concatenation of the hashed files. It is recorded in
  every `AiCallRecord`, every produced domain record, and every lineage edge whose `actor.kind` is
  `ai`.
- `version` must be bumped whenever any hashed file changes. Loading a flow whose `flowHash`
  differs from the hash recorded for that `(id, version)` in the metadata store is
  `CONFIG_INVALID`. This is what prevents silent prompt drift *within* a version, which is the
  failure mode that makes old findings unexplainable.
- `promptVersion` may be recorded separately from `version` when only prose changed, so that a
  schema-compatible prose tweak is visible without implying an interface change.
- A lint rule forbids multi-line template literals over 200 characters in `packages/ai-flows`, so
  the natural path of least resistance is to edit the artifact rather than inline a prompt.
- A version bump requires the flow eval suite to pass at or above the recorded baseline for the
  prior version. Baselines live in `/eval/reports/baselines.json` and are raised deliberately,
  never lowered to make a build green.

## Budgets live in the artifact

All six budget dimensions (`maxTurns`, `maxToolCalls`, `maxEvidenceBytes`, `maxInputTokens`,
`maxOutputTokens`, `maxCostUsd`, `maxWallClockMs`) and the validation settings (`schemaStrict`,
`rejectUnknownFields`, `referenceCheck`, `repairAttempts`) are declared in `flow.yaml`, not in
code. Changing a budget is therefore a version bump with an eval run, not a constant edit.

## Alternatives considered

| Alternative | Why rejected |
| --- | --- |
| Inline template literals | Not addressable from a persisted record; drift invisible |
| Prompts in the database | Harder to review, diff, and code-review; no PR discussion of a prompt change |
| A prompt-management service | External dependency contradicting ADR-0001; adds a runtime failure mode to the reasoning layer |
| Version field without a hash | A prose edit under the same version silently changes behaviour |

## Consequences

Positive: full provenance from any finding back to exact prompt bytes; prompts reviewed in PRs like
code; budgets and validation settings are data, not constants; eval baselines are attached to a
concrete artifact version.

Negative: version-bump discipline is required, and forgetting it produces a hard load failure
rather than a warning. That is intentional; the alternative is unexplainable history.
