# End-to-End Example

Status: M0 frozen candidate
Purpose: one worked investigation touching every stage, every gate, and every artifact type.

## Governing principle

Playwright produces evidence. Deterministic software normalizes and measures evidence. DeepSeek interprets and prioritizes evidence. Humans authorize consequential transitions.

## The scenario

A QA engineer reports: "On the search results page in Chrome mobile, sometimes when I tap a filter
right after the page loads, the results list goes blank and stays blank. Maybe one in twenty
times. Reloading fixes it. I have seen it on the staging build for about a week."

Target: `search-staging`, classification `staging`, base URL
`https://search.staging.internal.example`.

## Stage 0 — init

```bash
investigate init
```

Creates `.investigator/` with a migrated `investigator.db`, a default `config.yaml`, `prompts/`,
and `investigations/`. The operator edits `config.yaml` to add the target, the origin allowlist,
and the `pixel-7-chrome-mobile` emulation profile.

## Stage 1 — intake

`reports/blank-results.md`:

```markdown
# Blank results after tapping a filter
Environment: search-staging, Chrome mobile
Frequency: roughly 1 in 20
Steps: open search results, tap the "Verified" filter immediately after load
Expected: filtered results render
Actual: results list is blank and stays blank; reload recovers
Notes: only seen on mobile; started about a week ago
```

```bash
investigate intake --from reports/blank-results.md --env search-staging
```

**AI: `intake_to_flow`** (`FAST_MODEL`, no tools, budget 3 turns / 6k in / 2k out / $0.05 / 60s).

Output `FLOW-001`, validated:

```json
{
  "flowId": "FLOW-001",
  "schemaVersion": "1.0.0",
  "steps": [
    { "stepId": "S1", "description": "Open the search results page",
      "actions": [ { "actionId": "A1", "type": "goto",
                     "url": "https://search.staging.internal.example/search?q=laptop" } ] },
    { "stepId": "S2", "description": "Tap the Verified filter immediately after load",
      "actions": [ { "actionId": "A2", "type": "waitFor", "condition": "domcontentloaded" },
                   { "actionId": "A3", "type": "click",
                     "selector": { "strategy": "role", "role": "button", "name": "Verified" } } ] },
    { "stepId": "S3", "description": "Observe the results list",
      "actions": [ { "actionId": "A4", "type": "assert",
                     "assertion": { "kind": "elementCountAtLeast",
                                    "selector": { "strategy": "testid", "value": "result-card" },
                                    "min": 1, "timeoutMs": 5000 } } ] }
  ],
  "assumptions": [
    "The search query used by the reporter is unknown; `q=laptop` is a placeholder.",
    "\"Immediately after load\" is interpreted as after domcontentloaded, before network idle."
  ],
  "unknowns": [
    { "id": "U1", "field": "searchQuery", "why": "The report does not state the query used." },
    { "id": "U2", "field": "authState",
      "why": "The report does not say whether the reporter was signed in." }
  ]
}
```

Note what the flow did **not** do: it did not invent a login, a credential, or a URL outside the
allowlist. The two ungroundable values went into `unknowns`.

The operator fills the unknowns by editing the flow input and re-running intake, or by supplying
them at gate 1. Say they set `q=laptop` and `authState: anonymous`.

Lineage so far: `RPT-001 --interpreted_as--> FLOW-001`, actor `ai`, with `AIC-001`.

## Stage 2 — plan

```bash
investigate plan
```

**AI: `propose_experiments`** (`REASONING_MODEL`, tools `get_flow`,
`get_application_constraints`, `get_previous_experiment_summary`).

Five ranked proposals, each with a hypothesis, a varied factor, and a falsifier:

| Rank | ID | Hypothesis | Varied factor | Falsifier |
| --- | --- | --- | --- | --- |
| 1 | EXP-001 | The tap races an in-flight results request; the filter response is applied before the initial response, which then overwrites it with stale-empty state | Tap timing relative to the initial results request | Failure incidence does not change across tap-delay buckets |
| 2 | EXP-002 | Throttled network widens the race window | Network profile `fast-3g` vs unthrottled | Incidence is unchanged under throttling |
| 3 | EXP-003 | CPU throttling widens the window | CPU rate 4 vs 1 | Incidence unchanged |
| 4 | EXP-004 | Mobile-specific code path only | Emulation profile mobile vs desktop | Incidence equal on desktop |
| 5 | EXP-005 | Cold cache only | Fresh context vs warmed cache | Incidence equal with a warm cache |

