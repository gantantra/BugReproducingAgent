# FREEZE-M0 — Review and Sign-off Template

Status: **awaiting review**
Prepared: 2026-09-10
Purpose: the single document a reviewer reads to accept, amend, or reject the M0 architecture
before any code is written.

## Governing principle

Playwright produces evidence. Deterministic software normalizes and measures evidence. DeepSeek interprets and prioritizes evidence. Humans authorize consequential transitions.

Verbatim presence verified in `CLAUDE.md`, `docs/architecture/overview.md`, and all 19 ADRs whose
`touches` includes `execution`, `evidence`, or `ai`. ADR-0019 (`touches: [build]`) is exempt by
rule. Checked mechanically; see "Verification performed".

---

## Part 1 — Frozen decisions, and where each lives

| # | Frozen decision | Authoritative section |
| --- | --- | --- |
| 1 | Durable queue: SQLite-backed job table | `docs/architecture/queue-model.md`, ADR-0003 |
| 2 | SQLite behavior: WAL, single writer, configured busy timeout, short transactions | `docs/architecture/queue-model.md` ("Claim semantics under SQLite"), ADR-0002 |
| 3 | M1 performance fixture: deterministic local fixture, 100 sequential runs inside the agreed CI budget | `docs/architecture/reliability-strategy.md` ("The performance fixture"), `docs/acceptance-tests/M1-reliability-gate.md` test 1 |
| 4 | Approval mechanism: file-based, SHA-256 checksum-bound | `docs/architecture/approval-state-machine.md`, ADR-0013 |
| 5 | Reference validation (MVP): ownership, type validity, field existence, exact field match; no free-form entailment | `docs/architecture/evidence-reference-model.md` ("Reference validation"), ADR-0012 |
| 6 | Secret handling: `DEEPSEEK_API_KEY` from environment only; never logged, persisted, or written to artifacts | `docs/security/security-model.md` ("Secret handling"), `docs/architecture/deepseek-adapter.md` |

The queue model (JobState / JobTerminalReason / RunOutcome and all six rules) is reproduced
verbatim from the brief in `docs/architecture/queue-model.md` and encoded as SQLite `CHECK`
constraints plus `schemas/run-manifest.v1.json` conditionals. The redaction boundary paragraph is
reproduced verbatim in `CLAUDE.md`, `docs/security/security-model.md`, and ADR-0008.

**Decision 3 requires a number I could not verify.** The budget is written as 10 minutes wall
clock for 100 sequential runs, p95 per-run under 8s, hard per-run ceiling 20s, disk growth under
1.5 GB. There is no CI in place, so this is a proposed budget, not a measured one. See Part 4, Q3.

---

## Part 2 — Deliberate extensions and resolved inconsistencies

Each item is a place where I added to, or had to choose between, what the brief specified. Accept
or reject each.

### E1 — `disabled` added to `CaptureStatus`

The brief lists `complete`, `partial`, `missing`, `redacted`, `unsupported`, `corrupted`. I added
`disabled`.

Reason: "the operator turned video off to save disk" and "this collector cannot capture WebSocket
frames" have different remediations. Collapsing both into `unsupported` loses the actionable
distinction, and the aggregate ordering needs to rank an operator choice differently from a
capability gap.

Where: `docs/architecture/capture-completeness.md`, `schemas/capture-status.v1.json`, ADR-0016.
Open question Q8.

**Decision: accept / reject / amend →** ______

### E2 — `correlated_difference` treated as a display label

The brief's `Finding` example shows `"level": "correlated_difference"`; the vocabulary section
lists `correlated`. Two spellings cannot both be canonical in an enum.

Resolution: `schemas/finding.v1.json` accepts only the seven canonical ladder values.
`correlated_difference` is a display label mapped from `correlated` by a fixed table in the
renderer (`FinalReport.claims[].displayLevel`).

Where: `docs/architecture/evidence-reference-model.md`, `schemas/final-report.v1.json`.
Open question Q9.

**Decision: accept / reject / amend →** ______

### E3 — MVP cannot emit `confirmed_root_cause`

`confirmed_root_cause` requires an `ApprovalRecord` of type `direct_evidence_attestation`,
checksum-bound to the referenced artifact. I deliberately specified **no CLI command that mints
that approval type**, so the level is unreachable and the report states so explicitly.

