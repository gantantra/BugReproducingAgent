# ReproAgent operator runbook

Operating, verifying and troubleshooting ReproAgent. For what the product is, see `README.md`.

## Governing principle

Playwright produces evidence. Deterministic software normalizes and measures evidence. DeepSeek interprets and prioritizes evidence. Humans authorize consequential transitions.

## 1. What a healthy workspace looks like

```bash
node apps/cli/dist/bin.js doctor --workspace ./ws --json
```

| Field | Healthy value | If it differs |
| --- | --- | --- |
| `ok` | `true` | An artifact failed integrity verification. See §5. |
| `schemaVersion` | matches `LATEST_SCHEMA_VERSION` | Run `init` again; migrations are additive and idempotent. |
| `config.journalMode` | `wal` | Non-WAL is rejected at config load; if you see it, the database was modified out of band. |
| `config.aiConfig` | `configured` or `missing` | `missing` is FINE for every deterministic command. |
| `redaction.mode` | `strict` | `permissive` widens what reaches disk. Only ever set deliberately. |
| `safety.unsafeDiagnostics` | `false` | See §6. |

`aiConfig: missing` is not a fault. No M1 command calls a provider, and the AI configuration is
resolved only when an AI-dependent operation runs.

## 2. Running an investigation (M1 scope)

M1 executes a fixture experiment directly. From M2, an experiment reaches the executor only
through an approved, checksum-bound gate-1 proposal and `--fixture-experiment` is removed.

```bash
node apps/cli/dist/bin.js init --workspace ./ws
node apps/cli/dist/bin.js run --workspace ./ws \
  --fixture-experiment packages/test-fixtures/experiments/passing.json \
  --fixture-app passing --repeat 20
```

To run against your own target instead of a fixture app, add the target to `config.yaml` and add
its origin to `safety.allowedOrigins`. Both are required: a run whose resolved origin is not
allowlisted is refused before a browser launches.

```yaml
execution:
  targets:
    staging:
      baseUrl: https://staging.example.internal
      classification: staging # `production` is not an accepted value
      resetStrategy: fresh-context
safety:
  allowedOrigins:
    - https://staging.example.internal
```

### Reading the outcome

Outcomes are decided by six ordered rules. The order matters and is not negotiable:

| Rule | Outcome | Means |
| --- | --- | --- |
| 1 | `INTERRUPTED` | Killed, or the lease expired. No conclusion drawn. |
| 2 | `INFRASTRUCTURE_FAILED` | Harness, host or environment failed. |
| 3 | `AUTOMATION_FAILED` | The approved instructions could not be carried out. |
| 4 | `PRODUCT_FAILED` | The application misbehaved. **This is a successful investigation step.** |
| 5 | `VALID_COMPLETED` | Everything passed. |
| 6 | `INCONCLUSIVE` | Green, but a required evidence category was not usable. |

Rule 3 precedes rule 4 deliberately: a broken selector is a defect in the experiment, and
reporting it as a product bug would waste a developer's time and erode trust in every later
finding.

`PRODUCT_FAILED` exits 0. A non-zero exit means the *tool* failed, never that the product failed.

## 3. Verification

```bash
npm run build && npm run lint && npm run format:check && npm run typecheck
npm run test:docs && npm test && npm run test:e2e
npm run gate:twice        # ~13 minutes
```

Windows, one command:

```powershell
pwsh -File scripts/verify.ps1 -Gate
pwsh -File scripts/verify.ps1 -SkipBrowser   # fast, no Chromium needed
```

The authoritative pipeline is `.gitlab-ci.yml`. A green GitHub Actions run satisfies nothing.

## 4. Troubleshooting

### `CONFIG_ENV_UNRESOLVED` naming a `DEEPSEEK_*` variable

Only an AI-dependent operation resolves AI configuration. If a deterministic command reports
this, that is a bug — deterministic commands must never require these variables. Re-run with
`--json` and file it with the command and the variable name.

### `EXEC_ORIGIN_NOT_ALLOWED`

The resolved navigation origin is not in `safety.allowedOrigins`. Add the exact origin. This is
checked statically before enqueue and again at runtime for every navigation.

### `EXEC_BROWSER_LAUNCH_FAILED`

