# Agent Tool Allowlists and Budgets

Status: M0 frozen candidate
Package: `packages/tools`
Schemas: `schemas/tool-call.v1.json`, `schemas/tool-result.v1.json`

## Governing principle

Playwright produces evidence. Deterministic software normalizes and measures evidence. DeepSeek interprets and prioritizes evidence. Humans authorize consequential transitions.

## Allowlist per flow

| Flow | Tools |
| --- | --- |
| `intake_to_flow` | none |
| `propose_experiments` | `get_flow`, `get_application_constraints`, `get_previous_experiment_summary` |
| `classify_runs` | `get_run_summary`, `get_action_timeline`, `get_console_events`, `get_exception_events`, `get_failure_signature` |
| `analyze_pass_fail` | `compare_run_timelines`, `get_request`, `get_response_excerpt`, `get_dom_diff`, `get_storage_diff` |
| `suggest_minimization` | `get_failure_signature`, `get_sequence`, `get_previous_minimization_results` |
| `generate_report` | `get_investigation_summary`, `get_approved_findings`, `get_validation_results`, `get_artifact_references` |

Every tool is read-only for MVP. Every tool returns normalized, redacted, schema-validated facts.
No tool returns raw artifacts. No tool triggers execution.

Enforcement is double: the allowlist filters which `ToolSpec`s are sent to the provider at all,
**and** the dispatcher re-checks the tool ID against the flow allowlist before execution. A call
for a tool that was never advertised is `AI_TOOL_NOT_ALLOWED`, charged against the flow budget,
recorded as a warning, and never executed.

## Universal tool contract

```ts
interface ToolResult<T> {
  toolId: string;
  toolVersion: string;
  ok: boolean;
  data?: T;
  error?: { code: ToolErrorCode; message: string };
  provenance: {
    investigationId: InvestigationId;
    runIds: RunId[];
    normalizerVersion: string;
    extractorVersion: string;
    redaction: RedactionStamp;
    captureStatusSlice: Record<EvidenceCategory, CaptureStatusValue>;
  };
  truncation?: { truncated: true; omittedCount: number; reason: "MAX_EVIDENCE_BYTES" | "MAX_ITEMS" };
}
```

Invariants, asserted by a shared contract test applied to every registered tool:

1. Output validates against the tool result schema, `additionalProperties: false`.
2. Output contains no raw artifact bytes and no base64 blob. Enforced by a byte-pattern check and
   a size ceiling per tool.
3. Every returned datum that a model could cite carries an `eventId`, `artifactId`, or
   `statisticId`, so it is reference-validatable.
4. `provenance.redaction` is present and non-empty.
5. `provenance.captureStatusSlice` covers every category the tool read.
6. Truncation is explicit. Silent truncation is a test failure.
7. The tool performs no write, no browser call, no provider call, no network egress. Enforced by
   the import boundary (`tools` cannot import `execution` or `ai-gateway`) and by a test that runs
   each tool with the filesystem mounted read-only and network stubbed to throw.
8. Determinism: called twice with the same input and unchanged store, byte-identical output.

## Tool specifications

### `get_flow`

Input `{ investigationId }`. Returns the current validated `Flow`: steps, actions, assertions,
declared unknowns, assumptions, and the flow schema version. No evidence.

### `get_application_constraints`

Input `{ investigationId }`. Returns the resolved, redacted constraint set the human configured:
allowed origins, target classification, permitted action types, destructive-action policy,
`maxRunsPerInvestigation`, per-run wall clock, required evidence defaults, and the resolved
emulation profiles available. Returns no credentials and no secret names beyond the fact that an
auth strategy is configured.

### `get_previous_experiment_summary`

Input `{ investigationId, limit? }`. Returns, per prior experiment: ID, hypothesis, varied factor,
repetition count, outcome counts by `RunOutcome`, failure rate with Wilson interval, and the
signature IDs observed. Returns no per-run detail; that is what `classify_runs` tools are for.

### `get_run_summary`

Input `{ runId }`. Returns `RunOutcome`, `outcomeRuleId`, resolved emulation values, seed,
repetition and attempt indices, duration, counts per evidence category, assertion outcomes,
`CaptureStatus`, and the top-level failure signature candidates with their fingerprints.

### `get_action_timeline`

Input `{ runId, fromSeq?, limit? }`. Returns the action spine with, per action, the action ID, type,
canonical selector, start and end deltas, status, and per-category event counts within its window.
Paginated; `truncation` is set when the window is capped.

### `get_console_events`

Input `{ runId, levels?, fingerprint?, limit? }`. Returns console events with `eventId`, level,
normalized text, text fingerprint, normalized source location, and `actionId`. Raw text is
included only where the redaction policy permits, and the `redactedFields` list names what was
removed.

### `get_exception_events`