This is the conservative reading of the non-negotiable principle. The alternative — a fourth
approval path — would need an ADR and arguably a fourth gate.

Where: ADR-0012, `docs/architecture/evidence-reference-model.md`,
`schemas/approval-record.v1.json` (`approvalType`), `schemas/final-report.v1.json`
(`explicitNonClaims` required). Open question Q10.

**Decision: accept / reject / amend →** ______

### E4 — Demotion rather than rejection for over-leveled findings

The brief hard-fails only `confirmed_root_cause`. For every other level, I specified automatic
**demotion** to the highest fully-supported level, with the demotion recorded as a warning on the
finding, rather than rejecting the finding outright.

Reason: silent rejection would hide that the model overreached; silent acceptance would launder it.
A recorded demotion does neither. Over-leveling is scored separately from wrongness in the M4 eval
and gated at zero, so demotions are visible in aggregate.

Where: ADR-0012, `schemas/finding.v1.json` (`validation.demotions`).

**Decision: accept / reject / amend →** ______

### E5 — Findings capped at `correlated` on incomplete evidence

A finding whose cited evidence depends on a category that is `partial`, `redacted`, `unsupported`,
`disabled`, or `corrupted` for **any** cited run cannot exceed `correlated`. Enforced
deterministically in reference validation, not by prompting.

This is my mechanism for pricing in the diagnostic cost of redaction rather than hiding it. It
will cap some genuinely good findings.

Where: ADR-0016, ADR-0008, `docs/architecture/capture-completeness.md`.

**Decision: accept / reject / amend →** ______

### E6 — `field` and `expectedValue` mandatory at `probable_trigger` and above

A purely existential citation ("see EV-122") cannot support a causal-flavoured claim. Findings at
`probable_trigger` or above must carry at least one reference with a JSON Pointer `field` and an
`expectedValue` compared by strict deep equality.

This is the load-bearing anti-fabrication mechanism and it costs the model tokens.

Where: ADR-0012, `schemas/finding.v1.json` (`allOf` conditional).

**Decision: accept / reject / amend →** ______

### E7 — Confidence is never a gate

`confidence` is recorded and displayed but never promotes or blocks a level. Additionally,
`confidence > 0.95` on a finding at `correlated` or below is rejected as internally inconsistent.

Where: ADR-0012, `docs/architecture/evidence-reference-model.md`.

**Decision: accept / reject / amend →** ______

### E8 — Six error codes and five CLI exit codes beyond the brief

The brief names the AI error taxonomy. I extended it to a full typed taxonomy covering config,
approvals, execution, evidence, integrity, and storage, with exit codes 0–10 including
`EVIDENCE_INCOMPLETE` (8), `INTEGRITY_FAILED` (9), and `INCONCLUSIVE` (10).

Where: `docs/architecture/error-taxonomy.md`, `docs/architecture/cli-contract.md`.

**Decision: accept / reject / amend →** ______

### E9 — Typed `FlowResult` with partial-capability declared per flow

`classify_runs` and `analyze_pass_fail` are partial-capable (they iterate over runs and comparison
pairs). `intake_to_flow`, `propose_experiments`, `suggest_minimization`, and `generate_report`
return `inconclusive` instead, because a half-formed flow, ranking, reduction plan, or report is
worse than none.

Where: `docs/architecture/error-taxonomy.md`, `schemas/flow-artifact.v1.json`
(`partialCapable`, `unitField`).

**Decision: accept / reject / amend →** ______

### E10 — Auxiliary CLI commands outside the frozen contract

Added as additive, read-only conveniences: `status`, `show`, `lineage`, `cost`, `doctor`, and
`retention apply` (the only non-read-only one, requiring `--confirm`).

Where: `docs/architecture/cli-contract.md` ("Auxiliary commands").

**Decision: accept / reject / amend →** ______

### E11 — Reproducer and control are part of gate 3, and controls are deterministic

Passing-control construction is deterministic (vary exactly one factor), executed at the same
repetition count, and asserted by test to differ from the reproduction in exactly that factor.

Where: `docs/milestones/M6.md` (M6-AT-6), `schemas/reproducer-package.v1.json`.

**Decision: accept / reject / amend →** ______

### E12 — Two schemas beyond the brief list, and two exemptions from the versioning rule

