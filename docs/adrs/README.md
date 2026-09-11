# Architecture Decision Records

## Governing principle

Playwright produces evidence. Deterministic software normalizes and measures evidence. DeepSeek interprets and prioritizes evidence. Humans authorize consequential transitions.

## Conventions

- One decision per file, named `ADR-nnnn-<slug>.md`.
- Front matter is required: `id`, `title`, `status`, `date`, `touches`, `decision`, `consequences`.
- `touches` is a list drawn from `execution`, `evidence`, `ai`, `storage`, `approvals`, `core`,
  `build`. Any ADR whose `touches` includes `execution`, `evidence`, or `ai` must contain the
  governing principle verbatim in a `## Governing principle` section. Checked by M0-AT-1 and
  M0-AT-6.
- Statuses: `proposed`, `accepted`, `superseded by ADR-nnnn`, `rejected`.
- A decision later shown wrong is **superseded by a new ADR**, not edited in place. The record of
  having believed it is part of the audit trail.
- Every deviation from the frozen M0 architecture discovered during implementation is recorded as
  a new ADR rather than as a silent change.

## Index

| ID | Title | Touches |
| --- | --- | --- |
| [ADR-0001](ADR-0001-standalone-local-cli-mvp.md) | Standalone local CLI MVP with no external infrastructure | execution, evidence, storage, ai |
| [ADR-0002](ADR-0002-sqlite-wal-single-writer.md) | SQLite metadata store in WAL mode with a single writer and short transactions | storage, execution |
| [ADR-0003](ADR-0003-sqlite-durable-job-queue.md) | Durable job queue as a SQLite table with leases and explicit reaping | execution, storage |
| [ADR-0004](ADR-0004-local-artifact-store-content-hashed.md) | Local filesystem artifact store, content-hashed and immutable, with a mandatory redaction stamp | evidence, storage |
| [ADR-0005](ADR-0005-job-lifecycle-vs-run-outcome.md) | Job lifecycle, run outcome, and evidence completeness are three independent dimensions | execution, evidence |
| [ADR-0006](ADR-0006-deepseek-out-of-execution-loop.md) | DeepSeek is never in the execution loop, enforced by the import graph | execution, evidence, ai |
| [ADR-0007](ADR-0007-evidence-normalization-plane-pure.md) | The Evidence Normalization Plane is a versioned pure function | evidence, execution |
| [ADR-0008](ADR-0008-redaction-before-persistence-fail-closed.md) | Redaction before persistence, enforced at the type level and failing closed | evidence, ai, storage |
| [ADR-0009](ADR-0009-llm-provider-adapter-probed-capabilities.md) | One LlmProvider adapter with config-driven aliases and probed, never-assumed capabilities | ai |
| [ADR-0010](ADR-0010-ai-flows-as-versioned-artifacts.md) | AI flows are versioned filesystem artifacts, hash-pinned per version | ai |
| [ADR-0011](ADR-0011-read-only-tool-allowlists-and-budgets.md) | Per-flow read-only tool allowlists with six-dimension budgets and typed partial results | ai, evidence |
| [ADR-0012](ADR-0012-evidence-reference-model-and-level-ladder.md) | Evidence reference model, seven-check validation, and a deterministic level ladder | ai, evidence |
| [ADR-0013](ADR-0013-file-based-checksum-bound-approvals.md) | File-based, SHA-256 checksum-bound approvals with no auto-approval path | approvals, execution, ai |
| [ADR-0014](ADR-0014-chrome-mobile-is-chromium-emulation.md) | Chrome mobile means Chromium with explicit mobile emulation, recorded as resolved read-back values | execution, evidence |
| [ADR-0015](ADR-0015-versioned-schemas-strict-validation.md) | Versioned schemas with strict validation and unknown-field rejection for every persisted record | core, ai, evidence |
| [ADR-0016](ADR-0016-capture-completeness-explicit.md) | Capture completeness is recorded per run and per category, including an explicit disabled state | evidence, ai |
| [ADR-0017](ADR-0017-deterministic-first-eval-harness.md) | Deterministic-first eval harness with recorded replay as the blocking gate and an LLM judge only as advisory | ai |
| [ADR-0018](ADR-0018-retention-with-tombstones.md) | Configurable retention with tombstones, preserving lineage and report-referenced artifacts | evidence, storage |
| [ADR-0019](ADR-0019-typescript-monorepo-pnpm-turborepo.md) | TypeScript monorepo with pnpm workspaces, Turborepo, and a build-enforced import boundary | build |
| [ADR-0020](ADR-0020-zod-authoring-json-schema-emission.md) | Zod as the authoring source with JSON Schema emitted and committed | core, ai |

| [ADR-0021](ADR-0021-node-sqlite-driver.md) | Use `node:sqlite` as the SQLite driver | storage, execution |
| [ADR-0022](ADR-0022-trace-disposition-withhold-default.md) | Trace disposition defaults to withhold in M1 | evidence |
| [ADR-0023](ADR-0023-npm-workspaces-instead-of-pnpm.md) | npm workspaces instead of pnpm and Turborepo | build |
| [ADR-0024](ADR-0024-vitest-single-test-runner.md) | Vitest is the single test runner; Playwright runner reserved for emitted reproducers | build, execution |

## Supersession

| ADR | Superseded by | What changed |
| --- | --- | --- |
| ADR-0019 (package-manager portion only) | ADR-0023 | pnpm + Turborepo replaced by npm workspaces. Layering, package split, project references, and import-graph enforcement stand unchanged |
| ADR-0019 (test-runner portion only) | ADR-0024 | Vitest runs the reliability gate too; the Playwright test runner is reserved for emitted reproducer packages |
