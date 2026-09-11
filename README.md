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

| Milestone | State |
| --- | --- |
| M0 — architecture, ADRs, schemas | Accepted with recorded corrections (`docs/FREEZE-M0.md`) |
| M1 — deterministic execution and evidence core | Implemented; gate green locally |
| M2–M8 — intake, AI flows, approvals, frequency, minimization, reporting, export | **Not implemented** |

M1 is the deterministic foundation: it executes an approved experiment in Chromium, captures
evidence, redacts before persistence, normalizes deterministically, and classifies the run. It
does **not** yet accept an issue report, propose experiments, call DeepSeek, enforce the approval
gates, minimize a reproduction, or produce a report. Those are M2 through M8, and the CLI is
honest about it: every unimplemented command is registered and exits 1 naming its milestone.

```bash
node apps/cli/dist/bin.js intake --from issue.md    # -> NOT_IMPLEMENTED, "Arrives in M2"
```

## Install

Requires Node 24+ and roughly 400 MB for the Chromium download.

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

**No DeepSeek credential is needed for anything M1 does.** Every deterministic command — `init`,
`run`, `doctor` — works with no AI environment variables set at all. That is enforced by test and
by CI, not merely intended.

## Try it

```bash
# 1. Create a workspace: SQLite database, config.yaml, policies, investigation directories.
node apps/cli/dist/bin.js init --workspace ./demo-ws

# 2. Run a deterministic fixture that genuinely fails, 8 times.
#    --fixture-app starts a local fixture application and allowlists its origin for this run only.
node apps/cli/dist/bin.js run --workspace ./demo-ws \
  --fixture-experiment packages/test-fixtures/experiments/product-failing-intermittent.json \
  --fixture-app product-failing-intermittent --repeat 8

# 3. Report workspace, queue, integrity and safety state.
node apps/cli/dist/bin.js doctor --workspace ./demo-ws
```

Step 2 reports 8 runs of `PRODUCT_FAILED` by outcome rule 4. That is a **successful
investigation step**: the agent correctly observed a product defect. It is not a CLI error, and
the exit code is 0.

Swap the experiment for `passing.json` to see the `VALID_COMPLETED` path, or
`automation-failing.json` to see rule 3 (a broken instruction) correctly beating rule 4.

## What the fixtures demonstrate

| File in `packages/test-fixtures/experiments/` | Outcome |
| --- | --- |
| `passing.json` | `VALID_COMPLETED` (rule 5) |
| `product-failing-deterministic.json` | `PRODUCT_FAILED` (rule 4) on every repetition |
| `product-failing-intermittent.json` | `PRODUCT_FAILED`, pinned to a failing seed |
| `automation-failing.json` | `AUTOMATION_FAILED` (rule 3), never misreported as a product defect |

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

On Windows, one command runs the same sequence:

```powershell
pwsh -File scripts/verify.ps1 -Gate
```

CI is **GitLab** (`.gitlab-ci.yml`). The GitHub Actions file is a non-authoritative mirror and is
labelled as such in its own header.

## Key guarantees, and where to check them

| Guarantee | Enforced by |
| --- | --- |
| DeepSeek is never reachable from execution, evidence, or fixtures | `tests/docs/import-boundary.spec.ts` walks the resolved module graph |
| Sensitive evidence is redacted before it is persisted | `tests/reliability/redaction_before_persistence.spec.ts`; a store call without a `RedactionStamp` raises `REDACTION_NOT_APPLIED` |
| Normalization is a pure function; a session rebuilds byte-identically offline | `tests/reliability/offline_session_reconstruction.spec.ts`, with network and browser unavailable |
| A product failure is never hidden by a retry | `tests/reliability/no_retry_hides_product_failure.spec.ts` |
| Queue state and run outcome are separate concepts | `JobState` / `JobTerminalReason` / `RunOutcome` in `packages/core/src/types.ts` |
| The 100-run fixture completes with zero retries and zero infrastructure failures | `tests/reliability/same_test_100_runs.spec.ts` |
| Every artifact is content-hashed and verifiable | `tests/reliability/artifact_integrity_hashes.spec.ts` |
| Mobile runs are Chromium **emulation**, recorded as read back from the browser | `tests/reliability/mobile_emulation.spec.ts` |
| The API key never reaches a log, artifact, or error | `packages/core/src/secret.spec.ts`, plus a canary assertion in the CLI e2e suite |

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

| Path | Contents |
| --- | --- |
| `CLAUDE.md` | Repo-wide rules: layering, determinism, redaction, secrets, approvals |
| `docs/prompt-a.txt` | The frozen originating brief, byte-for-byte, with a SHA-256 checksum |
| `docs/m0-decisions.md` | Human decisions, adapter choices, and what supersedes the brief |
| `docs/FREEZE-M0.md` | M0 sign-off and the amendment log |
| `docs/adrs/` | 25 architecture decision records |
| `docs/architecture/` | Component, evidence, queue, approval and evidence-reference models |
| `docs/milestones/` | Authoritative scope per milestone |
| `docs/operations/runbook.md` | Operating, troubleshooting and incident procedures |
| `docs/operations/windows-runner.md` | Provisioning the Windows GitLab runner |
| `schemas/` | 25 versioned JSON schemas |

## Security posture

`DEEPSEEK_API_KEY` is read from the environment only. It is never logged, persisted, written to an
artifact, included in an error message, or echoed by any command. `doctor` reports the variable
**name** and whether it is set, never its value.

Raw sensitive evidence exists only in bounded process memory during collection and
transformation. It is redacted before durable persistence, provider transmission, normalized
indexing, diagnostic logging, report generation, and any export. The agent disables its own
crash-dump and heap-snapshot paths. OS-level paging is documented as residual risk in
`docs/security/security-model.md`.

Approvals are file-based and SHA-256-bound to the exact proposal bytes. There is no `--yes`,
no `--force-approve`, and no `--auto` flag — a test asserts their absence.
