# ReproAgent

A standalone local CLI agent that investigates intermittent Chrome-based web issues.

> Playwright produces evidence. Deterministic software normalizes and measures evidence. DeepSeek
> interprets and prioritizes evidence. Humans authorize consequential transitions.

That sentence is the architectural contract, not a slogan. Browser execution and evidence capture
are deterministic and never call a model; a model never decides an outcome, a statistic, or an
approval. Any change that violates it is rejected regardless of convenience or test coverage.

**Internal package identifiers are `@investigator/*`.** ReproAgent is the product name; the
namespace was deliberately not renamed (`docs/m0-decisions.md`).

## Status

| Milestone                                                  | State                                                     |
| ---------------------------------------------------------- | --------------------------------------------------------- |
| M0 — architecture, ADRs, schemas                           | Accepted with recorded corrections (`docs/FREEZE-M0.md`)  |
| M1 — deterministic execution and evidence core             | Implemented; gate green, 100/100 with zero retries        |
| M2 — lineage, the three approval gates, CLI workflow       | Implemented                                               |
| M3 — AI gateway, flows, read-only tools, eval harness      | Implemented; `intake --ai` verified against live DeepSeek |
| M4–M8 — classification, frequency, minimization, reporting | **Not implemented**                                       |

M1 is the deterministic foundation: it executes an experiment in Chromium, captures evidence,
redacts before persistence, normalizes deterministically, and classifies the run.

M2 adds what makes the governing principle real: **nothing reaches a browser without a recorded
human decision.** `investigate run` refuses unless gate 1 is approved; the approval is bound by
SHA-256 to the exact proposal bytes a human read; and what executes is the _effective_ proposal —
the post-edit document — never the one that was merely proposed. Provenance is recorded in an
append-only, hash-chained lineage graph that answers "what authorised this run?" offline.

M3 adds interpretation, strictly bounded: a provider gateway with typed error classification and
six-dimension budgets, three versioned flows under `ai/flows/`, read-only tools that cannot reach
a browser, and a validation pipeline that refuses to persist output failing schema or reference
checks. `investigate analyze` sits on top and is deliberately two-part — see below.

M4 through M8 are not built: run clustering, failure-frequency statistics with confidence
intervals, minimization, and Jira-ready reporting. The CLI is honest about it — every
unimplemented command is registered and exits 1 naming its milestone.

```bash
node apps/cli/dist/bin.js classify                  # -> NOT_IMPLEMENTED, "Arrives in M4"
```

## Install

Requires Node **22.5+** — the floor where `node:sqlite` exists (ADR-0021) — and roughly 400 MB
for the Chromium download. Developed and verified on Node 24.

```bash
npm ci
npm run build
npx playwright install chromium chromium-headless-shell
```

The CLI declares a `bin`, so `npm link` gives you `investigate` on the PATH. Without linking,
invoke it directly:

```bash
node apps/cli/dist/bin.js --help
```

**No DeepSeek credential is needed for any deterministic command.** `init`, `run`, `doctor`,
`suite generate`, the whole approval workflow, and the measured half of `analyze` all work with no
AI environment variable set at all. AI configuration resolves lazily, at the point of use, so a
missing or broken credential cannot stop deterministic work. Enforced by test and by CI, not
merely intended.

## Demo

```bash
npm run demo
```

One command, about 40 seconds, no DeepSeek key required. It walks the whole working story:
intake, proposal, a refused run, a human approval with an edit, a real Chromium run, provenance,
and a standalone Playwright suite. See [DEMO.md](DEMO.md) for what each chapter proves and the
questions people ask.

## Guided investigation

```bash
npm run reproduce
```

The same pipeline, driven by questions instead of flags. Describe a bug in prose; it stores the
report, names where your account points, asks about the gaps it could not fill, renders a
proposal, takes your approval, runs it, shows you the recording, exports a standalone Playwright
script, measures as many more runs as you ask for, and reports what separates the failures.

It is a wrapper, not a second code path: every consequential step shells out to the same
`investigate` binary you would type by hand. It cannot auto-approve — the approval is a real
file, SHA-256-bound to the exact proposal bytes, applied by the existing `approve` command. It
adds no `--yes`, `--force` or `--auto`, and there is deliberately no way to run it unattended.

## Try it step by step

