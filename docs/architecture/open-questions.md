# Open Questions Requiring Human Decisions

Status: M0 output. Answers wanted before or during the milestone named in each row.

## Governing principle

Playwright produces evidence. Deterministic software normalizes and measures evidence. DeepSeek interprets and prioritizes evidence. Humans authorize consequential transitions.

## Blocking Phase B (needed before scaffolding or early in M1)

### Q1 — pnpm is not installed on this machine

`node -v` reports v24.15.0; `pnpm -v` returns nothing. The stack specifies pnpm + Turborepo.

Options: (a) install pnpm via `corepack enable pnpm` (bundled with Node, no network install of a
global package), (b) install globally with `npm i -g pnpm`, (c) substitute npm workspaces and drop
Turborepo.

Recommendation: (a). Corepack pins the pnpm version in `package.json`, which is reproducible.
Impact if unanswered: I will proceed with (a) and record it, since it is reversible.

### Q2 — SQLite driver

`node:sqlite` (built into Node 22+, still marked experimental in some lines) versus
`better-sqlite3` (native, requires a build toolchain or prebuilds on Windows).

Recommendation: probe both at the start of M1 on this machine, pick the one that supports WAL,
`busy_timeout`, `BEGIN IMMEDIATE`, and user-defined `CHECK` behaviour cleanly, and record the choice
as ADR-0021. Impact if unanswered: I will run the probe and choose, since `MetadataStore` localises
the consequence.

### Q3 — CI provider and runner class

The M1 gate has a wall-clock budget (600s for 100 runs) and must run on Windows and Linux. I need
to know which CI this repository will use (GitHub Actions? an internal Jenkins?) and the runner
class, or the budget is unverifiable.

Recommendation: GitHub Actions `ubuntu-latest` + `windows-latest` as the reference, with the budget
calibrated on first run. **This is a real blocker for calling the M1 gate "passing in CI"**, which
is the precondition for M2. If no CI is available, I can run the gate locally and report it as
"passing locally, CI unverified", but that does not satisfy the stated M2 entry criterion.

### Q4 — Is there a real target application for the first investigation?

The fixture apps let me build and gate everything. But acceptance criterion A-set says "at least
one real authorized test-environment investigation". I need: a target URL, its classification
(`test` or `staging`), whether auth is needed, and written confirmation that automated repeated
runs against it are authorized.

Impact if unanswered: everything through M8 can be built and gated on fixtures. The real-world
validation slips. Nothing blocks.

## Blocking M3

### Q5 — DeepSeek model IDs and inference-mode parameters — PARTIALLY RESOLVED 2026-09-11

Found in the operator User environment on this machine:

| Variable | Value |
| --- | --- |
| `ANTHROPIC_BASE_URL` | `https://api.deepseek.com/anthropic` |
| `ANTHROPIC_MODEL` | `deepseek-v4-flash` |
| `ANTHROPIC_AUTH_TOKEN` | set, 35 characters (the `sk-` + 32 shape of a DeepSeek platform key). Value not recorded here or anywhere else |

Resolved: the credential exists and is a DeepSeek platform key, so the same key authenticates
against DeepSeek's OpenAI-compatible endpoint that ADR-0009 targets.

**Two things this does NOT resolve, and neither may be guessed:**

1. **Endpoint shape.** These variables point at `/anthropic`, the Anthropic-messages-compatible
   endpoint. ADR-0009 and `docs/architecture/deepseek-adapter.md` specify the OpenAI-compatible
   chat-completions API, whose base URL is `https://api.deepseek.com/v1`. Same key, different
   wire format. Using `/anthropic` instead is an adapter redesign and needs an ADR superseding
   ADR-0009; it is not a config change.
2. **Only one model ID is available.** `deepseek-v4-flash` can serve `FAST_MODEL`. There is no
   value for `REASONING_MODEL`, which `propose_experiments` and `analyze_pass_fail` both use.
   Mapping all three aliases onto the one known ID is permitted, but only as a **recorded,
   warned narrowing** — "never silently substitute" forbids doing it quietly, not doing it at all.

Also worth stating: `ANTHROPIC_AUTH_TOKEN` is the credential this coding agent is itself running
on. Pointing the investigator at the same variable means the product spends the same quota. That
is the operator's call, not a technical blocker.

Still needed before M3 live mode: the `REASONING_MODEL` id, and a decision on the endpoint shape.

### Q5 (original) — DeepSeek model IDs and inference-mode parameters

Config requires `DEEPSEEK_FAST_MODEL`, `DEEPSEEK_REASONING_MODEL`, `DEEPSEEK_FALLBACK_MODEL`, and
`DEEPSEEK_BASE_URL`. The contract forbids me from guessing these. I need the exact model IDs you
want each alias to resolve to, and how `thinking` / `non-thinking` should be expressed for them.

Impact if unanswered: M3 cannot run in `live` mode. Replay-mode eval and the whole gateway,
validation, budget, and tool machinery can still be built and gated, because `RecordedProvider`
needs no key. So M3 splits into "built and replay-gated" (unblocked) and "live-verified" (blocked).