Written as a gate-1 proposal triple:

```
investigations/INV-001/manifests/
  gate-1.experiment_selection.proposal.json         sha256:3f2a9c...e41b
  gate-1.experiment_selection.proposal.json.sha256
  gate-1.experiment_selection.proposal.md
```

The CLI prints the exact next command.

## Stage 3 — GATE 1

The operator reviews the markdown, rejects EXP-003 and EXP-005 as low-yield, and edits repetitions
upward because the reported incidence is 1 in 20.

`approvals/gate-1.approval.yaml`:

```yaml
schemaVersion: "1.0.0"
gate: experiment_selection
investigationId: INV-001
proposalChecksum: "sha256:3f2a9c...e41b"
decision: approve
approver: { name: "Gantantra Agrawal", method: local-file }
decidedAt: "2026-09-10T09:12:00Z"
approvedItemIds: [EXP-001, EXP-002, EXP-004]
edits:
  - itemId: EXP-001
    path: /repetitions
    from: 20
    to: 60
    rationale: "Reported incidence is roughly 1 in 20; 60 gives a usable interval."
notes: "EXP-003 and EXP-005 rejected as low-yield for a first pass."
```

```bash
investigate approve experiment_selection \
  --from approvals/gate-1.approval.yaml --checksum 3f2a9c...e41b
```

Seven checks pass. `APPR-001` is written, the effective post-edit proposal is stored as its own
artifact, and lineage gains `EXP-001 --approved_as--> AEXP-001 --governed_by--> APPR-001`.

The runs are `remote-write`-free (search and filter are reads), so the `staging` reset strategy
`fresh-context` is sufficient and enqueue is permitted. No destructive actions, so no
acknowledgements are required.

## Stage 4 — run

```bash
investigate run
```

180 jobs enqueued (60 + 60 + 60). One worker, `maxParallelRuns: 1`. For each:

- `jobs` row -> `RUNNING`
- manifest opened with resolved emulation read back from the browser (`deviceScaleFactor: 2.625`,
  observed `browserVersion`, `timezoneId: Asia/Kolkata`), the derived seed, the
  `effectiveProposalChecksum`, and `APPR-001`
- Playwright drives A1..A4; the collector records actions, navigation, console, exceptions, network
  metadata, DOM snapshots on action boundaries, screenshots, video, trace
- collection-time redaction masks the session cookie value and the `Authorization` header on the
  API calls; `hash-value` is used for the session cookie so cross-run identity is comparable
- artifacts written, hashed, `artifact_refs` inserted
- normalized redacted evidence written
- manifest sealed with `RunOutcome`, `outcomeRuleId`, `captureStatus`, artifact digest list
- `jobs` row -> `TERMINAL`/`COMPLETED`

Results: EXP-001 gives 4 `PRODUCT_FAILED` in 60; EXP-002 gives 11 in 60; EXP-004 (desktop) gives 0
in 60. Two runs hit a transient staging 502 during setup and are `WORKER_ERROR`/
`INFRASTRUCTURE_FAILED`; both are retried as new attempts and their repetitions get valid
observations on attempt 2. One run is `INCONCLUSIVE` because `domSnapshots` was `partial`
(`TARGET_DETACHED`) while assertions passed.

`captureStatus` for a typical run: everything `complete` except
`responseBodies: partial` (74 not captured by content type, 3 over the size limit) and
`webSocketFrames: unsupported`.

## Stage 5 — classify

```bash
investigate classify
```

Deterministic extraction first: status distributions, request ordering fingerprints, aborted-request
counts, console-error counts, exception fingerprints, DOM-diff summaries, storage diffs, navigation
differences, integrity checks, and an independent recomputation of every `RunOutcome` (all agree
with the executor).

Two candidate signatures emerge deterministically:

- `SIG-001`: `elementCountAtLeast(result-card, 1)` failed **and** normalized console text
  fingerprint `cf_9a12` (`"applyFilters: results undefined"`) present. 14 runs.
- `SIG-002`: assertion failed, no console error. 1 run.

**AI: `classify_runs`** (`FAST_MODEL`, partial-capable). Assigns each of the 180 runs to a cluster,
names `SIG-001` "blank results with undefined-results console error", and flags `SIG-002` as a
distinct single-run cluster likely caused by the detached target rather than the product.

Gate-2 proposal written.

## Stage 6 — GATE 2

