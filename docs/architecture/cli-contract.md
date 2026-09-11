# CLI Contract

Status: M0 frozen candidate
Binary name: `investigate`

## Governing principle

Playwright produces evidence. Deterministic software normalizes and measures evidence. DeepSeek interprets and prioritizes evidence. Humans authorize consequential transitions.

## Global options

| Option | Default | Meaning |
| --- | --- | --- |
| `--workspace <dir>` | nearest `.investigator/` upward from cwd | Workspace root |
| `--investigation <id>` | the active investigation recorded in the workspace | Target investigation |
| `--json` | off | Emit machine-readable JSON to stdout; human text goes to stderr |
| `--verbose` | off | Increase log detail. Never increases secret or raw-evidence exposure |
| `--dry-run` | off | Plan only; no writes, no browser, no provider calls |
| `--seed <int>` | from config | Override the deterministic seed |
| `--no-color` | auto | Disable ANSI |

There is no `--yes`, `--force-approve`, or `--auto` flag. Approvals cannot be granted from the
command line. See ADR-0013.

## Exit codes

| Code | Name | Meaning |
| --- | --- | --- |
| 0 | OK | Command completed as intended |
| 1 | USAGE | Bad arguments, missing file, unparseable config |
| 2 | GATE_REQUIRED | The requested transition needs an approval that does not exist |
| 3 | GATE_CHECKSUM_MISMATCH | Approval file does not match the proposal it claims to approve |
| 4 | AI_INVALID_OUTPUT | Model output failed schema or reference validation after repair |
| 5 | BUDGET_EXCEEDED | Flow or investigation budget exhausted; typed partial returned |
| 6 | PROVIDER_UNAVAILABLE | Provider auth/network/circuit-breaker failure |
| 7 | EXECUTION_FAILED | Automation or infrastructure failure prevented valid runs |
| 8 | EVIDENCE_INCOMPLETE | Required evidence category missing for the requested operation |
| 9 | INTEGRITY_FAILED | Artifact hash mismatch or manifest tamper detected |
| 10 | INCONCLUSIVE | Command completed but produced a typed inconclusive result |

Note: exit code 0 with `RunOutcome=PRODUCT_FAILED` is normal and expected. A captured product
failure is a successful investigation step, not a CLI error.

## Commands

### `investigate init`

Creates `.investigator/` with `investigator.db` (migrated), a default `config.yaml`, a
`prompts/` directory, and an empty `investigations/`. Idempotent: re-running on an existing
workspace validates and reports, and never overwrites `config.yaml`.

```
investigate init [--workspace <dir>] [--force-migrate]
```

Writes: workspace skeleton, schema migrations.
Reads: nothing.

### `investigate intake --from <file>`

Registers a new investigation from a human-authored report file (markdown or YAML, see
`schemas/intake-report.v1.json`). In M2 this stores the raw report and assigns `INV-nnn`. From M3
it additionally runs the `intake_to_flow` AI flow to produce a validated `Flow`.

```
investigate intake --from <file> [--title <text>] [--env <name>]
```

Output (`--json`): `{ investigationId, flowId, flowVersion, warnings, aiCallIds }`.

Failure modes: `USAGE` (unreadable/invalid report), `AI_INVALID_OUTPUT`, `BUDGET_EXCEEDED`,
`PROVIDER_UNAVAILABLE`.

### `investigate plan`

Runs `propose_experiments` against the current `Flow` and application constraints, producing a
ranked `ExperimentProposal[]` and a **gate proposal file** for gate 1.

```
investigate plan [--max-proposals <n>] [--refresh]
```

Writes: `investigations/INV-nnn/manifests/gate-1.experiment_selection.proposal.json` plus a
sibling `.sha256` file and a human-readable `.md` rendering.

Output: the proposal path, its SHA-256, and the exact `investigate approve` command to run next.

### `investigate approve <gate> --from <file> --checksum <sha256>`

Records a human approval. `<gate>` is one of `experiment_selection`, `target_failure`,
`final_reproduction`.

