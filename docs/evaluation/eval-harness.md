# Eval Harness Design

Status: M0 frozen candidate

## Governing principle

Playwright produces evidence. Deterministic software normalizes and measures evidence. DeepSeek interprets and prioritizes evidence. Humans authorize consequential transitions.

## Layout

```
/eval
  /datasets
    /intake
    /classify
    /analyze
    /minimize
    /report
  /harness
    runner.ts
    scorer.ts
    judge.ts        # deterministic first; LLM judge secondary only
  /reports
    baselines.json
    <timestamp>-<flowId>-<flowVersion>.json
```

Per-flow eval cases also live beside their flow in `/ai/flows/<flow-id>/eval/`, and the harness
loads both locations: flow-local cases are the flow author's own regression set, and
`/eval/datasets/` holds the shared, cross-flow corpus.

## Case format

```json
{
  "caseId": "intake-003-ambiguous-selector",
  "flowId": "intake_to_flow",
  "polarity": "positive",
  "tags": ["ambiguity", "unknowns"],
  "fixture": {
    "kind": "static",
    "input": { "...": "flow input, schema-valid" },
    "storeSnapshot": "snapshots/intake-003/"
  },
  "expected": {
    "mustMatch": { "...": "structural expectations" },
    "mustNotContain": ["credential-shaped literal", "origin outside allowlist"],
    "mustReference": [{ "runId": "RUN-04", "field": "/response/status", "expectedValue": 503 }],
    "maxLevel": "correlated",
    "mustFailWith": null
  },
  "recorded": "recorded/intake-003.json"
}
```

Fields:

- `polarity`: `positive` (the flow should succeed and match) or `negative` (the flow must fail, or
  must refuse to make a claim). Negative cases are first-class and weighted equally.
- `fixture.storeSnapshot`: a pre-built, redacted metadata-store and artifact-store snapshot so that
  tools return real facts and reference validation is exercised against a real store.
- `expected.mustFailWith`: for negative cases, the required typed error code (for example
  `AI_CLAIM_UNSUPPORTED`, `AI_REFERENCE_MISMATCH`).
- `recorded`: a recorded provider response, used by `RecordedProvider` so CI needs no API key.

## Runner

`runner.ts` responsibilities:

1. Materialise a temp workspace from `fixture.storeSnapshot`.
2. Construct the flow with a frozen `Clock`, a fixed seed, and `temperature: 0`.
3. Select the provider: `RecordedProvider` (default, CI) or the live DeepSeek adapter
   (`--live`, developer-only, requires the key).
4. Execute the flow with its real budgets and its real allowlist. No special eval privileges: if a
   flow cannot call a tool in production, it cannot call it in eval.
5. Capture: the flow result, the typed error if any, every `AiCallRecord`, every tool call, usage,
   cost, latency, and all warnings.
6. Hand the capture to `scorer.ts`.

Modes:

| Mode | Provider | Purpose |
| --- | --- | --- |
| `replay` (default) | `RecordedProvider` | Deterministic CI gate. Tests our validation, budgets, tools, and scoring |
| `live` | DeepSeek | Measures actual model quality. Run on demand and on a schedule, not on every PR |
| `record` | DeepSeek, writes `recorded/` | Refreshes fixtures after a deliberate prompt or schema change |

Replay mode is the CI gate because it is deterministic. Live mode is the quality signal. Both are
reported; only replay blocks a PR, and live-mode regression blocks a flow **version bump**.

`live` mode runs each case `--repetitions n` (default 3) and reports per-case pass rate, because a
single sample from a stochastic model is not a measurement. The recorded metric is the mean with
its range, and a case is "passing" in live mode only if all repetitions pass unless the case
declares `allowedFailures`.

## Scorer

Deterministic first. Every scorer is a pure function of the capture.

### Shared checks, applied to every case

| Check | Rule |
| --- | --- |
| Schema validity | Output validates strictly, unknown fields rejected |
| Reference validity | All seven reference checks pass against the snapshot store |
| No fabrication | Zero references to IDs absent from the snapshot |
| Budget respected | No dimension exceeded; a `partial` result declares its `stopReason` |
| Allowlist respected | Zero `TOOL_NOT_ALLOWED` occurrences |
| Determinism | In replay mode, running the case twice yields byte-identical output |
| No secret residue | Output contains no value matching the redaction policy's secret patterns |

Any shared check failing fails the case regardless of the flow-specific score.

### Per-flow scoring

**intake**: structural match plus reference validity.

- Step-set F1 against the expected flow: precision and recall over `(actionType, canonicalSelector,
  ordinalPosition)` triples, with position matched within a tolerance of one.
