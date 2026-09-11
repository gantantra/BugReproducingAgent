# Build vs Buy Decisions

Status: M0 frozen candidate

## Governing principle

Playwright produces evidence. Deterministic software normalizes and measures evidence. DeepSeek interprets and prioritizes evidence. Humans authorize consequential transitions.

## Decision table

| Concern | Decision | Choice | Rationale |
| --- | --- | --- | --- |
| Browser automation | Buy | Playwright + bundled Chromium | Mature CDP handling, tracing, video, network interception, mobile emulation. Building this is a multi-year mistake |
| Browser evidence capture | Buy the primitives, build the correlation | Playwright events + CDP, our own event log | Playwright gives raw signals; the action-window correlation, fingerprinting, and completeness model are the product |
| Trace/video formats | Buy | Playwright trace and video | Standard, viewable in Playwright tooling, so a developer can open our reproducer with tools they already have |
| Test runner for our own tests | Buy | Vitest for unit/integration, Playwright test runner for reliability specs that drive browsers | Vitest is fast and has good TS ergonomics; browser specs belong in the Playwright runner |
| Metadata storage | Buy the engine, build the schema | `node:sqlite` if stable on the target Node, else `better-sqlite3` | Synchronous, embedded, WAL, zero-ops. Decision deferred to M1 with a documented probe; see open questions |
| ORM / query builder | Build (hand-written SQL) | none | The schema is small, append-only, and correctness-critical. An ORM would hide the `CHECK` constraints and transaction boundaries that carry the invariants |
| Migrations | Build (minimal) | numbered SQL files + a `schema_version` table | Ten tables. A migration framework is more moving parts than the problem |
| Durable queue | Build on SQLite | own job table | Frozen decision 1. Avoids Redis in the MVP; the `WorkQueue` interface keeps BullMQ available later |
| Artifact storage | Build on the filesystem | content-addressed layout + SHA-256 | Trivial, auditable, no daemon |
| Schema validation | Buy | Zod as authoring source, JSON Schema emitted | TS-native authoring with inferred types; JSON Schema needed for provider structured output and for language-neutral versioned contracts. See ADR-0020 |
| JSON Schema validation of persisted records | Buy | Ajv (strict mode) | Battle-tested strict validation, `additionalProperties: false`, format assertions |
| YAML parsing | Buy | `yaml` | Config and approval files. Safe schema by default |
| CLI framework | Buy | Commander | Small, stable, no runtime magic. Subcommand grouping for `suite generate` / `frequency run` |
| LLM client | Build (thin) | `fetch` behind `LlmProvider` | We deliberately probe capabilities rather than assume them; an SDK is a second source of assumptions. The surface we use is one endpoint |
| Prompt framework (LangChain-class) | Build | none | Prompt orchestration here is a bounded, auditable turn loop with allowlisted tools and budget enforcement. A general framework would obscure exactly the properties we must guarantee |
| Vector store / embeddings | Neither | out of scope | No retrieval requirement. Evidence access is by ID through typed tools |
| Statistics | Build (small) | Wilson interval, Fisher exact test, bootstrap CI | Three well-specified functions with unit tests against published reference values. A stats library is a large dependency for a small, verifiable need |
| Diffing (DOM) | Build on a bought primitive | own bounded tree diff | Off-the-shelf DOM diffs optimise for patching, not for bounded, comparable, redaction-aware summaries |
| Text diff for reports | Buy | `diff` | Standard, small |
| Hashing | Buy | `node:crypto` | |
| Logging | Build (thin) | own redaction-first logger over a small sink | `logging.redactLogs` cannot be disabled and every field passes the redactor. Wrapping a general logger risks a bypass path via its own formatters and error serialisers |
| Report rendering | Build | deterministic markdown renderer | Output must be mechanically derived from validated findings, and must refuse to render invalid input. A template engine invites arbitrary content |
| Eval harness | Build | own runner/scorer, recorded-response replay | Scoring is domain-specific (reference validity, level ladder, confusion matrices, reduction ratio). Generic LLM eval tools do not encode these |
| LLM judge | Build (secondary only) | own judge flow, deterministic scorers first | Judges are advisory. They never gate alone |
| Monorepo tooling | Buy | pnpm workspaces + Turborepo | As specified |
| Lint/format | Buy | ESLint + Prettier, plus a custom import-boundary rule | The custom rule enforces the layering that protects the governing principle |
| Secret management | Build (thin) over env | `SecretStore` + branded `Secret` | MVP is env-only; the branded wrapper is where the leak-prevention tests attach |
| Packaging/distribution | Defer | pnpm workspace, local run | Single-user local tool for MVP; npm publish or a bundled binary is a later decision |

## Notable "build" choices and their justification

**Thin LLM client rather than an SDK.** The contract requires that we never assume capabilities and
never let provider shapes leak upward. An SDK encodes assumptions about JSON mode, tool calling,
and error semantics that we are contractually obliged to *observe* instead. One `fetch` call plus a
table-driven error classifier is smaller than the adapter we would need anyway to normalise an
SDK's types into ours.

**No prompt/agent framework.** Every property the architecture guarantees — allowlisted tools,
six-dimension budgets, one repair attempt, reference validation before persistence, typed partial
results — would have to be re-implemented on top of a framework's loop, and verified against its
internals. The loop is roughly 200 lines and is the most safety-relevant code in the repository.

**Hand-written SQL.** The invariants that keep job lifecycle separate from run outcome live in
`CHECK` constraints and in `BEGIN IMMEDIATE` transaction boundaries. Those are exactly what an ORM
abstracts away.

**Own statistics.** Three functions, each unit-tested against published reference values, versus a
dependency whose interval conventions we would still have to verify. Frequency claims are
load-bearing for the level ladder, so their implementation must be readable.

## Notable "buy" choices and their risk

| Choice | Risk | Mitigation |
| --- | --- | --- |
| Playwright | Version upgrades change device descriptors, trace format, event timing | Emulation profiles materialised as concrete values in config; `playwrightVersion` recorded per run; upgrades gated by re-running the reliability gate |
| SQLite driver | `node:sqlite` stability across Node versions; `better-sqlite3` native build friction on Windows | M1 probes both, picks one, records the choice as an ADR; the `MetadataStore` interface makes the swap local |
| Ajv strict mode | Strictness can reject valid-but-unusual schema constructs | Schemas are authored in Zod and emitted; the emitter output is validated in CI |
| Turborepo | Cache-correctness surprises | Cache keys include schema and flow hashes; CI runs with cache disabled for the reliability gate |