Added `schemas/minimization-candidate.v1.json`, `schemas/statistic.v1.json`,
`schemas/redaction-policy.v1.json`, `schemas/intake-report.v1.json`, `schemas/common.v1.json`,
`schemas/config.v1.json`, and the two `intake.*` flow schemas.

Two schemas carry a differently-named version field rather than `schemaVersion`:
`flow-artifact.v1.json` uses `version`, `redaction-policy.v1.json` uses `policyVersion`.
`action.v1.json` and `common.v1.json` are embedded/definition schemas and carry no version of
their own; `config.v1.json` validates a user-authored file and does not demand a version field.
`docs/acceptance-tests/M0-doc-checks.md` M0-AT-3 records these exemptions explicitly.

**Decision: accept / reject / amend →** ______

---

## Part 3 — Recommended defaults I chose where the brief was silent

Each of these is reversible and recorded. I will proceed with the recommendation unless told
otherwise.

| # | Choice | Recommendation taken | Where |
| --- | --- | --- | --- |
| D1 | Trace disposition default | `withhold` for M1; `redacted-pipeline` built in M8; `raw-opt-in` fixture-only | ADR-0008, Q11 |
| D2 | Video default | `on-failure`, with the performance fixture explicitly setting `on` so the gate still measures the worst case | `schemas/config.v1.json`, Q12 |
| D3 | Minimization retention hard gate | "the reduced case still reproduces with a lower interval bound above zero"; retention-versus-original reported as a quality metric | `docs/milestones/M6.md`, Q13 |
| D4 | Package manager | `corepack enable pnpm` with the version pinned in `package.json` | ADR-0019, Q1 |
| D5 | SQLite driver | probe `node:sqlite` and `better-sqlite3` at the start of M1, record the choice as ADR-0021 | ADR-0002, Q2 |
| D6 | LLM transport | `fetch`, no provider SDK | ADR-0009, `docs/architecture/build-vs-buy.md` |
| D7 | No prompt/agent framework | hand-written turn loop, roughly 200 lines, the most safety-relevant code in the repo | `docs/architecture/build-vs-buy.md` |
| D8 | Statistics | own Wilson, Fisher exact, bootstrap, unit-tested against published reference values | `docs/architecture/build-vs-buy.md`, `docs/milestones/M5.md` |
| D9 | Default redaction policy includes India-specific PII shapes (phone, PAN, Aadhaar) | inferred from the operating context | `docs/security/redaction-policy.md`, Q15 |
| D10 | Windows workspace permissions | POSIX modes applied where supported; no additional Windows ACL hardening in MVP | `docs/security/security-model.md`, Q14 |
| D11 | Eval blocking gate | replay mode against recorded responses; live mode nightly and on version bump | ADR-0017 |
| D12 | Initial eval thresholds | deliberately achievable rather than aspirational, with four hard rows that are not thresholds at all | `docs/evaluation/eval-gates.md` |

---

## Part 4 — Open questions, by blocking status

Full text in `docs/architecture/open-questions.md`.

### Genuinely blocking a claim I would otherwise make

| # | Question | What it blocks |
| --- | --- | --- |
| Q3 | Which CI, and which runner class? | **M2 entry.** The stated M2 precondition is "M1 Reliability Gate passes in CI". With no CI I can only report the gate as passing locally, which does not satisfy that precondition. It also makes the frozen decision 3 budget unverifiable |
| Q5 | DeepSeek model IDs for the three aliases, base URL, and how `thinking` / `non-thinking` should be expressed | **M3 live verification only.** The gateway, validation, budgets, tools, flows, and replay-mode eval are all buildable and gateable without them, because `RecordedProvider` needs no key. M3 splits into "built and replay-gated" (unblocked) and "live-verified" (blocked) |

### Wanted, not blocking

| # | Question |
| --- | --- |
| Q1 | Confirm `corepack enable pnpm` versus a global install versus npm workspaces |
| Q2 | Confirm the M1 SQLite-driver probe approach |
| Q4 | Is there a real authorized target for the first non-fixture investigation? (URL, classification, auth, written authorization for repeated automated runs) |
| Q6 | Price table per model ID, for cost accounting |
| Q7 | Where the key lives for nightly live evals |
| Q8–Q15 | Confirm E1, E2, E3, D1, D2, D3, D9, D10 above |
| Q16–Q22 | Deferred, informational |

---

## Part 5 — Verification performed on the M0 artifacts