```bash
CLI="node apps/cli/dist/bin.js"

# 1. Create a workspace: SQLite database, config.yaml, policies, investigation directories.
$CLI init --workspace ./demo-ws

# 2. Open an investigation from a human's bug report.
$CLI intake --workspace ./demo-ws --from docs/examples/intake/blank-results.md

# 3. Render the gate-1 proposal. Read it: it leads with what would DISPROVE each hypothesis.
$CLI plan --workspace ./demo-ws --investigation INV-001   --from docs/examples/proposals/gate-1.input.json

# 4. Running now is REFUSED, and nothing is enqueued.
$CLI run --workspace ./demo-ws --investigation INV-001 --fixture-app product-failing-intermittent

# 5. Scaffold an approval file. This approves nothing.
$CLI approve experiment_selection --workspace ./demo-ws --investigation INV-001   --scaffold --approver "Your Name"

# 6. Edit the scaffold, then record the decision using the checksum step 3 printed.
$CLI approve experiment_selection --workspace ./demo-ws --investigation INV-001   --from ./demo-ws/.investigator/investigations/INV-001/approvals/gate-1.experiment_selection.approval.yaml   --checksum <the sha256 from step 3>

# 7. Now it runs, and runs only what you approved.
$CLI run --workspace ./demo-ws --investigation INV-001 --fixture-app product-failing-intermittent

# 8. Read what the runs show. Deterministic; add --ai for an interpretation.
$CLI analyze --workspace ./demo-ws --investigation INV-001

# 9. Ask what authorised any of it.
$CLI lineage --workspace ./demo-ws --investigation INV-001 RUN-001
$CLI status --workspace ./demo-ws --investigation INV-001
```

Step 4 is the point of the whole design: it exits 2 with `GATE_REQUIRED` and enqueues **nothing**.

Step 7 reports `PRODUCT_FAILED` by outcome rule 4. That is a **successful investigation step** --
the agent correctly observed a product defect -- not a CLI error, and the exit code is 0.

Edit `/repetitions` in the approval file and step 7 runs the edited count, because execution
consumes the _effective_ proposal. Approve only one of the two experiments and only that one runs.
Both are asserted by tests. Swap the fixture for `automation-failing` to see rule 3 — a broken
instruction — correctly beating rule 4, so a defect in the sequence is never counted as a defect
in the application.

Step 8 prints what the runs measured, with **no provider involved**: which console fingerprints,
request orderings and timings separate the failing runs from the passing ones. When every run
failed it says so and refuses to present anything as discriminating, because with no control
group a value common to all failures may simply be common to all runs.

## The AI path

Three versioned flows live under `ai/flows/`, each a directory of files — `flow.yaml`,
`system.md`, `examples.jsonl` — hashed together into a `flowHash` recorded on every call, so the
exact prompt bytes behind any output are recoverable. Prompts are never string literals in
TypeScript.

| Command        | Flow                  | What it does                                                                |
| -------------- | --------------------- | --------------------------------------------------------------------------- |
| `intake --ai`  | `intake_to_flow`      | Interprets a bug report into steps, unknowns, and a suspected failure point |
| `plan --ai`    | `propose_experiments` | Drafts ranked experiments, each with what would disprove it                 |
| `analyze --ai` | `analyze_failures`    | Reads the measured runs and proposes findings and reproduction steps        |

Configure it with five variables, or put them in a gitignored `.env` (see `.env.example`). The
real environment always wins over the file, so a stale file cannot shadow a deliberate export;
`REPROAGENT_NO_ENV_FILE=1` disables it entirely. `llm.apiKeyEnv` in `config.yaml` names the
variable holding the key, so an existing credential can be pointed at without copying it.

Two properties are worth stating plainly, because they are the whole design:

**The measurement is never the model's.** `analyze` computes its contrast — what differs between
failing and passing runs — as a pure function over evidence the extractor already produced. That
answer prints whether or not a provider is reachable. The model reads the contrast and says what
it means; it does not produce it.

**Nothing invalid is persisted.** Every AI output is parsed, schema-validated with unknown fields
rejected, then reference-validated: a finding citing a run the tools never returned is a
fabrication and the output is refused rather than repaired into plausibility. A claim at
`probable_trigger` or above additionally needs a citation carrying a field and an expected value,
because "see RUN-17" establishes only that RUN-17 exists.

