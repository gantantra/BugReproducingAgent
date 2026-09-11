# Architecture Overview

Status: M0 frozen candidate
Applies to: all milestones

## Governing principle

Playwright produces evidence. Deterministic software normalizes and measures evidence. DeepSeek interprets and prioritizes evidence. Humans authorize consequential transitions.

## Problem statement

Intermittent Chrome web defects are expensive because the reporter cannot reproduce them on demand,
the developer cannot see client-side state at failure time, and QA cannot prove a fix. The
bottleneck is not test execution. It is *evidence*: capturing enough deterministic, comparable,
client-observable evidence across many runs, then reasoning about the differences between failing
and passing runs.

This agent industrialises that loop:

1. Turn an informal report into a structured flow.
2. Propose ranked experiments that could expose the failure.
3. Let a human approve which experiments run.
4. Execute them deterministically, many times, capturing uniform evidence.
5. Measure and normalize the evidence deterministically.
6. Let the model cluster runs, compare pass vs fail, and hypothesise.
7. Let a human approve the target failure signature.
8. Minimize the reproduction, revalidate it, and produce a passing control.
9. Let a human approve the final reproduction.
10. Emit a Jira-ready report where every claim points at validated evidence.

## In scope / out of scope

| In scope | Out of scope (MVP) |
| --- | --- |
| Chrome desktop (Chromium) | Firefox, Safari, WebKit |
| Chrome mobile *emulation* with explicit resolved parameters | Real Android/iOS devices, native apps |
| Issues reproducible at least occasionally | Never-reproducible one-off reports |
| Client-boundary observability: DOM, console, exceptions, network metadata, storage, navigation | Server internals, APM traces, DB state |
| Authorized test environments | Production traffic mutation |
| Local single-user CLI | Multi-tenant service, RBAC, hosted UI |

## Component map

```
                          +--------------------------------+
   report file ---------->|  apps/cli   (investigate ...)  |
                          +---------------+----------------+
                                          |
        +---------------------------------+---------------------------------+
        |                     |                      |                     |
        v                     v                      v                     v
+---------------+   +------------------+   +-------------------+  +------------------+
| packages/core |   | packages/storage |   | packages/approvals|  | packages/lineage |
| ids, errors,  |   | MetadataStore    |   | gate state machine|  | edges + records  |
| clock, rng,   |   | ArtifactStore    |   | checksum binding  |  | replay/query     |
| schema runtime|   | WorkQueue        |   +-------------------+  +------------------+
+-------+-------+   | SecretStore      |
        |           +---------+--------+
        |                     |
        v                     v
+-----------------------------------------------+
| packages/execution                            |
|  - job claim loop (SQLite queue)               |
|  - Playwright worker (bounded concurrency)     |
|  - immutable run manifest writer               |
|  - deterministic action interpreter            |
|  IMPORTS NO AI CODE. EVER.                     |
+---------------------+-------------------------+
                      |  raw artifacts + raw event stream
                      v
+-----------------------------------------------+
| packages/evidence (Evidence Normalization      |
| Plane)                                         |
|  parse -> normalize -> redact -> extract       |
|  -> evidence index + session timeline          |
|  IMPORTS NO AI CODE. EVER.                     |
+---------------------+-------------------------+
                      |  normalized, redacted, schema-valid facts
                      v
+-----------------------------------------------+
| packages/tools    read-only fact projections   |
+---------------------+-------------------------+
                      |
                      v
+-----------------------------------------------+
| packages/ai-gateway                            |
|  LlmProvider adapter (DeepSeek)                |
|  budget enforcement, capability probes,         |
|  schema + reference validation, repair, cost    |
+---------------------+-------------------------+
                      |
                      v
+-----------------------------------------------+
| packages/ai-flows  versioned flow artifacts    |
|  intake_to_flow, propose_experiments,           |
|  classify_runs, analyze_pass_fail,              |
|  suggest_minimization, generate_report          |
+---------------------+-------------------------+
                      |
                      v
+-----------------------------------------------+
| packages/reporting  reproducer + FinalReport    |
+-----------------------------------------------+
```

## Package responsibilities

| Package | Responsibility | Must not |
| --- | --- | --- |
| `core` | IDs, typed errors, `Clock`, seeded `Rng`, schema registry and validator runtime, version negotiation | Perform I/O |
| `storage` | `MetadataStore`, `ArtifactStore`, `WorkQueue`, `SecretStore` interfaces plus SQLite/local/env adapters | Know about browsers or AI |
| `execution` | Claim jobs, drive Playwright, write immutable run manifests, decide `RunOutcome` | Import AI packages |
| `evidence` | Normalization Plane: parse, normalize, redact, extract features, build evidence index | Import AI packages |
| `lineage` | Append-only lineage edges and records across the ten stages | Mutate history |
| `approvals` | Gate state machine, proposal checksums, approval record validation | Auto-approve |
| `ai-gateway` | `LlmProvider`, DeepSeek adapter, budgets, validation, repair, cost ledger | Leak provider shapes |
| `ai-flows` | Load and execute versioned flow artifacts with allowlisted tools | Call Playwright |
| `tools` | Read-only, normalized, redacted, schema-validated fact accessors | Trigger execution |
| `reporting` | Reproducer package, static test emission, `FinalReport` rendering | Invent evidence |
| `test-fixtures` | Five deterministic fixture apps plus fixture flows | Reach the public network |

