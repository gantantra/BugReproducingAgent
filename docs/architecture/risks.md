# Risks, Failure Modes, and Mitigations

Status: M0 frozen candidate

## Governing principle

Playwright produces evidence. Deterministic software normalizes and measures evidence. DeepSeek interprets and prioritizes evidence. Humans authorize consequential transitions.

Severity: **1** existential to the product claim, **2** major, **3** manageable.

## Product and epistemic risks

| # | Risk | Sev | Failure mode | Mitigation | Residual |
| --- | --- | --- | --- | --- | --- |
| R1 | The model produces a confident causal story from coincidence | 1 | A "root cause" that is a correlated artefact of run ordering or cache warmth | Level ladder with deterministic promotion requirements; `field`/`expectedValue` citations mandatory at `probable_trigger`+; frequency intervals must be non-overlapping; `confirmed_root_cause` unreachable in MVP | A `probable_trigger` can still be wrong. The report says so |
| R2 | Fabricated evidence references | 1 | Cited event or field that does not exist, or a real event with a wrong value | Seven-check reference validation including exact field match; nothing persists unvalidated; negative eval fixtures | Semantic entailment is out of scope: a validly cited fact can still be irrelevant to the sentence built around it |
| R3 | Harness flakiness misread as product intermittency | 1 | An automation or infrastructure failure counted as a product failure | `RunOutcome` rule order puts automation before product; ambiguity goes to `INCONCLUSIVE`; extractor independently recomputes the outcome and disagreement is an integrity failure; `fixture_app_classification` gate | Genuinely ambiguous boundary cases exist and land in `INCONCLUSIVE` |
| R4 | Retry hides a product failure | 1 | Infra retry replaces a failing observation with a passing one | Test repetition and infra retry are separate counters; statistics count the last non-interrupted attempt and report repetitions with no valid observation; `no_retry_hides_product_failure` gate | — |
| R5 | Emulated Chrome mobile presented as real Android Chrome | 2 | A report drives a fix for behaviour that does not occur on real devices | Resolved emulation values recorded and read back from the browser; explicit boundary statement in every report; report linter rejects unqualified device claims | Emulation genuinely diverges from devices. The report scopes the claim rather than eliminating the gap |
| R6 | Minimization removes the actual trigger and the reduced case still fails for a different reason | 2 | A misleading minimal repro | Retained *signature* is checked, not merely retained failure; the approved failure signature predicate must still match; revalidation at a configured repetition count with intervals; gate 3 human review | A signature can be coarse enough to match two mechanisms. Signature granularity is a gate-2 human decision |
| R7 | Intermittency too rare to characterise within budget | 2 | Inconclusive investigations | Frequency statistics with explicit achieved n and intervals; `--stop-on-confidence`; typed `INCONCLUSIVE` rather than a guess; report states the incidence bound reached | A 1-in-10000 defect is out of reach for a local single-worker MVP |
| R8 | Redaction destroys the evidence needed to diagnose | 2 | Redacted the field that mattered | Structure and metadata retained when values are removed; shape descriptors (type, length, hash) substituted for values; `redacted` is a first-class `CaptureStatus` value that caps finding level at `correlated` | A genuinely sensitive payload cannot be analysed locally by design |
| R9 | Evidence completeness quietly degraded | 2 | Reasoning over truncated bodies as if complete | `CaptureStatus` required for every category with no absent keys; tool results carry the completeness slice in-band; findings capped when a cited category is not `complete`; report must include a completeness section | — |
| R10 | Human approval becomes rubber-stamping | 2 | Gates present but not exercising judgement | Proposals rendered as readable markdown with hypothesis, varied factor, and falsifier per experiment; approval requires naming approved item IDs explicitly, not a blanket yes; destructive actions require per-action justification text | Organisational, not technical. Cannot be solved in code |

## Technical risks

