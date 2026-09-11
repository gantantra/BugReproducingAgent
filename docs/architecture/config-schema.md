# Configuration Schema

Status: M0 frozen candidate
File: `.investigator/config.yaml`
Schema: `schemas/config.v1.json`

## Governing principle

Playwright produces evidence. Deterministic software normalizes and measures evidence. DeepSeek interprets and prioritizes evidence. Humans authorize consequential transitions.

## Frozen baseline

```yaml
llm:
  provider: deepseek
  baseUrl: env:DEEPSEEK_BASE_URL
  apiKeyEnv: DEEPSEEK_API_KEY
  aliases:
    FAST_MODEL:
      modelId: env:DEEPSEEK_FAST_MODEL
      inferenceMode: non-thinking
    REASONING_MODEL:
      modelId: env:DEEPSEEK_REASONING_MODEL
      inferenceMode: thinking
    FALLBACK_MODEL:
      modelId: env:DEEPSEEK_FALLBACK_MODEL
      inferenceMode: non-thinking
  capabilitiesCacheTtlSeconds: 3600
  budgets:
    perInvestigationUsd: 5
    perCallTokens: 32000
storage:
  metadata: sqlite
  artifacts: local
  queue: local
  redactionPolicy: policies/default.yaml
execution:
  browser: chromium
  workers: 1
  maxParallelRuns: 1
approvals:
  required: [experiment_selection, target_failure, final_reproduction]
```

## The `env:` indirection

Any string value may use the form `env:NAME`. The loader resolves it from `process.env.NAME`.

Rules:

- Resolution is strict. An unresolvable `env:` reference is a `USAGE` error at load time with the
  variable name in the message. The variable *name* is safe to print; the value never is.
- `llm.apiKeyEnv` is a variable **name**, not an `env:` reference, and is never resolved into the
  config object. The gateway resolves it through `SecretStore` at call time.
- Resolved config is redacted before any diagnostic dump: `investigate doctor` prints
  `baseUrl` host only and prints alias model IDs, never key material.

## Field reference

### `llm`

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `provider` | `"deepseek"` | yes | Enum today; adding a provider requires an ADR |
| `baseUrl` | string or `env:` | yes | Must be `https:` unless `allowInsecureBaseUrl: true` |
| `apiKeyEnv` | string | yes | Environment variable name only |
| `aliases` | map of the three aliases | yes | All three keys required; see below |
| `capabilitiesCacheTtlSeconds` | integer >= 0 | no, default 3600 | `0` disables caching and re-probes each process start |
| `budgets.perInvestigationUsd` | number > 0 | yes | Hard ceiling across all flows in one investigation |
| `budgets.perCallTokens` | integer > 0 | yes | Upper bound on `maxTokens` any flow may request |

`aliases.<ALIAS>`:

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `modelId` | string or `env:` | yes | Never defaulted, never guessed |
| `inferenceMode` | `thinking` \| `non-thinking` \| `unspecified` | yes | Passed to the adapter; the adapter maps it to provider parameters and records what it actually sent |
| `maxOutputTokensOverride` | integer | no | Clamped by observed capability |
| `temperatureDefault` | number 0..2 | no | Flow-level value wins |

All three aliases must be present and resolvable. A flow that references an alias whose `modelId`
cannot resolve fails with `USAGE` at load time, not mid-flow.

### `storage`

| Field | Type | Allowed (MVP) | Notes |
| --- | --- | --- | --- |
| `metadata` | enum | `sqlite` | `postgres` is designed, rejected at load in MVP with a clear message |
| `artifacts` | enum | `local` | `s3` designed only |
| `queue` | enum | `local` | `redis` designed only |
| `redactionPolicy` | path | any | Resolved relative to the workspace root |
| `sqlite.busyTimeoutMs` | integer | default 5000 | Applied on every connection |
| `sqlite.journalMode` | enum | `wal` only | Non-WAL is rejected |
| `retention.artifactDays` | integer | default 30 | See retention policy |
| `retention.keepReproducers` | boolean | default true | Reproducers survive artifact expiry |