### Q6 — Price table for cost accounting

`perInvestigationUsd: 5` is enforceable only with prices per model ID. Unpriced models fall back
to token ceilings with an `UNPRICED_MODEL` warning.

Recommendation: supply prices per 1M input/output tokens per alias. Impact if unanswered: budgets
enforce on tokens only and every AI call carries a warning.

### Q7 — Where does the key live for CI live-mode evals?

Replay-mode CI needs no key. Nightly live evals do. Is a CI secret acceptable, or should live evals
be developer-machine only?

Recommendation: developer-machine only until there is a reason otherwise. Fewer places the key
exists.

## Design decisions I have made provisionally and want confirmed

### Q8 — `disabled` added to `CaptureStatus`

The brief lists `complete`, `partial`, `missing`, `redacted`, `unsupported`, `corrupted`. I added
`disabled` to distinguish "the operator turned video off" from "this collector cannot capture
WebSocket frames", because the remediations differ. Confirm or reject.

### Q9 — `correlated_difference` vs the canonical ladder

The brief's `Finding` example uses `level: "correlated_difference"`; the vocabulary section lists
`correlated`. I made the schema accept only the ladder values and treat `correlated_difference` as
a display label for `correlated`. Confirm or tell me which spelling is canonical.

### Q10 — MVP cannot emit `confirmed_root_cause`

`confirmed_root_cause` requires an `ApprovalRecord` of type `direct_evidence_attestation`, and I
have deliberately **not** specified a CLI command that mints one. So the MVP tops out at
`root_cause_hypothesis` / `confirmed_trigger`. This is the conservative reading of the
non-negotiable principle. Confirm, or tell me to add a fourth approval path (which would need an
ADR and arguably a fourth gate).

### Q11 — Trace redaction disposition

Traces are the richest and riskiest artifact. I specified three dispositions with
`redacted-pipeline` as the default, `withhold`, and `raw-opt-in` restricted to `fixture` targets.
`redacted-pipeline` is real work: it means unpacking, redacting, and repacking Playwright trace
resources, and some content is not field-addressable and will be dropped.

Alternative, cheaper for M1: default to `withhold` (collect for in-process analysis, do not
persist), and build the redacting pipeline in M8. Which do you want? Impact: `withhold` reduces M1
scope and reduces diagnostic power; `redacted-pipeline` is more work and more risk in M1.

Recommendation: default `withhold` for M1, `redacted-pipeline` implemented in M8, `raw-opt-in` for
fixtures throughout so the reliability gate can still exercise trace handling.

### Q12 — Video default

Video at 100 runs is the main disk driver. I specified `on` in the frozen config baseline but
`on-failure` in the redaction discussion. Which is the default? Recommendation: `on-failure`, with
the performance fixture explicitly setting `on` so the gate still measures the worst case.

### Q13 — Minimization retention threshold semantics

In the worked example, no candidate met an 0.80 retention threshold, because reducing a timing-
sensitive repro inherently reduces its rate. Two readings: (a) 0.80 of the *pre-minimization rate*,
(b) an absolute rate floor, (c) "the reduced case still reproduces with a lower interval bound
above 0". Recommendation: (c) as the hard gate, with (a) reported as a quality metric rather than a
blocker. Confirm.

### Q14 — Windows file permissions

POSIX gets `0o700`/`0o600`. Windows relies on inherited ACLs, and I do not harden further in MVP.
Given the primary machine is Windows 11, is that acceptable, or should `investigate init` set an
explicit ACL restricting the workspace to the current user?

### Q15 — `pii-phone-in` and `pii-govt-id-in` rules are India-specific

The default policy includes Indian phone, PAN, and Aadhaar shapes, inferred from the operating
context. Confirm that is wanted, and say whether other locales are needed.

## Deferred, for information only

| # | Question | When it matters |
| --- | --- | --- |
| Q16 | Multi-worker parallel execution and the PostgreSQL adapter | When one worker is too slow for the rare-defect case |
| Q17 | Local web UI for gate review | When markdown proposals become the bottleneck |
| Q18 | Jira integration (create the issue rather than produce markdown) | Post-MVP; needs a write-tool ADR |
| Q19 | Real-device Chrome via a device cloud | When emulation-only findings prove insufficient |
| Q20 | Server-side evidence correlation (APM, logs) | Post-MVP; changes the client-boundary scope |
| Q21 | Streaming provider responses | Only a latency concern |
| Q22 | Distribution as an npm package or bundled binary | When someone other than the author runs it |

## What I will do with no answers

Proceed to Phase B on `proceed`, taking the recommended option for Q1, Q2, Q11, Q12, Q13, and
recording each as an ADR or a `docs/FREEZE-M0.md` note. Q3 and Q5 constrain what I can honestly
claim: without CI I will report the M1 gate as locally verified, and without model IDs M3 will be
replay-gated only. Q4 does not block any milestone.