| Check | Method | Result |
| --- | --- | --- |
| Governing principle verbatim in the required files | Character-for-character substring match over `CLAUDE.md`, `docs/architecture/overview.md`, and every ADR with `touches` including execution/evidence/ai | **PASS** — 62 of 63 markdown files contain it; the one exception is ADR-0019 (`touches: [build]`), exempt by rule |
| Every schema parses | `JSON.parse` over all 24 files in `schemas/` | **PASS** — 24 parsed, 0 failed |
| Every schema declares `$id` and `$schema` | Scripted | **PASS** — 24 of 24 |
| Versioned record schemas declare `schemaVersion` | Scripted | **PASS** — 19 of 24; the 5 exemptions are recorded in M0-AT-3 and Part 2 E12 |
| Documentation cross-references resolve | Scripted over backticked repository-prefixed paths | **PASS** — 172 `docs/` and `schemas/` references resolve, 0 unresolved; a further 71 references point at trees not scaffolded until Phase B, which is expected in M0 |
| Every milestone has all nine required sections | Scripted heading match over the nine milestone documents | **PASS** — 9 of 9 |
| Ten reliability tests each have a fixture, a fixture test, and a pass criterion | Inspection of `docs/acceptance-tests/M1-reliability-gate.md` | **PASS** |

### Not verified, and cannot be at M0

| Claim | Why unverified |
| --- | --- |
| The M1 performance budget (600s / p95 8s / 1.5 GB) | No CI and no implementation. Proposed, not measured |
| That schemas validate correctly against real records | Ajv is not installed and no records exist. Structural parse only |
| Every eval threshold in `docs/evaluation/eval-gates.md` | No flows, no model access. Thresholds are initial proposals |
| That the Zod-to-JSON-Schema round-trip agrees | ADR-0020 requires a round-trip test; it is an M1 deliverable |
| That the import-graph boundary holds | No code exists yet |

---

## Part 6 — Sign-off

| Item | Reviewer decision |
| --- | --- |
| Frozen decisions 1–6 as documented | accept / amend → ______ |
| Extensions E1–E12 | accept all / itemised above |
| Recommended defaults D1–D12 | accept all / itemised above |
| Milestone plan M0–M8 with entry, exit, and gate criteria | accept / amend → ______ |
| M1 Reliability Gate: ten tests and five fixture apps | accept / amend → ______ |
| Eval gates and initial thresholds | accept / amend → ______ |
| Security and redaction model, including the five stated residual risks | accept / amend → ______ |
| Answers to Q3 and Q5 | ______ |
| Authorization to begin Phase B | proceed / hold |

## Amendment log

Any change to a frozen decision after sign-off is recorded here with the date, the reason, and the
ADR that carries it. A renegotiated performance budget is recorded here rather than being quietly
relaxed in the test.

