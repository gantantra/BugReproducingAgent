# AI Flow Artifacts

Status: M0 frozen candidate
Location: `/ai/flows/<flow-id>/`

## Governing principle

Playwright produces evidence. Deterministic software normalizes and measures evidence. DeepSeek interprets and prioritizes evidence. Humans authorize consequential transitions.

## Structure

Each flow is a versioned artifact, not an inline prompt:

```
/ai/flows/<flow-id>/
  flow.yaml
  system.md
  examples.jsonl
  eval/
```

Additions to the required set, all optional:

```
  repair.md          # optional override of the generic repair instruction
  tools.md           # optional prose describing the allowlisted tools to the model
  CHANGELOG.md       # required once version > 1.0.0
```

Rules:

- `flow.yaml` is validated against `schemas/flow-artifact.v1.json` at load time.
- The flow directory is content-hashed (`flowHash`) over `flow.yaml`, `system.md`,
  `examples.jsonl`, `repair.md`, `tools.md`. The hash is recorded in every `AiCallRecord` and every
  produced domain record, so any output can be traced to the exact prompt bytes that produced it.
- `version` must be bumped whenever any hashed file changes. A load whose `flowHash` differs from
  the hash recorded for that `(id, version)` in the metadata store is rejected with
  `CONFIG_INVALID`. This prevents silent prompt drift within a version.
- Prompts are never string literals in TypeScript. A lint rule forbids multi-line template
  literals over 200 characters in `packages/ai-flows`.

## flow.yaml

```yaml
id: intake_to_flow
version: 1.0.0
modelAlias: FAST_MODEL
tools: []
inputSchema: schemas/intake.input.v1.json
outputSchema: schemas/intake.output.v1.json
budget:
  maxTurns: 3
  maxToolCalls: 0
  maxEvidenceBytes: 0
  maxInputTokens: 6000
  maxOutputTokens: 2000
  maxCostUsd: 0.05
  maxWallClockMs: 60000
validation:
  schemaStrict: true
  rejectUnknownFields: true
  referenceCheck: true
  repairAttempts: 1
```

Additional optional fields:

| Field | Default | Meaning |
| --- | --- | --- |
| `temperature` | 0 | Flow-level temperature |
| `fallbackAlias` | unset | The only way `FALLBACK_MODEL` may be used |
| `partialCapable` | false | Whether a budget stop yields `partial` rather than `inconclusive` |
| `unitField` | unset | For partial-capable flows, the output array field whose elements are independently validated units |
| `promptVersion` | equals `version` | Recorded separately when only prose changed |
| `requiredCapabilities` | derived | Explicit list; derived from `tools` and `outputSchema` when absent |

## Budget semantics

All six budget dimensions are enforced. Budget exhaustion returns a typed partial or inconclusive
result.

| Dimension | Enforcement point | On exhaustion |
| --- | --- | --- |
| `maxTurns` | Before dispatching turn n+1 | Stop, `stopReason: BUDGET_TURNS` |
| `maxToolCalls` | Before executing a tool call | Tool call refused; the model is told the budget is exhausted once, then the loop stops with `BUDGET_TOOL_CALLS` |
| `maxEvidenceBytes` | After each tool result is serialized | Subsequent tool results are truncated with explicit markers; if the first result alone exceeds it, the flow is `inconclusive` with a configuration error warning |
| `maxInputTokens` | Before dispatch, counted locally | Input is not silently trimmed. The flow reduces *scope* (fewer runs per turn) if partial-capable, else `inconclusive` |
| `maxOutputTokens` | Passed as `maxTokens`, clamped by capability and `llm.budgets.perCallTokens` | A `finishReason` of length-limit is `INVALID_OUTPUT` for a schema-required response, then one repair with reduced scope |
| `maxCostUsd` | Before each call: committed spend + worst-case next call | `BUDGET_COST` |
| `maxWallClockMs` | Single deadline shared with retries | `BUDGET_WALLCLOCK` |

Investigation-level `budgets.perInvestigationUsd` is checked in addition to the flow budget, and it
wins. A flow with remaining budget is still stopped if the investigation ceiling would be crossed.

## Turn loop