| # | Risk | Sev | Failure mode | Mitigation | Residual |
| --- | --- | --- | --- | --- | --- |
| R11 | SQLite write contention | 2 | `STORE_BUSY` under parallel workers | WAL, single writer in MVP, `busy_timeout`, `BEGIN IMMEDIATE` claims, short transactions, artifact bytes written outside transactions | Multi-writer needs the PostgreSQL adapter |
| R12 | Disk exhaustion from video plus trace at scale | 2 | Batch dies mid-way; environment damaged | Per-batch disk growth assertion in the gate; `retention` policy; `video`/`trace` `on-failure` modes; `STORE_DISK_FULL` maps to `INFRASTRUCTURE_FAILED` with a clear message | Operator must provision disk |
| R13 | Normalization non-determinism | 1 | Two runs of the plane produce different output, so comparisons are noise | Plane is a pure function of `(artifacts, policyVersion, normalizerVersion)`; injected `Clock` and seeded `Rng`; `offline_session_reconstruction` asserts byte-identical rebuild | Locale/ICU differences across platforms; pinned and asserted in CI on both OSes |
| R14 | Playwright upgrade changes captured evidence | 2 | Cross-investigation comparisons silently invalidated | `playwrightVersion` and `browserVersion` in every manifest; emulation profiles materialised as concrete values; comparisons across differing versions require an explicit declared factor; upgrades gated by re-running the reliability gate | — |
| R15 | Provider capability drift | 2 | JSON mode or tool calling changes behaviour mid-life | Bounded startup probes with TTL cache keyed by adapter version; `unknown` on probe failure rather than `unsupported`; degradation matrix; every call records observed capability | A silent server-side behaviour change within the TTL |
| R16 | Provider cost overrun | 2 | Surprise spend | Six-dimension per-flow budgets plus a per-investigation ceiling checked with worst-case pre-flight cost; ledger row written before dispatch; `UNPRICED_MODEL` falls back to token ceilings | Price table must be maintained by the operator |
| R17 | Provider outage blocks the investigation | 3 | Cannot interpret | `ai-gateway` is unimportable from `execution`/`evidence`, so capture and revalidation keep working; typed `PROVIDER_UNAVAILABLE`; circuit breaker | Interpretation genuinely blocked |
| R18 | Prompt drift within a version | 2 | Results not reproducible from recorded provenance | `flowHash` over all hashed prompt files, recorded per call and per produced record; load rejected on hash mismatch for a known version | — |
| R19 | Windows/Linux behavioural divergence | 2 | Gate green on one OS, broken on the other | Reliability gate runs on both in CI; path handling via `node:path`; process-kill semantics tested explicitly in the interruption spec | |
| R20 | `node:sqlite` vs `better-sqlite3` instability | 3 | Native build friction or API churn | M1 probes both and records the choice as an ADR; `MetadataStore` localises the swap | |
| R21 | Artifact/manifest tampering | 3 | Evidence integrity unverifiable | SHA-256 per artifact, manifest seal hash, lineage hash chain, `doctor --verify-lineage` | A local user with filesystem access can rewrite consistently; detection, not prevention, is the honest guarantee |
| R22 | Unbounded tool output blows the context | 3 | Truncated inputs, degraded reasoning | `maxEvidenceBytes` per flow, per-tool size ceilings, explicit truncation markers, pre-computed comparisons instead of free-form queries | |

## Safety and privacy risks

| # | Risk | Sev | Failure mode | Mitigation | Residual |
| --- | --- | --- | --- | --- | --- |
| R23 | Unredacted evidence persisted or sent to the provider | 1 | Data leak | Redaction before persistence/transmission/indexing/logging/reporting/export; `RedactionStamp` required by the type signature of every store method; fail closed on a missing stamp; strict-by-default classification of unknown shapes; `redaction_before_persistence` gate | OS paging and kernel mechanisms; documented residual risk |
| R24 | API key leakage | 1 | Credential exposure | Env only; branded `Secret` whose `toString`/`toJSON`/inspect return `[redacted]`; unwrapped only inside header construction; `context` accepts JSON primitives only; explicit tests on interpolation, `JSON.stringify`, logging, and error messages | |
| R25 | Destructive action executed against a shared environment | 1 | Real damage | Environment classification with `production` rejected at load; origin allowlist enforced at navigation; deterministic destructive classifier erring toward destructive; per-sequence human acknowledgement with justification; `staging` blocks destructive by default | A mislabelled `test` target that is actually shared |
| R26 | AI-generated code executed | 1 | Arbitrary execution | Closed action vocabulary; no `eval`; no `page.evaluate` with model-supplied source; reset scripts are human-authored files referenced by path; new action types require a schema change | |
| R27 | Prompt injection from page content | 2 | Page text steers the model into fabricating or into calling tools abusively | Evidence reaches the model only as normalized, redacted, schema-validated tool results with fixed field names, never as free-form page text presented as instructions; tools are read-only and allowlisted; every claim is reference-validated; tool budgets bound the blast radius | A page could still influence a *conclusion* through its content; validation bounds it to cited facts |
| R28 | State drift across many runs corrupts the experiment | 2 | Later runs differ from earlier ones for reasons unrelated to the hypothesis | Fresh context and profile per run; declared reset strategies; `remote-write` refused without one; per-run tenant pools | Server-side drift outside our control |
| R29 | Correlation header or run ID leaks into a shared system | 3 | Test traffic pollutes another team's data | Correlation header off by default and declared per target | |

## Process risks

| # | Risk | Sev | Mitigation |
| --- | --- | --- | --- |
| R30 | Milestone scope creep, especially AI features pulled forward | 2 | `docs/milestones/` is authoritative; import boundaries make early AI use a build failure, not a code-review question |
| R31 | Reliability gate relaxed to unblock a milestone | 1 | Gates are never removed; a wrong gate is fixed via ADR; budget renegotiation is recorded in `docs/FREEZE-M0.md` |
| R32 | Eval baselines gamed | 2 | Baselines versioned in `/eval/reports/baselines.json`; negative fixtures for fabrication and overclaiming; deterministic scorers first; LLM judge never the sole gate |
| R33 | Docs drift from code | 2 | Governing-principle presence check in CI; schema emission validated in CI; `flowHash` enforcement; CLI contract asserted by a snapshot test over `--help` and exit codes |

## Top five to watch

R1, R2, R3, R4, R23. Each is severity 1, each is directly load-bearing for the product claim, and
each has an executable gate attached rather than a policy statement alone.