| Date | Item | Change | Reason | ADR |
| --- | --- | --- | --- | --- |
| 2026-09-11 | D5 / Q2 SQLite driver | Chose `node:sqlite` | Twelve-point capability probe passed on Node v24.15.0: WAL, busy_timeout, synchronous FULL, foreign keys, CHECK, append-only triggers with RAISE(ABORT), BEGIN IMMEDIATE with SQLITE_BUSY contention, partial index, concurrent WAL reader. Zero native dependencies | ADR-0021 |
| 2026-09-11 | D1 / Q11 trace disposition | Confirmed `withhold` as the M1 default; `raw-opt-in` fixture-only; `redacted-pipeline` deferred to M8 and rejected at config load until then | Highest-risk redaction work with the least M1 payoff. Trace-dependent findings are capped at `correlated` by ADR-0016, which is the intended pricing | ADR-0022 |
| 2026-09-11 | D4 / Q1 package manager, and the frozen tech stack | npm workspaces instead of pnpm + Turborepo | `corepack enable pnpm` fails with EPERM on `C:\Program Files\nodejs` (needs admin); `corepack pnpm --version` did not return in 5 minutes (registry unreachable or slow). npm 11.14.1 works. ADR-0019 had pre-recorded this fallback. Migration back is: add `pnpm-workspace.yaml`, delete `node_modules`, `pnpm install` — no source change | ADR-0023 |
| 2026-09-11 | Redaction boundary, DOM snapshots | DOM text and attributes are now redacted before persistence; `<script>` and `<style>` bodies are dropped as page source | The M1 gate caught a JWT reaching disk inside a DOM snapshot that carried a RedactionStamp claiming redaction had run. That false assurance is precisely what ADR-0008 exists to prevent | ADR-0008 (no change to the ADR; the implementation was wrong) |
| 2026-09-11 | Redaction boundary, URLs at collection time | Network and navigation URLs are redacted by the collector, not only by the normalizer | The raw event log is persisted, so a URL buffered verbatim put `?access_token=...` on disk regardless of later normalization. The policy already marked `url-query-secrets` as a collection-stage rule; the collector was not honouring it | ADR-0008 |
| 2026-09-11 | Per-event redaction stamp | Events embed policy identity only; occurrence counts live once, in CaptureStatus | `appliedRules` carries a running counter, so replaying the plane produced different bytes than the original run and broke the byte-identical rebuild claim | ADR-0007 |
| 2026-09-11 | Event `seq` allocation | `seq` is assigned at push time, not at event construction | The async response-body path allocated a seq, awaited, then pushed, leaving the persisted log out of seq order. Everything downstream correlates by seq | ADR-0007 |
| 2026-09-11 | Rule 2 vs rule 3 boundary | A transport-layer error before the first successful navigation now maps to INFRASTRUCTURE_FAILED, not AUTOMATION_FAILED | ADR-0005 already specified this; the interpreter was funnelling raw Playwright `net::ERR_*` into the automation path. The gate caught it via the infrastructure-failing fixture | ADR-0005 |
| 2026-09-11 | Bounded infrastructure retry | Implemented in the worker: INFRASTRUCTURE_FAILED is retried as a new linked job row, bounded by `maxInfraRetriesPerRepetition`. PRODUCT_FAILED, VALID_COMPLETED, AUTOMATION_FAILED, and INTERRUPTED are never auto-retried | `maxInfraRetriesPerRepetition` existed in config and ADR-0005 declared the eligibility, but no code implemented it. A real M1 feature gap, surfaced by a transient launch failure in the gate | ADR-0005, ADR-0003 |
| 2026-09-11 | Storage capture | localStorage, sessionStorage, and cookies are now actually captured | `storage` was a declared evidence category that no code ever populated, so it was silently always empty | — |
| 2026-09-11 | Q5 DeepSeek configuration | Credential located: operator env holds a DeepSeek platform key in `ANTHROPIC_AUTH_TOKEN`, model `deepseek-v4-flash`, base URL `https://api.deepseek.com/anthropic` | Answers the credential half of Q5. Endpoint shape (Anthropic-compatible vs the OpenAI-compatible API ADR-0009 targets) and the REASONING_MODEL id remain open; neither is guessable | see Q5 |
| 2026-09-11 | Test runner split named in ADR-0019 | Vitest runs the reliability gate too; Playwright test runner reserved for M7 emitted reproducers | The gate tests our executor, not a web page. One runner, one config, and the gate exercises the production path | ADR-0024 |
| 2026-09-11 | Raw log completeness, artifact references | The collector binds each content-addressed artifact id onto the raw event that produced it, and the plane recovers the seq -> artifact association from the log | The seq -> artifactId map existed only in process memory, so a rebuild from persisted artifacts alone silently dropped `artifactIds` from every DOM-snapshot and screenshot event. `offline_session_reconstruction` caught the divergence at byte 13268. Same defect class as the collector notes: derived state that never reached the log | ADR-0007 (no change to the ADR; the implementation was incomplete) |
| 2026-09-11 | `schemas/config.v1.json`, `execution.targets` | `minProperties: 1` removed; an empty `targets` map is valid | `investigate init` exited 0 reporting success while writing a `config.yaml` that failed its own schema, so every command in a fresh workspace died with CONFIG_INVALID. A freshly initialized workspace genuinely has no target, and scaffolding a placeholder would put a fabricated `baseUrl` into a safety-relevant field. The guard belongs at the point of use, where `enqueueExperiment` already rejects an unconfigured target | None (schema defect, caught by the CLI e2e suite) |
| 2026-09-11 | CLI help rendering of the governing principle | `investigate --help` prints the principle one sentence per line | Commander re-wraps a description at the help width, which split "Humans authorize consequential transitions." mid-sentence and left the principle unquotable from the CLI's own help. `GOVERNING_PRINCIPLE` is unchanged and remains the single verbatim source | None (presentation defect) |