Chromium did not start. A worker launches one browser per batch and retries the launch up to
three times before failing, so a run reaching this state means all three failed.

Check: `npx playwright install chromium`, available disk, and whether a security agent is
blocking the browser binary. Historical note: launching a browser *per run* failed roughly 4 times
per 100 launches on Windows, which is why the worker now launches once per batch (ADR-0025).

### `REDACTION_NOT_APPLIED`

Something tried to persist evidence without a `RedactionStamp`. This is fail-closed by design.
Never work around it: it is the check that stops unredacted evidence reaching disk.

### `ARTIFACT_HASH_MISMATCH`

An artifact's bytes no longer match the hash recorded at write time. The artifact store is
content-addressed and append-only, so this means out-of-band modification or disk corruption.
Treat the affected run's evidence as untrustworthy; `doctor` reports which runs are affected.

### `STORE_APPEND_ONLY_VIOLATION`

Something attempted to update or delete a manifest, lineage, approval, or AI-ledger row. These
are append-only by database trigger. A retry is a new row, never a mutation of history.

### A reliability spec fails intermittently

Do not re-run it until it passes. Read the diagnosis the spec prints — the perf spec enumerates
every non-`VALID_COMPLETED` attempt with the reason recorded in its manifest. If the cause is an
infrastructure failure on the deterministic fixture, that is a defect in ReproAgent or the
fixture, not weather: the criterion is zero infrastructure failures and zero retries
(`docs/m0-decisions.md`, decision 3).

## 5. Integrity incident

```bash
node apps/cli/dist/bin.js doctor --workspace ./ws --verify-lineage --json
```

1. Record the reported `firstBreak` and the failing artifact ids. Do not delete anything.
2. Manifests are sealed with a hash over their own contents; `verifyManifest` distinguishes "not
   sealed" from "seal hash mismatch". A mismatch means the manifest was altered after sealing.
3. Evidence from an affected run must not be used to support a finding. Re-running produces new
   evidence under a new run id; it does not repair the old.

## 6. Diagnostics that would leak evidence

The agent refuses to run with Playwright protocol logging enabled, because that logging writes
unredacted protocol traffic:

```
DEBUG=pw:api   ->  CONFIG_INVALID, message names "unredacted"
```

`--allow-unsafe-debug` proceeds and marks the session and every manifest it produces as unsafe.
Use it only against a fixture, never against a target with real data. Startup also warns when
`NODE_OPTIONS` contains a diagnostic-report or heap-snapshot flag.

## 7. Secrets

`DEEPSEEK_API_KEY` is read from the environment only, and is never logged, persisted, written to
an artifact, included in an error message, or echoed by any command.

- `doctor` prints the variable **name** and whether it is set. Never the value.
- Never put a credential in `config.yaml`. Use `env:VARIABLE_NAME`, which stores the name.
- Never attach a workspace directory to a bug report without review: it contains evidence. It is
  redacted before persistence, but redaction is policy-bound, not a guarantee about content you
  deliberately fed in.
- CI caches only npm's download cache and the Playwright browser download. Never cache
  `.investigator/`.

## 8. Retention

Artifacts expire per `storage.retention.artifactDays`. Deletion leaves a tombstone: the
artifact's row and hash remain so a past report's reference resolves to "retained until, then
deleted" rather than dangling (ADR-0018). `keepReproducers` exempts reproducer packages.

## 9. Upgrading

1. `npm ci && npm run build`
2. `node apps/cli/dist/bin.js init --workspace ./ws` on each existing workspace — migrations are
   versioned and additive, and `init` never overwrites `config.yaml`.
3. `doctor` and confirm `schemaVersion` advanced and `ok` is `true`.

A Playwright upgrade changes `emulation.browser.playwrightVersion` in every subsequent manifest.
Emulation profiles are materialised with concrete values precisely so that an upgrade cannot
silently change what a profile meant in a past investigation.

## 10. What M1 cannot do

Intake, flow generation, experiment proposal, the three approval gates, DeepSeek analysis, run
classification beyond the deterministic rules, frequency execution, minimization, revalidation,
static test generation, reproducer packaging, Jira-ready reporting, and export are **not
implemented**. Each corresponding command exits 1 and names the milestone that delivers it.
