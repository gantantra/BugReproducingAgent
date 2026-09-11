# Test Data, Setup, Cleanup, and Side-Effect Controls

Status: M0 frozen candidate

## Governing principle

Playwright produces evidence. Deterministic software normalizes and measures evidence. DeepSeek interprets and prioritizes evidence. Humans authorize consequential transitions.

## The problem

An intermittent-issue investigation runs the same sequence dozens or hundreds of times. If that
sequence writes data, the Nth run does not start from the same state as the first, which both
corrupts the experiment (state drift becomes a confound) and can cause real damage in a shared test
environment.

## Environment classification

Every target declares a classification, and the classification gates behaviour:

| Classification | Meaning | Allowed |
| --- | --- | --- |
| `fixture` | A local fixture app from `packages/test-fixtures`, no external state | Everything, including destructive actions, with no acknowledgement |
| `test` | An authorized test environment with disposable data | Read actions freely; write actions with declared reset strategy; destructive actions with per-sequence acknowledgement |
| `staging` | An authorized shared pre-production environment | Read actions freely; write actions with declared reset strategy **and** per-sequence acknowledgement; destructive actions blocked unless `safety.blockDestructiveActions: false` is set *and* acknowledged per sequence |
| `production` | Rejected at config load | Nothing. `EXEC_PRODUCTION_GUARD` |

`safety.productionGuard` additionally rejects any origin matching `productionOriginPatterns`
regardless of declared classification, so a mislabelled target is caught.

## Action side-effect classification

Every action in the closed vocabulary carries a static `sideEffect` classification, and the
deterministic classifier computes an effective classification per action instance:

| Class | Examples | Handling |
| --- | --- | --- |
| `read` | `goto`, `waitFor`, `assert`, `screenshot`, `scroll`, `hover` | Always allowed within `allowedOrigins` |
| `local-write` | `fill`, `select`, `check`, `setStorage` | Allowed; state is reset by context isolation |
| `remote-write` | `click` on a submit control, `submitForm`, `request` with a non-idempotent method | Requires a declared reset strategy on `test`/`staging` |
| `destructive` | Actions matching the destructive pattern set: text or accessible name matching delete/remove/cancel/deactivate/purge/refund/pay/transfer patterns; `request` with `DELETE`; navigation to a path matching configured destructive path patterns | Requires per-sequence `safetyAcknowledgements` and is blocked outright on `staging` by default |

The classifier is deterministic and its pattern set is config-visible. It errs toward
`destructive`: an ambiguous control is classified destructive, which costs one acknowledgement line
and prevents one bad afternoon.

The model can *propose* an action and *declare* a classification, but the recorded classification
is the deterministic classifier's. A proposal whose declared classification is weaker than the
computed one fails schema validation on the proposal, so the disagreement is visible at gate 1
rather than at run time.

## Isolation, by default

Every run gets:

1. a fresh Playwright browser **context** (separate cookie jar, storage, cache),
2. a fresh temp profile directory, deleted after the run,
3. an explicitly seeded storage state if the experiment declares one, applied before the first
   navigation and recorded as an artifact reference (not inlined, since it may contain tokens),
4. a per-run correlation header (`X-Investigator-Run-Id`) when the target declares it acceptable, so
   server-side logs can be joined later by a human. Off by default; declared per target.

Browser-level state (contexts, storage, caches) therefore never leaks between runs. What does not
reset is server-side state, which is what the reset strategy addresses.

## Reset strategies

Declared per target, executed deterministically by the executor, never by AI:

| Strategy | Mechanism | Notes |
| --- | --- | --- |
| `none` | Nothing | Only valid when every action is `read` or `local-write` |
| `fresh-context` | New context per run | Default; covers client state only |
| `seeded-storage-state` | Apply a recorded storage state before each run | Recorded as an artifact; secrets inside come from env at apply time |
| `scripted-reset` | Run a declared reset script before each run | The script is a first-class, human-authored, version-controlled file. It is not AI-generated and not AI-editable. Its output is captured as an artifact and a non-zero exit is `INFRASTRUCTURE_FAILED` |
| `per-run-tenant` | Allocate a fresh tenant/account per run from a declared pool | Pool exhaustion is `INFRASTRUCTURE_FAILED`, never a silent reuse |
| `idempotent-only` | Assert the sequence contains no `remote-write` | Enforced statically before enqueue |

If a sequence contains `remote-write` or `destructive` actions and the target declares `none` or
`fresh-context`, enqueue is refused with a typed error naming the offending actions. This is a
static check at `investigate run`, before any browser launch.

## Test data

- Test data values are supplied by the human in the intake report or the target definition, or
  generated deterministically from the run seed by a declared generator (for example
  `email: user+{seed}@example.invalid`). Generators are a closed set in config.
- The model may not invent test data. `intake_to_flow` emits needed values into `unknowns` for the
  human to fill; `propose_experiments` may only reference declared data or declared generators. A
  proposal containing a literal that looks like a credential, an email at a real domain, a card
  number, or a phone number fails schema validation.
- Credentials never appear in config, proposals, manifests, or artifacts. Auth strategies reference
  environment variable names, resolved at run time through `SecretStore`, and the resulting storage
  state is redacted before persistence.

## Cleanup

Per run, in a `finally` block that runs even on interruption:

1. Close the context and browser.
2. Delete the temp profile directory.
3. Flush and seal the manifest.
4. Release in-memory raw buffers.

Per investigation, on demand (`investigate retention apply`):

1. Delete artifacts older than `retention.artifactDays`, except reproducer packages when
   `retention.keepReproducers` is true, and except any artifact referenced by an approved finding
   in a rendered report.
2. Never delete manifests, lineage, approvals, or the AI call ledger. Deleting an artifact records
   a lineage-adjacent tombstone so a later reference-validation failure is explainable as
   "expired", not "fabricated".
3. Require explicit confirmation; refuse in `--json` mode without `--confirm`.

## Execution budgets and stop conditions

| Control | Default | Effect |
| --- | --- | --- |
| `execution.runWallClockBudgetMs` | 180000 | Per-run ceiling; exceeded is `INCONCLUSIVE` |
| `safety.maxRunsPerInvestigation` | 500 | Hard stop on enqueue |
| `safety.maxWallClockMsPerInvestigation` | 7200000 | Hard stop on claim |
| `--stop-after-failures <n>` | unset | Stop the batch after n `PRODUCT_FAILED` runs |
| `--stop-on-confidence <p>` | unset | Stop `frequency run` once the Wilson interval half-width is below the implied precision |
| `execution.maxInfraRetriesPerRepetition` | 2 | Bounds infrastructure retries |
| Circuit breaker on target unreachability | 5 consecutive `INFRASTRUCTURE_FAILED` | Stops the batch with a typed error rather than hammering a broken environment |

Every stop condition that ends a batch early records why, and the frequency statistics report the
achieved n rather than the requested n. A truncated batch never presents itself as a full one.

## Production-impact guards, summarised

1. `production` classification rejected at config load.
2. `productionOriginPatterns` rejected at navigation time.
3. `allowedOrigins` allowlist; navigation outside it aborts the run.
4. Destructive actions require per-sequence human acknowledgement recorded in the approval.
5. `remote-write` requires a declared reset strategy.
6. No AI-generated code is ever executed. The action interpreter runs a closed vocabulary; there is
   no `eval`, no `page.evaluate` with model-supplied source, and no shell execution from AI output.
7. Reset scripts are human-authored files, referenced by path, never generated.
