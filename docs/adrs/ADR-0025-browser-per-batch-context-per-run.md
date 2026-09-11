---
adr: 0025
title: One browser per batch, one fresh context per run
status: accepted
date: 2026-09-11
touches: [execution, evidence]
supersedes: none
---

# ADR-0025 — One browser per batch, one fresh context per run

## Governing principle

Playwright produces evidence. Deterministic software normalizes and measures evidence. DeepSeek interprets and prioritizes evidence. Humans authorize consequential transitions.

## Context

The M1 worker launched a new Chromium process for every run and closed it afterwards. A 100-run
reliability batch therefore performed 100 launches. That batch failed reliability, intermittently,
with 1 to 6 runs classified `INFRASTRUCTURE_FAILED` per 100.

The completion audit escalated this because the failures were not merely noise: the performance
spec had been written to tolerate them (asserting only that retries were "bounded and linked"),
so the gate passed while printing "4 infrastructure retries occurred". A criterion that is
tolerated rather than met is a false green.

### Measured evidence

With diagnostics added to carry the underlying launch error into the manifest's `outcomeDetail`,
every failure resolved to one cause:

```
EXEC_BROWSER_LAUNCH_FAILED: Chromium failed to launch:
  browserType.launch: Target page, context or browser has been closed
```

Two isolating probes, neither containing any ReproAgent code:

| Probe | Result |
| --- | --- |
| 100 sequential `chromium.launch()` + `close()` | **4 failures / 100** |
| 1 `chromium.launch()` + 100 `newContext()` / `close()` | **0 failures / 100** |

The failure is a property of repeatedly launching Chromium on this platform, not of the worker,
the queue, the fixture server, or the evidence path. Port allocation, database contention, file
handles and artifact writes were all ruled out by the first probe reproducing the failure without
any of them present.

## Decision

A worker owns **one browser for the whole batch**, launched on first use and closed when `drain`
finishes. Each run gets a **fresh `BrowserContext`**, which is closed when the run ends.

A bounded pre-run launch retry (3 attempts) covers the residual case where the single launch is
the one that fails.

## Why a context is the correct isolation boundary

The configured per-target `resetStrategy` is already named `fresh-context`. A `BrowserContext` has
its own cookies, storage, cache, permissions and session state, which is precisely the isolation a
repetition requires. Launching a whole browser bought no additional isolation for the properties
this system measures — it bought 100 chances to hit a launch race.

Consequences, all verified by the reliability gate rather than assumed:

- Repetitions remain independent: no storage, cookie or cache state crosses a context boundary.
- Emulation is unaffected: profile values are applied at context creation and still read back from
  the live context, so ADR-0014 is untouched.
- The batch is faster, because 99 process launches and 99 process teardowns disappear.
- The per-run temporary directory is now created only when video recording is enabled. It existed
  to hold a browser profile that `chromium.launch()` never used, and deleting it on every run
  raced with the exiting browser on Windows.

## The launch retry is not a run retry

This distinction is the reason the retry is permissible at all, and it is load-bearing:

| | Pre-run launch retry (this ADR) | Run-level infrastructure retry (ADR-0005) |
| --- | --- | --- |
| A run has started | no | yes |
| Evidence collected | none | yes |
| Creates a job row | no | yes, a new linked attempt |
| Increments `attemptIndex` | no | yes |
| Appears in statistics | no | yes, permanently |
| Counted by the zero-retry criterion | no | yes |

The launch retry cannot hide a product failure or an infrastructure failure, because at the point
it runs nothing has been observed: no navigation, no action, no assertion. If all three attempts
fail, `EXEC_BROWSER_LAUNCH_FAILED` is raised, the run is classified `INFRASTRUCTURE_FAILED` by
rule 2, and the batch fails loudly. A genuinely broken environment is still reported as broken.

What this ADR explicitly does **not** do: raise a timeout, increase `maxInfraRetriesPerRepetition`,
reclassify an outcome, weaken an assertion, or reduce the 100-run count. The zero-retry criterion
in `docs/m0-decisions.md` stands unchanged and is now fully asserted in
`tests/reliability/same_test_100_runs.spec.ts`.

## Residual risk

A browser that dies mid-batch is detected through `browser.isConnected()` and replaced on the next
run rather than reused. A crash between runs therefore costs one relaunch, not a failed batch.

The underlying Playwright launch flakiness is not fixed by this ADR — it is avoided. If a future
milestone needs many concurrent browsers (`maxParallelRuns > 1`), the per-launch failure rate
returns in proportion to the number of launches, and that path will need the same measurement
before it is trusted.

## Alternatives rejected

| Alternative | Why rejected |
| --- | --- |
| Raise `maxInfraRetriesPerRepetition` | Hides the defect behind retries; explicitly forbidden by decision 3 |
| Relax the criterion to "retries bounded" | This is exactly what produced the false green the audit caught |
| Raise the launch timeout | No evidence the failure is a timeout; the error is "target closed", and guessing at timeouts is forbidden without evidence |
| Reclassify launch failure as non-infrastructure | It genuinely is an infrastructure failure; misclassifying it to get a pass would corrupt rule 2 |
| `launchPersistentContext` per run | Still one process launch per run, so it keeps the failure mode |