```
investigate approve experiment_selection \
  --from approvals/gate-1.approval.yaml \
  --checksum 3f2a...  
```

Validation sequence (all must pass):

1. The approval file parses and validates against `schemas/approval-record.v1.json`.
2. `--checksum` equals the SHA-256 of the referenced proposal artifact bytes on disk.
3. The approval file declares the same checksum. A mismatch between the flag and the file is
   `GATE_CHECKSUM_MISMATCH`.
4. The proposal artifact hash still matches its stored `ArtifactRef`.
5. The gate is currently `AWAITING_APPROVAL` for this investigation.
6. Every referenced item ID (experiment, run cluster, candidate) exists and belongs to this
   investigation.
7. Edits carried in the approval file are themselves schema-valid and within the allowed edit
   surface for that gate.

On success, appends an immutable `ApprovalRecord` and a lineage edge, and transitions the gate.

### `investigate run`

Enqueues and executes jobs for approved experiments. This is the deterministic execution path. It
makes no provider calls.

```
investigate run [--experiment <id>...] [--repeat <n>] [--workers <n>] [--max-parallel <n>]
                [--stop-after-failures <n>] [--budget-wallclock-ms <n>]
```

Requires gate 1. Writes run manifests, raw artifacts, and (via the collector) redacted persisted
evidence.

### `investigate classify`

Runs the deterministic feature extraction to completion, then `classify_runs`, producing
`RunClassification[]`, failure signatures, and clusters. Emits the gate 2 proposal file.

```
investigate classify [--runs <id>...] [--refresh]
```

### `investigate suite generate`

Emits a deterministic Playwright suite for the approved experiments so that the same sequences can
be executed repeatedly outside the agent loop. No AI. Requires gate 1.

```
investigate suite generate [--out <dir>] [--experiment <id>...]
```

### `investigate frequency run`

Executes the approved target failure sequence N times and computes frequency statistics with
confidence intervals. Requires gate 2. No AI.

```
investigate frequency run --repeat <n> [--experiment <id>] [--stop-on-confidence <p>]
```

### `investigate minimize`

Runs `suggest_minimization`, executes candidate reductions deterministically, and measures the
retained reproduction rate. Requires gate 2. Emits the gate 3 proposal file when a candidate meets
the retention threshold.

```
investigate minimize [--max-rounds <n>] [--repeat-per-candidate <n>] [--retention-threshold <p>]
```

### `investigate revalidate`

Re-executes the current reproduction candidate and its passing control, then re-verifies artifact
integrity and evidence completeness. No AI.

```
investigate revalidate [--repeat <n>] [--include-control]
```

### `investigate report`

Runs `generate_report` and renders the `FinalReport`. Requires gate 3. Refuses to render if any
finding fails reference validation.

```
investigate report [--out <file>] [--format markdown|json]
```

### `investigate export`

Packages the reproducer directory, the report, the manifests, and the referenced artifacts into a
portable bundle, applying export-time redaction verification.

```
investigate export [--out <file.zip>] [--include-artifacts <kinds>] [--verify-only]
```

`--verify-only` re-runs the export-time redaction and integrity checks and reports without writing.

## Auxiliary commands (not in the frozen contract, additive only)

`investigate status`, `investigate show <entity>`, `investigate lineage <id>`,
`investigate cost`, `investigate retention apply`, `investigate doctor`.

These are additive conveniences. They may be added in any milestone provided they are read-only
except `retention apply`, which requires explicit confirmation.

## Command-to-gate matrix

| Command | Requires | Produces gate proposal |
| --- | --- | --- |
| `init` | — | — |
| `intake` | — | — |
| `plan` | flow exists | gate 1 |
| `approve` | matching proposal | — |
| `run` | gate 1 | — |
| `classify` | runs exist | gate 2 |
| `suite generate` | gate 1 | — |
| `frequency run` | gate 2 | — |
| `minimize` | gate 2 | gate 3 |
| `revalidate` | gate 2 | — |
| `report` | gate 3 | — |
| `export` | gate 3 | — |
