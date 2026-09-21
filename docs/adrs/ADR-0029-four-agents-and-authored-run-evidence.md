---
id: ADR-0029
title: Four agents, and every authored-suite run recorded by the measured path's own collector
status: accepted
date: 2026-09-21
touches: [cli, web, execution, evidence, storage]
decision: Split the product into Planner, Reproducer, Executor and Investigator over the existing commands, and give `investigate rerun` full evidence capture by running the unchanged suite through a run-time copy whose only difference is a fixture that attaches the existing `Collector` -- instead of shipping a runtime package that emitted suites import.
consequences: Every rerun is stored as a batch the Investigator reads; emitted suites stay plain `@playwright/test` and portable; old and new suites take one path; authored runs never enter the measured path's `runs` table, so the 100-run gate and measured-run analysis are untouched.
---

# ADR-0029 — Four agents, and evidence from every authored-suite run

## Governing principle

Playwright produces evidence. Deterministic software normalizes and measures evidence. DeepSeek interprets and prioritizes evidence. Humans authorize consequential transitions.

## Context

ADR-0027 split authoring from measurement, and ADR-0028 carried an authored session into the measured path by translation. In practice operators measure the authored script itself with `investigate rerun`, and before this change that produced a pass/fail count and a video per run -- nothing the Investigator could read.

## Decision

### Four agents over the existing commands

| Agent | Commands | Kind |
|---|---|---|
| Planner | `author` planning turns, `--answer`, `--thats-all`, `--plan-checksum` | AI, no browser |
| Reproducer | `author --approve-plan / --resume / --repair` | AI driving Playwright MCP |
| Executor | `rerun`, and `confirm` for a confirmation | deterministic |
| Investigator | `analyze [--batch]`, `confirm` | deterministic contrast, then AI reading |

The approved plan is bound to its bytes (`--plan-checksum`) and recorded in lineage with a deterministic actor. It authorizes an attended authoring session, never a measured run, so it is not one of the three approval gates.

### Capture by the measured path's own collector

`rerun` writes a copy of the suite's tests into `suite/.reproagent/`, identical except for the `@playwright/test` import, which points at a fixture. The fixture calls `startSuiteCapture` (packages/execution), which attaches the same `Collector` the measured path uses. Collection-time redaction therefore runs in the suite's own worker before anything is buffered (ADR-0008), with the workspace's redaction policy and every stored credential value masked by identity. The credential values come from the suite's environment, which already carried them for the script to type, so capture adds no new place a value travels. Only redacted raw logs are written, into a staging folder `rerun` ingests and deletes. Before storing, `rerun` masks the credential values once more in the raw logs, so a collector that missed one cannot put it in the store.

Line numbers are unchanged, so "failed at the final check" means the same line in the copy and in the suite. A spec that loads Playwright any other way cannot be instrumented. It runs exactly as before, and the result says `capture: { supported: false, reason }`.

### Why not a runtime package

The approved plan had new suites import `@reproagent/runtime`. It was replaced because:
- a separately installed package cannot import the workspace's `Collector` and `Redactor` without bundling or publishing them, so capture would have been written a second time;
- a suite would stop running on a machine without that package;
- `@investigator/*` would have needed a namespace exception;
- old and new suites would have taken two paths.

The run-time copy has none of these costs.

### Storage without touching the measured path

Each repeat becomes an authored run (`ARUN-<batch>-<n>`) with:
- its raw event log
- its normalized evidence from `runPlane`
- its recording, stamped `video-raw-unredactable`

A `rerun-batch` record lists each run's classification and outcome, the suite's checksum, and whether capture was supported. Authored runs have no job and no row in `runs`, so measured-path queries, the 100-run gate and `analyze` of measured runs are unaffected.

Outcomes come from the existing six rules, via their existing inputs:
- a failure at the final check is a failed assertion (`PRODUCT_FAILED`)
- a stop earlier is an automation failure (`AUTOMATION_FAILED`)
- a pass is a passed assertion (`VALID_COMPLETED`)
- a run that failed before any step is an infrastructure failure (`INFRASTRUCTURE_FAILED`)

`analyze --batch <id>` reads a batch. Without the flag it reads measured runs as before, falling back to the latest batch only when there are none, which used to be a refusal.

## Consequences

- `rerun --json` gains `capture`, `evidenceIngested`, `batchId`, `runIds`, `evidenceQualityRef`, `batchRef` and `evidenceError`. Every earlier field is unchanged.
- The script's own statements are not seen as actions, so `actions` is `unsupported` for authored runs rather than looking complete.
- Request timing is what the existing collector records (start and response-end deltas); richer timing is a collector change, not a capture change.
- Tests:
  - `apps/cli/src/rerun-capture.spec.ts` covers the copy, classification, outcomes and the credential backstop, which is mutation-checked.
  - `tests/e2e/rerun-capture.test.ts` runs a real browser against a fixture that fails on every third run.
