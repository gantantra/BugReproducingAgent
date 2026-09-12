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

## Setup and first run

Everything below was walked from a fresh clone on a clean machine. If a step here does not work,
that is a bug in this document.

### 1. Prerequisites

| Need             | Why                                                                                                           |
| ---------------- | ------------------------------------------------------------------------------------------------------------- |
| **Node 22.5+**   | The storage layer is built on `node:sqlite`, which does not exist before 22.5 (ADR-0021). Verified on Node 24 |
| **~400 MB disk** | The Chromium download                                                                                         |
| Git              | To clone                                                                                                      |
| A DeepSeek key   | **Optional.** Only the three `--ai` steps need one; nothing else does                                         |

No database to install, no native build toolchain, no Docker. SQLite is in-process and the
workspace is a directory.

### 2. Install

```bash
git clone <repo-url> reproagent
cd reproagent
npm ci
npm run build
npx playwright install chromium chromium-headless-shell
```

`npm ci` reports some advisories from transitive dev dependencies; they do not affect the CLI.

### 3. Check it works — 40 seconds, no key needed

```bash
npm run demo
```

This is the fastest proof the install is good. It creates a throwaway workspace, runs the whole
story against a local fixture app, and deletes it afterwards. You should see a **refused** run, an
approval, four real Chromium runs, and `lineage 14 records, chain verified`.

If that works, everything deterministic works.

### 4. The easy path: answer questions

```bash
npm run reproduce
```

Describe a bug in prose and it walks you through the rest: storing the report, showing where your
account points, asking about gaps, rendering a proposal, taking your approval, running it, showing
the recording, exporting a Playwright script, measuring more runs, and reporting what separates
the failures.

Choose **option 1 (a local fixture)** the first time. It touches nothing real and takes two
minutes, and you will then recognise every prompt when you point it at something that matters.

### 5. The manual path, command by command

Same workflow, one command at a time. `$CLI` is just shorthand.

```bash
CLI="node apps/cli/dist/bin.js"
WS=./demo-ws

# 1. Create a workspace: SQLite database, config.yaml, redaction policy, directories.
$CLI init --workspace $WS

# 2. Open an investigation from a bug report.
$CLI intake --workspace $WS --from docs/examples/intake/blank-results.md
#    -> INV-001

# 3. Render the gate-1 proposal, and READ it. It leads with what would DISPROVE each hypothesis.
$CLI plan --workspace $WS --investigation INV-001 \
  --from docs/examples/proposals/gate-1.input.json

# 4. Try to run. This is REFUSED: exit 2, GATE_REQUIRED, and nothing is enqueued.
$CLI run --workspace $WS --investigation INV-001 --fixture-app product-failing-intermittent

# 5. Scaffold an approval file. This approves NOTHING; it prints the exact command for step 6.
$CLI approve experiment_selection --workspace $WS --investigation INV-001 \
  --scaffold --approver "Your Name"

# 6. Edit the scaffold if you want, then record the decision.
#    Easiest: copy the command step 5 printed — it already has the right checksum.
#    Or read the checksum from disk:
CK=$(cut -d' ' -f1 $WS/.investigator/investigations/INV-001/manifests/gate-1.experiment_selection.proposal.json.sha256)
APPROVAL=$WS/.investigator/investigations/INV-001/approvals/gate-1.experiment_selection.approval.yaml
$CLI approve experiment_selection --workspace $WS --investigation INV-001 \
  --from "$APPROVAL" --checksum "$CK"

# 7. Now it runs, and runs only what you approved.
$CLI run --workspace $WS --investigation INV-001 --fixture-app product-failing-intermittent

# 8. Read what the runs show. Deterministic; add --ai for an interpretation.
$CLI analyze --workspace $WS --investigation INV-001

# 9. Ask what authorised any of it, and check integrity.
$CLI lineage --workspace $WS --investigation INV-001 RUN-001
$CLI status  --workspace $WS --investigation INV-001
$CLI doctor  --workspace $WS --verify-lineage
```

Things worth understanding rather than just running:

**Step 4 is the product.** A proposal exists and a fixture app is available, and it still refuses
and enqueues nothing.

**Step 7 reporting `PRODUCT_FAILED` is success.** The agent observed a product defect. Exit code
is 0 and the failure is never retried away.

**Step 8 needs both groups to say anything.** With every run failing there is no control group, so
it says so and refuses to present anything as discriminating. Approving both experiments (as
above) gives a mix and a real contrast.

**Edit the approval to see the point of it.** Change `/repetitions` and step 7 runs the edited
count, because execution consumes the _effective_ proposal. Remove an item from `approvedItemIds`
and only the remaining one runs.

