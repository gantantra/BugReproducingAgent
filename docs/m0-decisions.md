---
document: m0-decisions
status: ACCEPTED WITH RECORDED CORRECTIONS
product_name: ReproAgent
authorized_scope: M0 through M8
decided: 2026-09-11
prompt_a_sha256: eabe7754a4c6d0dcc80f8efda4dc71114ffb48088e37734fe9fd8dec5d5a0d4a
---

# M0 decisions and implementation authorization

## Governing principle

Playwright produces evidence. Deterministic software normalizes and measures evidence. DeepSeek
interprets and prioritizes evidence. Humans authorize consequential transitions.

## Sign-off

**Decision: ACCEPTED WITH RECORDED CORRECTIONS.**

M0 is approved subject to incorporating the corrections the completion audit discovered. The audit
is accepted as the authoritative description of the repository state at the time it was produced,
subject to re-verification after each repair.

## Frozen adapter and mode decisions

| Item | Decision |
| --- | --- |
| Product name | ReproAgent |
| Internal package namespace | `@investigator/*` (unchanged) |
| Standalone mode | local CLI |
| Metadata adapter | SQLite WAL |
| Artifact adapter | local filesystem |
| Queue adapter | SQLite-backed job table |
| Secret adapter | environment variables |
| AI provider | DeepSeek behind `LlmProvider` |
| Approval mode | file plus SHA-256 |
| Authorized implementation scope | M0 through M8 |

### Naming rule

No mass rename of package identifiers. "ReproAgent" is the product name and appears in user-facing
CLI descriptions, README files, reports and product documentation. `@investigator/*` remains the
internal package namespace unless a specific technical reason requires otherwise. The two coexist
deliberately: renaming ~200 files to change a string would create a large diff with no behavioural
value and would break the one commit of history that exists.

## Statements in Prompt A that later decisions supersede

`docs/prompt-a.txt` is frozen verbatim and therefore still contains the original three-phase
execution plan. These supersessions are recorded here rather than by editing the frozen text.

| Superseded statement (Prompt A) | Superseding decision |
| --- | --- |
| "Phase C — Milestone by milestone with HALTs", and the instruction to halt after M1 | Implementation of M0 through M8 is authorized without approval between engineering milestones |
| "Do not begin the next milestone without explicit `proceed`" | Applies no longer to engineering milestones; milestone **quality gates** remain mandatory and a failed gate still stops progress |
| Product referred to by description only | Product name is **ReproAgent** |

Unchanged and still binding from Prompt A: the governing principle, the nine non-negotiable
principles, the layering rules, determinism requirements, the redaction boundary, the secret
handling rules, and the three in-product human approval gates.

### What remains mandatory

Authorizing all milestones does **not** remove any human approval inside the product workflow. The
three gates — `experiment_selection`, `target_failure`, `final_reproduction` — remain mandatory,
file-based and SHA-256-bound to the exact proposal bytes. There is no `--yes` flag and no silent
auto-approval. Engineering authorization and product authorization are different things: the first
was granted, the second is granted per investigation by a human, at runtime.

## Audit-driven corrections adopted

| # | Correction | Authority |
| --- | --- | --- |
| C1 | Create the Prompt A freeze package (`FREEZE-M0-PROMPT-A.md`, `prompt-a.txt`, `prompt-a.sha256`, this file) | Decision 2 |
| C2 | The 100-run reliability fixture keeps its zero-retry criterion; it is **not** relaxed. Missing assertions are restored and the observed infrastructure failures are treated as a defect until proven otherwise | Decision 3 |
| C3 | Tests whose true invariant is one manifest per attempt assert bijection and lineage, never a total count that assumes no retry occurred. This must not be used to weaken C2 | Decision 4 |
| C4 | GitLab CI is the authoritative CI provider. The GitHub Actions workflow is marked non-authoritative. Windows verification remains required | Decision 5 |
| C5 | AI configuration resolves lazily. Deterministic commands never require DeepSeek variables | Decision 6 |
| C6 | Ship the fixture experiment files the documented M1 demo requires | Decision 7 |
| C7 | Add the missing tests: `DROPPED_BACKPRESSURE`, `RUN_INTERRUPTED`, mobile emulation and its materialized manifest values, lazy AI configuration, the fixture experiment, CLI packaging | Decision 8 |
| C8 | `npm run format:check` passes and formatting is enforced in CI, without altering the frozen Prompt A bytes | Decision 9 |

## Decision 3 in full, as the binding criterion

For the deterministic local 100-run reliability fixture:

- 100 valid executions
- 100 `VALID_COMPLETED`
- 0 `PRODUCT_FAILED`
- 0 `AUTOMATION_FAILED`
- 0 `INFRASTRUCTURE_FAILED`
- 0 `INTERRUPTED`
- 0 `INCONCLUSIVE`
- 0 retry attempts

The criterion may not be met by increasing retries, reclassifying an outcome, removing an
assertion, ignoring failed attempts, counting only successful retries, raising timeouts without
evidence, reducing the run count, or lowering repetitions through an environment variable.

The full fixture must pass twice sequentially with zero retries.