An interpretation must also be able to say _"the reporter never told me this"_. A selector may use
the `described` strategy to carry the reporter's own words, and a `goto` may have a null URL paired
with the `unknownRef` that names the gap. Both are **unexecutable by design**: the executor and the
suite generator each refuse them with `EXEC_VALUE_UNRESOLVED`, classified `AUTOMATION_FAILED`.
Without this, a flow had to invent a selector or a URL to be schema-valid at all.

### What is verified, and what is not

`intake --ai` has been run against live DeepSeek end to end. On a report that named no URL and no
selector, it named the failure point with a supporting quote, emitted `url: null` with an
`unknownRef`, used a `described` selector, and recorded four unknowns — refusing to invent any of
it.

`plan --ai` and `analyze --ai` have **not** been run against a live provider. They share the same
runner, examples and validation, but that is inference rather than evidence, and their token
budgets may need the same raise `intake_to_flow` required once few-shot examples were included.

The replay eval harness (`eval/`) runs from recorded outputs and needs no credential, which is the
only way a gate on model behaviour can honestly block CI.

## What the fixtures demonstrate

| File in `packages/test-fixtures/experiments/` | Outcome                                                             |
| --------------------------------------------- | ------------------------------------------------------------------- |
| `passing.json`                                | `VALID_COMPLETED` (rule 5)                                          |
| `product-failing-deterministic.json`          | `PRODUCT_FAILED` (rule 4) on every repetition                       |
| `product-failing-intermittent.json`           | `PRODUCT_FAILED`, pinned to a failing seed                          |
| `automation-failing.json`                     | `AUTOMATION_FAILED` (rule 3), never misreported as a product defect |

The intermittent fixture is **seeded, not random**. Whether a run fails is a pure function of the
seed, so the same seed produces the same verdict on any machine — which is what makes an
intermittent issue reproducible instead of merely frequent. Failing seeds below 40 are 7, 8, 9,
19, 23, 35 and 39.

## Verify

```bash
npm run build && npm run lint && npm run format:check && npm run typecheck
npm run test:docs      # governing principle, schemas, import boundaries, fixture validity
npm test               # unit
npm run test:e2e       # CLI against the built binary
npm run test:reliability
npm run gate:twice     # the M1 reliability gate, twice sequentially (~13 min)
```

Current counts: **329** unit and docs tests, **40** e2e against the built binary, **48**
reliability. The 100-run gate completes 100/100 `VALID_COMPLETED` with zero retries and zero
infrastructure failures in roughly 130 seconds.

Run the reliability project on an otherwise idle machine. It asserts a wall-clock budget, and
running other suites alongside it will fail that assertion on contention rather than on
correctness.

On Windows, one command runs the same sequence:

```powershell
pwsh -File scripts/verify.ps1 -Gate
```

CI is **GitLab** (`.gitlab-ci.yml`). The GitHub Actions file is a non-authoritative mirror and is
labelled as such in its own header.

## Key guarantees, and where to check them

| Guarantee                                                                        | Enforced by                                                                                                                      |
| -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| DeepSeek is never reachable from execution, evidence, or fixtures                | `tests/docs/import-boundary.spec.ts` walks the resolved module graph                                                             |
| Sensitive evidence is redacted before it is persisted                            | `tests/reliability/redaction_before_persistence.spec.ts`; a store call without a `RedactionStamp` raises `REDACTION_NOT_APPLIED` |
| Normalization is a pure function; a session rebuilds byte-identically offline    | `tests/reliability/offline_session_reconstruction.spec.ts`, with network and browser unavailable                                 |
| A product failure is never hidden by a retry                                     | `tests/reliability/no_retry_hides_product_failure.spec.ts`                                                                       |
| Queue state and run outcome are separate concepts                                | `JobState` / `JobTerminalReason` / `RunOutcome` in `packages/core/src/types.ts`                                                  |
| The 100-run fixture completes with zero retries and zero infrastructure failures | `tests/reliability/same_test_100_runs.spec.ts`                                                                                   |
| Every artifact is content-hashed and verifiable                                  | `tests/reliability/artifact_integrity_hashes.spec.ts`                                                                            |
| Mobile runs are Chromium **emulation**, recorded as read back from the browser   | `tests/reliability/mobile_emulation.spec.ts`                                                                                     |
| The API key never reaches a log, artifact, or error                              | `packages/core/src/secret.spec.ts`, plus a canary assertion in the CLI e2e suite                                                 |
| An AI finding cannot cite evidence it was never shown                            | `apps/cli/src/commands/analyze.ts` validates every reference against only the runs the tools returned                            |
| What differs between failing and passing runs is computed, not inferred          | `contrastRuns` is a pure function; `packages/tools/src/analysis-tools.spec.ts` covers it, including what it refuses to claim     |
| A persisted video is never presented as redacted                                 | stamped `video-raw-unredactable`; `packages/evidence/src/capture-status.spec.ts` asserts the wording a reader actually sees      |
| A value the reporter never gave cannot be silently guessed at run time           | `EXEC_VALUE_UNRESOLVED` in `tests/e2e/described-selector.test.ts`, at both execution and export                                  |
| Each investigation keeps its own provenance chain                                | `packages/lineage/src/lineage.spec.ts`; migration 2 scopes the lineage primary key per investigation                             |
| A flow's few-shot examples satisfy the schema its output is validated against    | `tests/docs/flow-examples.spec.ts`, over every shipped flow                                                                      |