```
1. Build input from the flow input schema. Validate the input itself. (An invalid input is our bug.)
2. Render system.md + examples.jsonl + tools.md into the system message.
3. For turn in 1..maxTurns:
     a. Check all budgets. Stop if any exhausted.
     b. Dispatch via LlmProvider with the output schema when jsonMode is supported.
     c. If the response contains tool calls:
          - reject any tool not in the allowlist -> AI_TOOL_NOT_ALLOWED, charged, warned
          - execute allowlisted tools, bound the serialized size, append results as tool messages
          - continue to the next turn
     d. Otherwise run the validation pipeline (parse, schema, unknown fields, references).
     e. On validation failure: one repair attempt, then AI_INVALID_OUTPUT.
     f. On success: return.
4. Turn budget exhausted with no valid final answer -> partial or inconclusive per partialCapable.
```

The loop is deterministic in structure. Only the model responses vary.

## Per-flow specifications

### `intake_to_flow`

- Alias `FAST_MODEL`, tools none, not partial-capable.
- Input: the raw intake report text plus the environment target metadata plus the closed action
  vocabulary.
- Output: a `Flow` — an ordered list of steps, each mapping to zero or more `Action`s from the
  closed set, plus declared assertions, plus explicitly listed `unknowns` and `assumptions`.
- Reference check: every action type must exist in the closed vocabulary; every selector must be a
  syntactically valid selector of a permitted strategy; every URL must be within
  `safety.allowedOrigins`. A flow that requires an out-of-scope origin is rejected, not clamped.
- The model must not invent credentials, test data, or URLs. Any needed value it cannot ground is
  emitted into `unknowns` for the human to fill.

### `propose_experiments`

- Alias `REASONING_MODEL`, tools `get_flow`, `get_application_constraints`,
  `get_previous_experiment_summary`. Not partial-capable.
- Output: ranked `ExperimentProposal[]`, each with a hypothesis, the varied factor, the action
  sequence, assertions, `requiredEvidence`, repetition count, a safety classification, an expected
  discriminating signal, and a rank rationale.
- Ranking must be justified against the flow and prior results, and each proposal must state what
  observation would *falsify* its hypothesis. A proposal with no falsifier is rejected by schema.
- Destructive actions must be flagged. An unflagged action that the deterministic classifier
  considers destructive is a schema failure.

### `classify_runs`

- Alias `FAST_MODEL`, tools `get_run_summary`, `get_action_timeline`, `get_console_events`,
  `get_exception_events`, `get_failure_signature`. Partial-capable, `unitField: classifications`.
- Output: per run, a `RunClassification` with a cluster assignment, the failure signature it
  matches (or `none`), and evidence references.
- The deterministic extractor already computes fingerprints and candidate signatures. The model
  clusters and names them; it does not compute them. A classification that contradicts the
  deterministic `RunOutcome` for that run is rejected.

### `analyze_pass_fail`

- Alias `REASONING_MODEL`, tools `compare_run_timelines`, `get_request`,
  `get_response_excerpt`, `get_dom_diff`, `get_storage_diff`. Partial-capable,
  `unitField: findings`.
- Output: `Finding[]` per the evidence reference model, with levels, supporting and contradicting
  evidence, and `field`/`expectedValue` citations required at `probable_trigger` and above.
- Hard fail on `confirmed_root_cause` without approved direct evidence.

### `suggest_minimization`

- Alias `REASONING_MODEL`, tools `get_failure_signature`, `get_sequence`,
  `get_previous_minimization_results`. Not partial-capable.
- Output: ordered `MinimizationCandidate[]`, each a *strictly smaller* sequence than the current
  reproduction, with the removal rationale and the expected retained signature.
- Schema enforces that each candidate is a subsequence or a documented substitution of the current
  sequence. The model cannot introduce new actions during minimization; it may only remove,
  merge, or replace with a declared simpler equivalent from the closed set.
- Execution and measurement of candidates is deterministic and happens outside the flow.

### `generate_report`

- Alias `REASONING_MODEL`, tools `get_investigation_summary`, `get_approved_findings`,
  `get_validation_results`, `get_artifact_references`. Not partial-capable.
- Output: `FinalReport` with required sections and no claim beyond the approved findings.
- Reference check: every claim in the report must map to an approved finding ID; the report may
  not introduce a new finding, raise a level, or cite evidence not already referenced by an
  approved finding. It may summarise and reorganise.
- The rendered report is additionally linted for forbidden overclaiming phrases
  (see `docs/architecture/capture-completeness.md`).

## Versioning and evals

- Every flow directory contains `eval/` with at least the cases named in
  `docs/evaluation/eval-gates.md` for its milestone.
- A version bump requires the eval suite to pass at or above the recorded baseline for the prior
  version. Regressions block the bump. Baselines live in `/eval/reports/baselines.json`.