### 6. The one gotcha that will catch you

**Re-running `plan` invalidates any approval you already made**, even if the proposal content is
identical. The rendered proposal embeds `renderedAt`, so every render produces different bytes and
therefore a different checksum.

If you re-render, recover like this:

```bash
rm $WS/.investigator/investigations/INV-001/approvals/gate-1.experiment_selection.approval.yaml
$CLI approve experiment_selection --workspace $WS --investigation INV-001 --scaffold --approver "Your Name"
# then approve again with the NEW checksum
```

Scaffolding refuses to overwrite an existing approval file, which is why the `rm` comes first. The
error message says so when it happens.

### 7. Optional: turn on the AI steps

Only `intake --ai`, `plan --ai` and `analyze --ai` need this. Everything above works without it.

```bash
cp .env.example .env      # .env is gitignored
```

Fill in four values. Get your model ids from the provider rather than guessing — the CLI never
substitutes a model id it was not given:

```bash
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_FAST_MODEL=<id>
DEEPSEEK_REASONING_MODEL=<id>
DEEPSEEK_FALLBACK_MODEL=<id>
```

Use the **OpenAI-compatible** base URL. The provider adapter calls `${baseUrl}/chat/completions`;
an Anthropic-compatible endpoint takes a different request shape and will reject every call.

For the key, either set `DEEPSEEK_API_KEY`, or — if the key already lives in another variable —
name that variable in your workspace's `.investigator/config.yaml` so it is not copied into a
second place:

```yaml
llm:
  apiKeyEnv: MY_EXISTING_VARIABLE
```

Then confirm:

```bash
$CLI doctor --workspace $WS
# Provider  deepseek  host=api.deepseek.com  key(DEEPSEEK_API_KEY)=configured  ai=configured
```

`ai=missing` names exactly which variables are unset. The real environment always wins over
`.env`, and `REPROAGENT_NO_ENV_FILE=1` ignores the file entirely.

### 8. Pointing it at a real site

The fixtures are local and disposable. A real target needs three deliberate decisions, and the
system will refuse until you make them.

In `$WS/.investigator/config.yaml`:

```yaml
execution:
  targets:
    my-target:
      baseUrl: https://staging.example.com
      classification: test # fixture | test | staging. There is deliberately no "production"
      resetStrategy: per-run-tenant
      correlationHeaderAllowed: false

safety:
  allowedOrigins:
    - https://staging.example.com # a navigation outside this list is refused
```

Then run against it with `--target my-target` instead of `--fixture-app`.

Three things that will stop you, by design:

1. **There is no `production` classification.** Declaring a target `test` is you asserting it is
   an environment you are authorised to act on.
2. **Destructive actions are blocked** unless you set `safety.blockDestructiveActions: false` _and_
   write a per-action justification into `safetyAcknowledgements` in the approval file. A click
   whose label matches `delete`, `remove`, `deactivate` and similar is classified destructive
   automatically.
3. **Selectors must be real.** An interpretation will not invent one: it emits a `described`
   selector carrying your words, which refuses to execute. Get real selectors with
   `npx playwright codegen --device="Pixel 7" <your url>` and put them in the proposal.

A first run against a real site commonly returns `AUTOMATION_FAILED` rather than a product
failure. That is the system working: rule 3 fires before rule 4, so a selector that did not match
is never miscounted as a defect in your application.

### 9. If something goes wrong

| Symptom                                        | Cause and fix                                                                                               |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `Build first: npm run build`                   | `npm run build`                                                                                             |
| Chromium fails to launch                       | `npx playwright install chromium chromium-headless-shell`                                                   |
| `GATE_REQUIRED`, exit 2                        | Working as intended. Approve gate 1 first                                                                   |
| `GATE_CHECKSUM_MISMATCH`                       | You re-ran `plan`. See the gotcha above                                                                     |
| `An approval file already exists`              | Delete it to scaffold afresh                                                                                |
| `Runs completed: 0 of N`                       | Those repetitions already ran. Repetitions are keyed by index; raise `--repeat` or approve a new experiment |
| `EXEC_VALUE_UNRESOLVED`                        | A selector or URL was never resolved from prose. Fix it in the proposal and re-approve                      |
| `AI_PROVIDER_UNAVAILABLE`                      | An `--ai` step with no configuration. It names the missing variables                                        |
| `EXEC_ORIGIN_NOT_ALLOWED`                      | The target origin is not in `safety.allowedOrigins`                                                         |
| `No runs with normalized evidence`             | `analyze` before anything ran. Do step 7 first                                                              |
| Reliability suite fails on **wall clock only** | Machine contention. Run it on an otherwise idle machine                                                     |

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