- Action-vocabulary validity: 1.0 required, any out-of-vocabulary action fails the case.
- Assertion coverage: fraction of expected assertions present.
- `unknowns` recall: fraction of ungroundable values the case declares that the flow actually
  emitted into `unknowns` rather than inventing. Inventing any of them fails the case.

**classify**: confusion matrix per class.

- Classes are the failure signature IDs in the snapshot plus `none`.
- Reported: full confusion matrix, per-class precision/recall/F1, macro-F1, and the count of
  classifications contradicting the deterministic `RunOutcome` (must be 0).
- Cluster quality: adjusted Rand index against the expected clustering.

**analyze**: precision/recall on injected known differences; hard fail on unsupported
`confirmed_root_cause`.

- The snapshot is built from fixture runs with *known injected differences* (the seeded
  intermittent fixture provides a real ordering difference; additional cases inject a status-code
  difference, a duration difference, and a storage difference).
- Precision: fraction of reported findings that correspond to an injected difference.
- Recall: fraction of injected differences reported at level `correlated` or above.
- Level calibration: for each finding, whether its level is justified by the deterministic
  promotion requirements. Over-leveling is scored separately from a wrong finding, because they
  are different defects.
- Hard fails: any `confirmed_root_cause` without approved direct evidence; any finding at
  `probable_trigger`+ without a `field`/`expectedValue` citation; any fabricated reference.

**minimize**: reduction ratio versus retained reproduction rate.

- Reduction ratio: `1 - (minimized action count / original action count)`.
- Retained reproduction rate: measured deterministically by executing the candidate against the
  fixture, with the Wilson interval.
- Score is the pair, not a scalar. A case passes if reduction >= its declared minimum **and** the
  retained rate's lower interval bound >= its declared threshold. Reporting a large reduction that
  loses the signature is a failure, not a trade-off.
- Cases with a known minimal reproducing subsequence additionally score exact-match.

**report**: required fields present, references valid, no fabricated evidence.

- Required-section coverage: 1.0 required.
- Claim traceability: every claim maps to an approved finding ID; extra claims fail.
- Level fidelity: no claim renders at a higher level than its source finding.
- Completeness section: present and consistent with the aggregate `CaptureStatus`.
- Overclaiming lint: zero forbidden phrases (see the capture completeness document).
- Emulation boundary statement: present verbatim.

## Judge

`judge.ts` is an LLM judge and is explicitly secondary.

Rules:

1. A judge score is **never** the sole basis for a pass or fail. It is reported alongside
   deterministic scores.
2. A judge may only be used for properties that are genuinely not decidable deterministically:
   whether a hypothesis statement is coherent with its cited evidence, whether a report reads as
   actionable for a developer, whether an experiment rationale is non-circular.
3. Judge prompts are versioned flow artifacts like any other, under
   `/ai/flows/_judges/<judge-id>/`, and are hashed and recorded.
4. Judge outputs are schema-validated like any other AI output.
5. Judge cases include *calibration items* with known-good and known-bad answers. If the judge
   fails calibration on a run, its scores for that run are discarded and reported as
   `judge-uncalibrated` rather than being used.
6. A judge is never used to score its own flow's model alias when that would create a shared-bias
   loop; judges default to `FAST_MODEL` while the flows under test that use `REASONING_MODEL` are
   judged with an explicit note when the aliases resolve to the same model ID.

## Reports and baselines

Each run writes `/eval/reports/<timestamp>-<flowId>-<flowVersion>.json` containing per-case
results, aggregate metrics, usage, cost, and the flow hash.

`/eval/reports/baselines.json` records, per `(flowId, flowVersion, mode)`, the accepted metric
values. Rules:

- A PR that changes a flow artifact must run the flow's eval suite in replay mode and must not
  regress any gate metric.
- A flow version bump must not regress live-mode metrics below the prior version's baseline.
- Baselines are raised deliberately, in a commit that says so. They are never lowered to make a
  build green; a genuine regression is either fixed or the milestone slips.

## CI integration

| Trigger | Modes run | Blocking |
| --- | --- | --- |
| Every PR touching `/ai/flows`, `/schemas`, `packages/ai-*`, `packages/tools` | replay, all flows at or below the current milestone | Yes |
| Every PR (any) | replay, smoke subset | Yes |
| Nightly | live, all flows | No, but a regression opens an issue and blocks the next version bump |
| Flow version bump | replay + live for that flow | Yes |

CI requires no API key for blocking jobs. `live` jobs read the key from CI secrets and are skipped
cleanly when it is absent.