Input `{ runId, limit? }`. Returns uncaught exceptions and unhandled rejections with `eventId`,
normalized message, exception fingerprint, normalized frames, and `actionId`.

### `get_failure_signature`

Input `{ investigationId, signatureId? } | { runId }`. Returns candidate or approved
`FailureSignature` records: the signature ID, its predicate (deterministic, machine-checkable), the
runs matching it, and whether it is human-approved. Signatures are computed deterministically; this
tool reads them.

### `compare_run_timelines`

Input `{ runIdsA, runIdsB, categories?, maxItems? }`. Returns the deterministic comparison the
extractor computed: per-category differences between the two groups, each item carrying a
`comparisonId`, the differing feature, the group values, and the `eventIds` on each side. This is
the primary `analyze_pass_fail` tool and it is deliberately a *pre-computed* comparison, not a
free-form query, so the model cannot fish for coincidences beyond the bounded feature set.

### `get_request`

Input `{ runId, eventId }` or `{ runId, requestKey }`. Returns a single normalized network record:
method, normalized URL parts, status, resource type, timings, sizes, redirect chain,
`fromServiceWorker`, failure reason, `actionId`, and the redacted header *names* with values only
where policy permits. Never returns the response body.

### `get_response_excerpt`

Input `{ runId, eventId, maxBytes? }`. Returns a bounded, redacted excerpt of a captured response
body plus its content type, total byte length, and whether the body was truncated at capture time.
Refuses with `TOOL_EVIDENCE_UNAVAILABLE` when `responseBodies` is `missing`, `disabled`, or
`unsupported` for that run, and returns the excerpt with an explicit marker when `partial`.

### `get_dom_diff`

Input `{ runIdA, snapshotIdA, runIdB, snapshotIdB }` or `{ runId, fromSnapshotId, toSnapshotId }`.
Returns the bounded structural diff summary: counts and a capped list of changed paths with change
type, plus the `eventIds` of the snapshots. Never returns full DOM text.

### `get_storage_diff`

Input `{ runIdA, runIdB }` or `{ runId, fromEventId, toEventId }`. Returns key-level differences
for `localStorage` and `sessionStorage`, cookie name-level differences, and IndexedDB store-level
differences. Values appear only where the redaction policy permits; otherwise a shape descriptor
(type, length, hash) is returned instead of the value.

### `get_sequence`

Input `{ investigationId, sequenceId }`. Returns the current reproduction sequence: ordered
actions, assertions, repetition count, and which actions prior minimization rounds already proved
removable or required.

### `get_previous_minimization_results`

Input `{ investigationId }`. Returns per prior candidate: the candidate ID, the removal it
represented, runs executed, retained reproduction rate with interval, and the verdict
(`retained`, `lost`, `inconclusive`).

### `get_investigation_summary`

Input `{ investigationId }`. Returns the investigation header: title, environment target and
classification, flow summary, experiments run, total runs by outcome, gates approved with approval
IDs and timestamps, frequency statistics, and the aggregate `CaptureStatus`.

### `get_approved_findings`

Input `{ investigationId }`. Returns only findings that passed validation and are included in the
gate-approved set, with their levels and full evidence references.

### `get_validation_results`

Input `{ investigationId }`. Returns the deterministic validation record: artifact integrity
results, manifest seal checks, reference-validation summary per finding, revalidation runs for the
reproduction and the control with their rates and intervals, and any demotions applied.

### `get_artifact_references`

Input `{ investigationId, kinds?, findingIds? }`. Returns `ArtifactRef` metadata only — artifact
ID, kind, filename, byte length, SHA-256, run ID, and redaction stamp. No bytes.

## Tool error codes

| Code | Meaning |
| --- | --- |
| `TOOL_NOT_ALLOWED` | Not in the flow allowlist |
| `TOOL_INPUT_INVALID` | Input failed the tool input schema |
| `TOOL_NOT_FOUND` | Referenced entity does not exist |
| `TOOL_NOT_OWNED` | Entity exists but belongs to another investigation |
| `TOOL_EVIDENCE_UNAVAILABLE` | Category `missing`, `disabled`, `unsupported`, or `corrupted` |
| `TOOL_EVIDENCE_REDACTED` | Requested content was removed by policy |
| `TOOL_BUDGET_EXCEEDED` | Flow tool-call or evidence-byte budget exhausted |

Tool errors are returned in-band as `ok: false` results so the model can adapt within its budget.
They also surface as flow warnings. `TOOL_NOT_ALLOWED` additionally raises the typed error at flow
completion so it is never invisible.

## Post-MVP write tools

Any future tool that mutates state, triggers execution, or performs network egress requires: an
ADR, a new tool category (`action` rather than `read`), an explicit per-flow opt-in, and a human
approval gate on the specific action. There is no path by which a read-only allowlist silently
acquires a write tool.