The operator approves `SIG-001` as the target failure signature and accepts the cluster
assignment, moving the `SIG-002` run into an `excluded` cluster with the note "target detached;
evidence incomplete". `APPR-002` written; `ASIG-001` created.

Gate 2 permits editing the predicate; the operator tightens it to require the console fingerprint,
because the assertion alone also matched the detached-target run.

## Stage 7 — frequency

```bash
investigate frequency run --repeat 100 --experiment EXP-002
```

EXP-002 (throttled) is chosen because it has the highest incidence and therefore the best
statistical power. 100 repetitions, 98 valid observations, 2 repetitions with no valid observation
(infrastructure). 19 matches of `ASIG-001`.

`STAT-001`: rate 0.194, Wilson 95% [0.127, 0.283], achieved n 98, requested 100, no-valid-
observation count 2.

Compared against unthrottled EXP-001: 4/60 = 0.067, Wilson [0.026, 0.161]. Intervals do not
overlap, so a `probable_trigger` claim about throttling is admissible.

## Stage 8 — analyze

```bash
investigate classify   # re-run to refresh comparisons, then:
```

**AI: `analyze_pass_fail`** (`REASONING_MODEL`, tools `compare_run_timelines`, `get_request`,
`get_response_excerpt`, `get_dom_diff`, `get_storage_diff`; partial-capable).

Findings produced, validated, persisted:

```json
[
  { "findingId": "FIND-001", "level": "observed",
    "statement": "In failing runs the initial results request finishes after the filter request.",
    "supportingEvidence": [
      { "kind": "event", "runId": "RUN-023", "eventIds": ["EV-0114","EV-0131"],
        "field": "/timing/responseEndDeltaMs", "expectedValue": 2841 },
      { "kind": "comparison", "comparisonId": "CMP-002",
        "runIdsA": ["RUN-023","RUN-041"], "runIdsB": ["RUN-007","RUN-012"] }
    ],
    "contradictingEvidence": [], "confidence": 0.94 },

  { "findingId": "FIND-002", "level": "correlated",
    "statement": "The console error `applyFilters: results undefined` occurs only in runs where that ordering inversion is present.",
    "supportingEvidence": [
      { "kind": "event", "runId": "RUN-023", "eventIds": ["EV-0140"],
        "field": "/textFingerprint", "expectedValue": "cf_9a12" },
      { "kind": "comparison", "comparisonId": "CMP-003", "runIdsA": ["..."], "runIdsB": ["..."] }
    ],
    "contradictingEvidence": [], "confidence": 0.9 },

  { "findingId": "FIND-003", "level": "probable_trigger",
    "statement": "Network throttling increases the incidence of the approved failure signature.",
    "supportingEvidence": [
      { "kind": "statistic", "investigationId": "INV-001", "statisticId": "STAT-001",
        "field": "/rate", "expectedValue": 0.194 },
      { "kind": "statistic", "investigationId": "INV-001", "statisticId": "STAT-002",
        "field": "/rate", "expectedValue": 0.067 }
    ],
    "contradictingEvidence": [], "confidence": 0.88 },

  { "findingId": "FIND-004", "level": "root_cause_hypothesis",
    "statement": "Hypothesis: the filter handler renders from a shared results variable that the later-arriving initial response overwrites with an empty payload, so the last write wins and the list is cleared.",
    "supportingEvidence": [
      { "kind": "event", "runId": "RUN-023", "eventIds": ["EV-0140"] },
      { "kind": "comparison", "comparisonId": "CMP-002", "runIdsA": ["..."], "runIdsB": ["..."] }
    ],
    "contradictingEvidence": [], "confidence": 0.72 }
]
```

What the validator did along the way:

- A draft `FIND-003` at `high_confidence_trigger` was **demoted** to `probable_trigger` with a
  warning, because no matched control set existed at that point.
- A draft finding citing `EV-0999` was rejected with `AI_REFERENCE_MISMATCH`; that event does not
  exist in `RUN-023`.
- A draft finding citing the response body of the initial results request was **capped at
  `correlated`** because `responseBodies` is `partial` for those runs.
- A draft `confirmed_root_cause` for FIND-004 was rejected with `AI_CLAIM_UNSUPPORTED`. The MVP has
  no command that mints a `direct_evidence_attestation`, so the level is `root_cause_hypothesis`
  and the report will say so.

## Stage 9 — minimize

```bash
investigate minimize --max-rounds 3 --repeat-per-candidate 40
```