### `execution`

| Field | Type | Default | Notes |
| --- | --- | --- | --- |
| `browser` | `chromium` | `chromium` | MVP is Chromium only |
| `channel` | string | unset | e.g. `chrome`; recorded in the run manifest |
| `workers` | integer >= 1 | 1 | MVP asserts 1 |
| `maxParallelRuns` | integer >= 1 | 1 | Must be <= `workers * perWorkerConcurrency` |
| `perWorkerConcurrency` | integer >= 1 | 1 | Bounded concurrency inside one worker |
| `defaultTimeoutMs` | integer | 30000 | Per-action timeout |
| `runWallClockBudgetMs` | integer | 180000 | Hard per-run ceiling |
| `leaseMs` | integer | 60000 | Job lease; stale leases are reaped |
| `heartbeatMs` | integer | 10000 | Must be < `leaseMs / 3` |
| `seed` | integer | 1 | Deterministic base seed; per-run seed is derived and recorded |
| `video` | `off` \| `on` \| `on-failure` | `on` | |
| `trace` | `off` \| `on` \| `on-failure` \| `retain-on-failure` | `on` | |
| `capture.responseBodyMaxBytes` | integer | 262144 | Bodies over the limit are recorded as `partial` with the reason |
| `capture.domSnapshotOn` | list | `[action, navigation, failure]` | |
| `capture.webSocketFrames` | boolean | false | MVP records `unsupported` when false |
| `targets` | map | required for non-fixture runs | Named environment targets; see below |
| `emulation.profiles` | map | built-ins | Named mobile emulation profiles; resolved values recorded per run |

`targets.<name>`:

| Field | Type | Notes |
| --- | --- | --- |
| `baseUrl` | string | Must match an entry in `safety.allowedOrigins` |
| `classification` | `fixture` \| `test` \| `staging` | `production` is rejected at load; see safety |
| `auth.strategy` | `none` \| `storageState` \| `scriptedLogin` | Credentials come from env, never config |

### `approvals`

| Field | Type | Notes |
| --- | --- | --- |
| `required` | list of gate names | All three required in MVP. Removing one requires an ADR and is rejected by the loader today |
| `approvalDir` | path | default `approvals/` under the investigation |
| `expiryHours` | integer | default 168; an approval older than this is stale for new transitions but remains in lineage |

### `safety`

| Field | Type | Default | Notes |
| --- | --- | --- | --- |
| `allowedOrigins` | list of origins | `[]` | Navigation outside the list aborts the run with `AUTOMATION_FAILED` and a typed reason |
| `blockDestructiveActions` | boolean | true | Actions flagged destructive require a per-sequence approved safety flag |
| `maxRunsPerInvestigation` | integer | 500 | Hard stop |
| `maxWallClockMsPerInvestigation` | integer | 7200000 | Hard stop |
| `productionGuard` | boolean | true | Rejects any target classified `production` and any origin matching `productionOriginPatterns` |

### `logging`

| Field | Type | Default | Notes |
| --- | --- | --- | --- |
| `level` | enum | `info` | `debug` still never logs secrets or unredacted evidence |
| `redactLogs` | boolean | true | Cannot be set false; the loader rejects `false` |
| `disableCrashDumps` | boolean | true | Cannot be set false |

## Precedence

1. Explicit CLI flag
2. Environment variable resolved through `env:`
3. `config.yaml`
4. Built-in default

Precedence is evaluated per leaf field, and the effective value plus its source is recorded in
every run manifest and every AI call record so that any result can be explained later.

## Validation

- Strict JSON Schema, `additionalProperties: false` at every level.
- Unknown keys are a `USAGE` error, not a warning. A typo in a safety field must not silently
  disable the safety field.
- Cross-field assertions: `heartbeatMs < leaseMs / 3`; `maxParallelRuns <= workers *
  perWorkerConcurrency`; every `targets.*.baseUrl` origin appears in `safety.allowedOrigins`;
  `logging.redactLogs === true`; `storage.sqlite.journalMode === "wal"`.
