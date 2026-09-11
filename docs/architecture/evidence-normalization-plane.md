# Evidence Normalization Plane

Status: M0 frozen candidate
Package: `packages/evidence`

## Governing principle

Playwright produces evidence. Deterministic software normalizes and measures evidence. DeepSeek interprets and prioritizes evidence. Humans authorize consequential transitions.

## Pipeline

```
Raw Chrome evidence
  -> parsing
  -> normalization
  -> redaction and policy enforcement
  -> deterministic feature extraction
  -> evidence index and session timeline
  -> AI Gateway
```

Each arrow is a pure function. The plane as a whole is a pure function of
`(raw artifacts, redactionPolicyVersion, normalizerVersion)`. Running it twice on the same inputs
produces byte-identical output, asserted by
`tests/reliability/offline_session_reconstruction.spec.ts`.

## Stage 0 — collection (in `packages/execution`)

The collector subscribes to Playwright and CDP sources and writes a raw append-only event log plus
raw artifacts. Sources:

| Category | Source |
| --- | --- |
| actions | Deterministic action interpreter emits `actionStart` / `actionEnd` with the action ID |
| navigation | `framenavigated`, `load`, `domcontentloaded`, `popup` |
| console | `console` events, with type, text, and location |
| exceptions | `pageerror`, plus unhandled rejection hooks |
| network metadata | `request`, `response`, `requestfailed`, `requestfinished` with timings, method, URL, status, resource type, sizes, `fromServiceWorker` |
| response bodies | Bounded, opt-in per content type, subject to `capture.responseBodyMaxBytes` |
| DOM snapshots | Serialized on action boundaries, navigation, and failure |
| storage | `localStorage`, `sessionStorage`, cookie *names and metadata*, IndexedDB database and store names |
| screenshots | On action boundary (configurable) and on failure |
| video | Playwright video |
| trace | Playwright trace |
| web socket frames | `unsupported` unless `capture.webSocketFrames` is true |

Redaction hooks run **at collection time** for the highest-risk fields (see "Redaction boundary")
so that raw persisted bytes are already redacted where redaction can be decided without whole-run
context. Redaction that requires cross-event context runs at stage 3, and its inputs live only in
bounded process memory.

Ordering guarantee: every raw event carries a monotonically increasing `seq` assigned by a single
in-process counter, plus `tMonoMs` from a monotonic clock and `tWallMs` from the injected `Clock`.
Timestamps are non-decreasing in `seq` order, asserted by
`tests/reliability/monotonic_timestamps.spec.ts`.

## Stage 1 — parsing

Reads the raw log and raw artifacts, validates each record against the raw-event schema, and
produces typed records. A parse failure on a present artifact is `EVIDENCE_CORRUPTED` for that
artifact and marks that category `corrupted` in `CaptureStatus`; it does not abort the whole
normalization.

## Stage 2 — normalization

Canonicalisation so that later comparison is meaningful and not noise-dominated:

- **URLs**: split into origin, path, sorted query keys, and a per-key redaction decision. Path
  segments matching configured ID patterns (UUID, numeric, hex >= 16, base64url >= 22) become
  typed placeholders such as `{uuid}` while the original is retained only if the policy permits.
- **Timestamps**: converted to `deltaFromRunStartMs` in addition to absolute values. Comparison
  uses deltas.
- **Selectors**: canonical form; whitespace, quote style, and attribute order normalized.
- **Console text**: volatile substrings (timestamps, ports, ephemeral IDs, memory addresses,
  stack line/column) replaced by stable placeholders for fingerprinting, with the original text
  retained in the event body subject to redaction.
- **Stack traces**: normalized to `(function, file, normalizedLine)` frames; bundle hashes and
  query strings stripped from file URLs.
- **DOM**: serialized to a canonical tree — attributes sorted, whitespace-only text nodes
  collapsed, configured volatile attributes (`data-reactid`-style, `id` when matching a volatile
  pattern, inline `style` when configured) masked.
- **Numbers**: durations bucketed into stable bands *in addition to* the raw value; extraction
  reports both.

Normalization is versioned (`normalizerVersion`). Changing it invalidates cached derived data and
is recorded in every affected manifest.

## Stage 3 — redaction and policy enforcement

See `docs/security/redaction-policy.md` for the policy language. The enforcement contract here:

- Redaction runs before durable persistence of normalized data, before provider transmission,
  before indexing, before logging, and before report generation or export.
- Every persisted record and artifact carries a `RedactionStamp`:
  `{ policyId, policyVersion, policyHash, appliedRules: [{ruleId, occurrences}], mode }`.
- **Fail closed.** A record that reaches the persistence boundary without a `RedactionStamp` is
  `REDACTION_NOT_APPLIED` (exit 9). This is enforced by the type signature of
  `ArtifactStore.put` and `MetadataTx.insert*`, and asserted by
  `tests/reliability/redaction_before_persistence.spec.ts`.
- Unknown-shape data is redacted by default: a field whose classification cannot be determined is
  treated as sensitive under `mode: strict` (the default).

## Stage 4 — deterministic feature extraction

Pure computation over normalized, redacted records. Must produce:

| Feature | Definition |
| --- | --- |
| HTTP status distributions | Count per status class and per exact status, per origin and per normalized path template |
| Request-duration differences | Per normalized request key: count, min, median, p95, max; and, in comparison mode, the delta between run groups |
| Request ordering | The sequence of normalized request keys, plus a stable ordering fingerprint and pairwise inversions relative to a reference run |
| Aborted-request counts | Count and list of `requestfailed` events with normalized failure reasons |
| Console-error counts | Count by console level and by normalized text fingerprint |
| Exception fingerprints | Stable hash of `(normalized message, top N normalized frames)`; N configurable, default 5 |
| Assertion outcomes | Per declared assertion: pass/fail/not-evaluated with the action ID it was attached to |
| DOM-diff summaries | Structural diff between snapshot pairs: nodes added/removed/moved, attribute changes, text changes, each bounded and bucketed |
| Storage changes | Key-level added/removed/changed for `localStorage` / `sessionStorage`; cookie name-level changes; IndexedDB store-level changes |
| Navigation differences | Sequence of normalized navigations, redirect chains, unexpected reloads, history depth |
| Evidence completeness | The `CaptureStatus` object, per category, with limitations |
| Artifact integrity | Recomputed SHA-256 per artifact vs the stored `ArtifactRef` |
| Run validity | `RunOutcome` plus `outcomeRuleId`, recomputed from normalized evidence and asserted equal to the value the executor recorded |
| Basic frequency statistics | Per repetition set: n, failures, rate, Wilson 95% interval |

Extraction is versioned (`extractorVersion`). Every extracted feature record names the extractor
version and the normalizer version it consumed.

Note on "run validity": the extractor independently recomputes the outcome from persisted evidence
and compares it to the executor's decision. Disagreement is an integrity failure, not a warning.
This is the check that makes the executor's fast in-process classification trustworthy.

## Stage 5 — evidence index and session timeline

**EvidenceEvent** is the atomic unit exposed upward. Every event has an `EV-nnn` ID scoped to its
run, a category, a `seq`, `tDeltaMs`, an optional `actionId`, an optional `artifactId`, and a
category-specific payload. See `schemas/evidence-event.v1.json`.

**Session timeline** is the per-run ordered projection of events, with actions as the spine and
every other category correlated to the action window it fell inside. Correlation rule: an event
belongs to the action whose `[actionStartSeq, actionEndSeq]` window contains the event `seq`;
events outside any window belong to the synthetic `pre-first-action` or `post-last-action` windows.
Network requests that start inside one window and finish in a later one are attributed to their
*start* window and carry `finishedInActionId`. This is asserted by
`tests/reliability/network_action_correlation.spec.ts`.

**Evidence index** is the queryable structure the tools read: `(runId, category, fingerprint) ->
eventIds`, plus `(runId) -> CaptureStatus`, plus `(investigationId, fingerprint) -> runIds`. It is
derived, cacheable, and rebuildable from persisted normalized data with no browser involvement.

## Boundary to the AI Gateway

DeepSeek receives extracted facts, not raw archives.

Concretely, the only path from evidence to the model is `packages/tools`. Tools return normalized,
redacted, schema-validated facts with explicit `eventIds` and `artifactIds` so that any claim the
model makes can be reference-validated against what it was actually shown. Tool outputs are
size-bounded per `flow.yaml` `budget.maxEvidenceBytes`; truncation is explicit
(`truncated: true`, `omittedCount: n`) and never silent.