## Dependency direction

```
core <- storage <- execution <- evidence <- lineage <- ai-gateway <- tools <- ai-flows <- reporting
                                    ^                                            |
                                    +---------------- approvals -----------------+
apps/cli depends on everything. Nothing depends on apps/cli.
```

Enforced by an ESLint import boundary rule plus an import-graph test that fails the build if
`execution`, `evidence`, or `test-fixtures` transitively reach `ai-gateway`, `ai-flows`, or any
provider SDK.

## Data flow, precisely

```
IntakeReport (human file)
  -> [AI: intake_to_flow]         -> Flow (validated)
  -> [AI: propose_experiments]    -> ExperimentProposal[] (ranked, validated)
  -> [GATE 1 experiment_selection]-> ApprovedExperiment[]
  -> [DETERMINISTIC: execution]   -> Job -> RunManifest + raw artifacts
  -> [DETERMINISTIC: evidence]    -> EvidenceEvent[] + CaptureStatus + FailureSignature candidates
  -> [AI: classify_runs]          -> RunClassification[] + clusters
  -> [GATE 2 target_failure]      -> ApprovedFailureSignature
  -> [DETERMINISTIC: frequency]   -> FrequencyStatistics
  -> [AI: analyze_pass_fail]      -> Finding[] (evidence-referenced)
  -> [AI: suggest_minimization]   -> MinimizationCandidate[]
  -> [DETERMINISTIC: revalidate]  -> retained reproduction rate + passing control
  -> [GATE 3 final_reproduction]  -> ApprovedReproduction
  -> [AI: generate_report]        -> FinalReport (references validated)
  -> [DETERMINISTIC: export]      -> ReproducerPackage + Jira-ready markdown
```

Every `[AI: ...]` arrow passes through `ai-gateway` validation. Every `[GATE n]` arrow requires a
checksum-bound approval file. No `[DETERMINISTIC: ...]` step may consult the model.

## Runtime requirements

Node.js >= 20 (developed on 24.x), Chrome or bundled Chromium, a DeepSeek API key, local disk.

No PostgreSQL, Redis, S3, MinIO, Kubernetes, or separate API service. See ADR-0001.

## Local workspace layout

```
.investigator/
  investigator.db
  config.yaml
  prompts/
  investigations/
    INV-001/
      manifests/
      normalized/
      artifacts/
      reports/
      reproducer/
```

## Deferred-but-designed seams

| Seam | MVP adapter | Designed, not implemented |
| --- | --- | --- |
| `MetadataStore` | SQLite (WAL, single writer) | PostgreSQL |
| `ArtifactStore` | local filesystem + SHA-256 | S3 / MinIO |
| `WorkQueue` | SQLite job table | BullMQ + Redis |
| `SecretStore` | environment variables | central secret manager |
| worker pool | one local Playwright worker | distributed browser workers |

Interfaces are authored in M1 with both adapters in mind. SQLite-only semantics (for example
`last_insert_rowid()`, implicit rowid ordering, or filesystem path assumptions) must not leak into
the interface signatures.

## Failure philosophy

Three independent dimensions, never conflated:

1. **Job lifecycle** — did the worker run to completion? (`JobState`, `JobTerminalReason`)
2. **Run outcome** — what did the run observe? (`RunOutcome`)
3. **Evidence completeness** — how much of the intended evidence exists? (`CaptureStatus`)

A worker that successfully captured a product failure is a *successful worker execution*. Retry
logic operates on dimensions 1 and 3 only. It may never mask dimension 2.

## Related documents

- `docs/architecture/components.md`
- `docs/architecture/cli-contract.md`
- `docs/architecture/config-schema.md`
- `docs/architecture/llm-provider-contract.md`
- `docs/architecture/deepseek-adapter.md`
- `docs/architecture/ai-flow-artifacts.md`
- `docs/architecture/tool-allowlists.md`
- `docs/architecture/evidence-normalization-plane.md`
- `docs/architecture/evidence-reference-model.md`
- `docs/architecture/capture-completeness.md`
- `docs/architecture/approval-state-machine.md`
- `docs/architecture/lineage-model.md`
- `docs/architecture/chrome-mobile-emulation.md`
- `docs/architecture/test-data-and-side-effects.md`
- `docs/architecture/reliability-strategy.md`
- `docs/architecture/build-vs-buy.md`
- `docs/architecture/risks.md`
- `docs/architecture/end-to-end-example.md`
- `docs/architecture/open-questions.md`
- `docs/architecture/acceptance-criteria.md`
- `docs/security/security-model.md`
- `docs/security/redaction-policy.md`
- `docs/evaluation/eval-harness.md`
- `docs/evaluation/eval-gates.md`
- `docs/milestones/`
- `docs/adrs/`