**AI: `suggest_minimization`** proposes, in order: drop the explicit `waitFor` and click on
`domcontentloaded` directly; replace `goto` with a direct filtered URL; remove the search query
term.

Deterministic execution measures each:

| Candidate | Actions | Retained rate (n=40) | Verdict |
| --- | --- | --- | --- |
| MIN-001: drop `waitFor`, click at a fixed 120ms offset | 3 | 0.175 [0.086, 0.325] | retained |
| MIN-002: navigate directly to the filtered URL | 2 | 0.000 [0.000, 0.087] | lost — signature gone |
| MIN-003: MIN-001 with the query shortened | 3 | 0.150 [0.070, 0.296] | retained |

MIN-002 losing the signature is itself informative and is reported: the defect requires the
in-page filter interaction, not merely the filtered URL.

MIN-003 accepted: reduction ratio 0.25 by action count, retained rate lower bound 0.070 versus a
pre-minimization rate of 0.194, i.e. 0.36 of the original — which is **below** the 0.80 retention
threshold. So the accepted candidate is MIN-001 (0.086/0.194 = 0.44, also below threshold).

This is a realistic outcome and the system handles it honestly: the retention threshold is not met
by any candidate, so `investigate minimize` reports that no candidate meets the threshold and
proposes gate 3 with the best available candidate plus an explicit warning. The operator may accept
it with the warning recorded, or request further reduction. They accept MIN-001 and note that a
120ms fixed offset is inherently rate-reducing.

A **passing control** is generated deterministically: MIN-001 with the click delayed until network
idle. 40 runs, 0 failures, [0.000, 0.087].

## Stage 10 — revalidate

```bash
investigate revalidate --repeat 60 --include-control
```

Reproduction: 9/60 matches of `ASIG-001`, rate 0.150 [0.081, 0.263]. Control: 0/60, [0.000,
0.060]. Intervals disjoint. Artifact integrity: all pass. Manifest seals: all valid.
`REPRO-001` created.

FIND-003 is re-evaluated and promoted to `high_confidence_trigger` for the *timing* factor, since
a matched control now exists differing only in the click timing. FIND-004 remains
`root_cause_hypothesis`.

## Stage 11 — GATE 3

The operator reviews the reproducer, approves it, and records the caveat about the fixed offset.
`APPR-003`, `AREPRO-001`.

## Stage 12 — report and export

```bash
investigate report --out reports/INV-001.md
investigate export --out exports/INV-001.zip
```

**AI: `generate_report`** (`REASONING_MODEL`, tools `get_investigation_summary`,
`get_approved_findings`, `get_validation_results`, `get_artifact_references`).

The rendered report contains:

- **Summary**: blank results after tapping a filter immediately post-load; reproduced at 15% under
  emulated throttled Chrome mobile.
- **Environment**: target, classification, and the verbatim emulation boundary statement with the
  resolved values, including that this is Chromium with mobile-emulation parameters and not real
  Android Chrome.
- **Reproduction**: the MIN-001 sequence, the seed, the resolved emulation, and the measured rate
  with its interval.
- **Passing control**: the same sequence with the click at network idle, 0/60.
- **Findings**: FIND-001 through FIND-004 at their validated levels, each with citations.
- **Explicit non-claim**: "No confirmed root cause. FIND-004 is a hypothesis. Confirming it
  requires source-level or instrumented evidence, which this investigation did not have."
- **Evidence completeness**: `responseBodies` partial with counts and reasons;
  `webSocketFrames` unsupported; the one excluded run and why.
- **Limitations**: the retention threshold was not met by any minimization candidate; the fixed
  120ms offset reduces incidence relative to the original interaction.
- **Artifacts**: `ArtifactRef` table with IDs, kinds, sizes, and SHA-256 values.
- **Lineage**: the chain from `RPT-001` to `RPTOUT-001` with `actor.kind` on every hop.

The renderer refuses to emit if any finding fails reference validation, and the overclaiming lint
finds no forbidden phrases.

`investigate export` re-runs redaction verification over every included artifact (clean),
re-verifies every hash (clean), and writes the bundle containing the reproducer package, a
standalone Playwright spec, the report, the manifests, and the referenced artifacts.

## What a human still owns at the end

Which experiments were worth running, what failure was being chased, whether the predicate was
right, whether the reduced case is acceptable, and whether the hypothesis is worth a developer's
time. The agent produced the evidence, the measurements, and the traceable argument; it did not
decide.
