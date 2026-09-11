# Capture Completeness Model

Status: M0 frozen candidate
Schema: `schemas/capture-status.v1.json`

## Governing principle

Playwright produces evidence. Deterministic software normalizes and measures evidence. DeepSeek interprets and prioritizes evidence. Humans authorize consequential transitions.

## Why this exists

Missing, partial, redacted, unsupported, and corrupted evidence is represented explicitly. An
investigation that silently reasons over a truncated response body or an unsupported category will
produce a confident wrong answer. So completeness is a first-class recorded fact, not an
afterthought, and it is recorded **per run and per category**.

## Status values

| Value | Meaning |
| --- | --- |
| `complete` | Everything the configuration asked for in this category was collected and parsed |
| `partial` | Some of the category was collected; at least one item was truncated, dropped, or size-limited. `limitations` must explain |
| `missing` | The category was configured to be collected but nothing was collected |
| `redacted` | Present but the content material to analysis was removed by policy. Structure and metadata may remain |
| `unsupported` | The collector or the configuration cannot provide this category in this build/config |
| `corrupted` | Artifacts exist but failed to parse or failed an integrity check |
| `disabled` | Explicitly turned off by configuration. Distinct from `unsupported`: a human chose this |

`disabled` is an addition to the illustrative example in the brief. Rationale: "the operator turned
video off to save disk" and "this collector cannot capture WebSocket frames" have different
remediations, and collapsing them into `unsupported` loses the actionable distinction. Recorded as
a deliberate extension in `docs/FREEZE-M0.md`.

## Categories

`actions`, `navigation`, `console`, `exceptions`, `networkMetadata`, `responseBodies`,
`domSnapshots`, `storage`, `screenshots`, `video`, `trace`, `webSocketFrames`.

Every category appears in every `CaptureStatus`. There are no absent keys: an omitted key is
indistinguishable from a forgotten one, so the schema requires all of them.

## Shape

```json
{
  "captureStatus": {
    "actions": "complete",
    "console": "complete",
    "networkMetadata": "complete",
    "responseBodies": "partial",
    "domSnapshots": "complete",
    "webSocketFrames": "unsupported",
    "video": "complete"
  },
  "limitations": [
    "Three response bodies exceeded the configured size limit.",
    "WebSocket frame capture is disabled in this collector version."
  ]
}
```

The persisted record extends this with machine-readable detail alongside the human strings, because
a report generator needs to cite a limitation and a scorer needs to compare them:

```json
{
  "schemaVersion": "1.0.0",
  "runId": "RUN-17",
  "collectorVersion": "0.1.0",
  "normalizerVersion": "0.1.0",
  "redactionPolicy": { "policyId": "default", "policyVersion": "1.0.0", "policyHash": "sha256:..." },
  "categories": {
    "actions":         { "status": "complete", "expected": 14, "collected": 14 },
    "navigation":      { "status": "complete", "expected": null, "collected": 3 },
    "console":         { "status": "complete", "expected": null, "collected": 27 },
    "exceptions":      { "status": "complete", "expected": null, "collected": 1 },
    "networkMetadata": { "status": "complete", "expected": null, "collected": 118 },
    "responseBodies":  { "status": "partial",  "expected": 118, "collected": 41,
                         "reasons": [ { "code": "SIZE_LIMIT", "count": 3, "limitBytes": 262144 },
                                      { "code": "CONTENT_TYPE_NOT_CAPTURED", "count": 74 } ] },
    "domSnapshots":    { "status": "complete", "expected": 17, "collected": 17 },
    "storage":         { "status": "redacted", "reasons": [ { "code": "POLICY_REDACTED", "count": 4 } ] },
    "screenshots":     { "status": "complete", "expected": 15, "collected": 15 },
    "video":           { "status": "disabled", "reasons": [ { "code": "CONFIG_OFF", "count": 1 } ] },
    "trace":           { "status": "complete", "expected": 1, "collected": 1 },
    "webSocketFrames": { "status": "unsupported",
                         "reasons": [ { "code": "COLLECTOR_UNSUPPORTED", "count": 1 } ] }
  },
  "limitations": [
    "Three response bodies exceeded the configured size limit.",
    "Seventy-four response bodies were not captured because their content type is not in the capture list.",
    "WebSocket frame capture is disabled in this collector version."
  ]
}
```

`limitations` is generated deterministically from `categories[].reasons` by a template table, so
the prose and the machine data cannot drift.

## Reason codes

| Code | Applies to | Meaning |
| --- | --- | --- |
| `SIZE_LIMIT` | responseBodies, domSnapshots | Exceeded configured byte limit |
| `CONTENT_TYPE_NOT_CAPTURED` | responseBodies | Content type outside the capture list |
| `POLICY_REDACTED` | any | Redaction policy removed analysis-material content |
| `CONFIG_OFF` | video, trace, responseBodies, webSocketFrames, screenshots | Operator disabled it |
| `COLLECTOR_UNSUPPORTED` | any | This collector version cannot capture it |
| `RUN_INTERRUPTED` | any | Collection stopped mid-run |
| `PARSE_FAILED` | any | Artifact present, parse failed |
| `HASH_MISMATCH` | any | Integrity check failed |
| `DROPPED_BACKPRESSURE` | console, networkMetadata | Event volume exceeded the in-process buffer |
| `TARGET_DETACHED` | domSnapshots, storage, screenshots | Page or context closed before capture |

## How completeness gates behaviour

1. **RunOutcome rule 6.** All assertions passing while a *required* category is `missing` or
   `corrupted` yields `INCONCLUSIVE`, not `VALID_COMPLETED`. Required categories are declared per
   experiment in the approved proposal (`requiredEvidence`), defaulting to
   `[actions, navigation, console, exceptions, networkMetadata]`.
2. **Tool responses.** Every tool result includes the `CaptureStatus` slice relevant to the
   categories it read. A tool that reads `responseBodies` when that category is `partial` returns
   the partial marker in-band so the model can see the limit rather than infer absence.
3. **Finding levels.** A finding whose supporting evidence depends on a category that is
   `partial`, `redacted`, `unsupported`, or `corrupted` for any cited run is capped at
   `correlated`. It cannot reach `probable_trigger` or above. Enforced deterministically in
   reference validation, not by prompting.
4. **Report rendering.** `FinalReport` must contain a completeness section listing, for every run
   it cites, every non-`complete` category and its limitations. Rendering refuses if absent.
5. **Export.** `investigate export` re-verifies integrity and re-runs redaction verification, and
   writes the aggregate completeness summary into the bundle.

## Aggregate completeness

For an investigation, the aggregate is computed as the per-category *worst* status across cited
runs, using the order
`complete > partial > redacted > disabled > unsupported > missing > corrupted`
(best to worst). Aggregation never improves a status. A single `corrupted` run in the cited set
makes the aggregate `corrupted` for that category and forces the report to say so.

## Language discipline

Describe coverage as "the configured, technically accessible, authorized, and successfully
collected client-observable evidence." Do not claim capture of literally all browser-visible data.

Concretely forbidden in generated output, and checked by a deterministic lint over rendered
reports: "all browser data", "complete browser state", "full session capture", "everything the
browser saw", "nothing was missed".