## Scope boundary

Chrome desktop and Chrome mobile-**emulated** web, reproducible at least occasionally, observable
from the browser and client boundary, in authorized test environments.

ReproAgent does not claim to reproduce real-device Android Chrome behaviour, and does not claim
to capture all browser-visible data. What it captures is "the configured, technically accessible,
authorized, and successfully collected client-observable evidence" — and where a category is
missing, partial, redacted, unsupported or corrupted, it says so explicitly rather than implying
completeness.

Not a generic test generator. Not a log viewer. Not a session recorder. Not a replacement for QA,
developers, or observability tooling.

## Documentation

| Path                                | Contents                                                              |
| ----------------------------------- | --------------------------------------------------------------------- |
| `CLAUDE.md`                         | Repo-wide rules: layering, determinism, redaction, secrets, approvals |
| `docs/prompt-a.txt`                 | The frozen originating brief, byte-for-byte, with a SHA-256 checksum  |
| `docs/m0-decisions.md`              | Human decisions, adapter choices, and what supersedes the brief       |
| `docs/FREEZE-M0.md`                 | M0 sign-off and the amendment log                                     |
| `docs/adrs/`                        | 27 architecture decision records                                      |
| `docs/architecture/`                | Component, evidence, queue, approval and evidence-reference models    |
| `docs/milestones/`                  | Authoritative scope per milestone                                     |
| `ai/flows/`                         | Versioned prompt artifacts, hashed into every AI call's `flowHash`    |
| `eval/`                             | Replay datasets and the scorer that gates model behaviour in CI       |
| `docs/operations/runbook.md`        | Operating, troubleshooting and incident procedures                    |
| `docs/operations/windows-runner.md` | Provisioning the Windows GitLab runner                                |
| `schemas/`                          | 28 versioned JSON schemas                                             |

## Security posture

The API key is read from the **environment only**, through a name allowlist, and is wrapped in a
`Secret` that refuses to serialise itself. It is never logged, persisted, written to an artifact,
included in an error message, or echoed by any command. `doctor` reports the variable **name** and
whether it is set, never its value. `llm.apiKeyEnv` in `config.yaml` chooses which variable holds
it, so an existing credential can be named rather than copied.

A gitignored `.env` may supply the non-secret settings. It never overrides a variable already set
in the real environment, so a stale file cannot shadow a deliberate export — the one dotenv
failure mode that would matter here, because the shadowed value would be a credential.

Raw sensitive evidence exists only in bounded process memory during collection and
transformation. It is redacted before durable persistence, provider transmission, normalized
indexing, diagnostic logging, report generation, and any export. The agent disables its own
crash-dump and heap-snapshot paths. OS-level paging is documented as residual risk in
`docs/security/security-model.md`.

Approvals are file-based and SHA-256-bound to the exact proposal bytes. There is no `--yes`,
no `--force-approve`, and no `--auto` flag — a test asserts their absence.

**One artifact is deliberately not redacted: video.** A recording is raw pixels, and no text rule
can mask a credential that was visible on screen. It is written only when `execution.video` is
explicitly set to `on`, and is stamped `video-raw-unredactable` rather than inheriting a stamp
that would imply the bytes had been cleaned. The capture status says so in words a reader will
understand, because that warning is the only thing standing between a convenience and a leak.
