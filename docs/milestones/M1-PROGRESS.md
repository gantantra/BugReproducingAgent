# M1 — Progress and Resume Point

Paused: 2026-09-11. Status: **M1 substantially implemented, reliability gate 8 of 10 green.**
M1 is NOT complete and M2 must not begin.

## Resume in one command

```bash
cd "C:\Users\gantantra.agrawal\OneDrive - Info Edge (India) Ltd\Documents\Projects\Bug Investigating agent"
npm run build && RELIABILITY_RUNS=12 npx vitest run --project reliability
```

Environment is fully provisioned: 191 npm packages installed, Chromium r1243 + headless shell
downloaded and verified launching (v153.0.8010.12). No further setup needed.

## Where things stand

| Suite | Result |
| --- | --- |
| `npm run build` (12 packages) | **clean**, exit 0 |
| Unit + docs (`--project unit --project docs`) | **99 / 99 passing** |
| Reliability gate | **8 of 10 spec files green**; 4 assertions failing across 2 files |
| CLI e2e (`--project e2e`) | written, **not yet executed** |

### Reliability gate, per spec file

| Spec | Status |
| --- | --- |
| `same_test_100_runs` | PASS — 12 runs, 49s wall, median 3813ms, p95 5944ms, 3MB disk, 1 bounded infra retry |
| `one_manifest_per_run` | PASS |
| `monotonic_timestamps` | PASS |
| `network_action_correlation` | PASS |
| `no_retry_hides_product_failure` | PASS |
| `artifact_integrity_hashes` | PASS |
| `interrupted_worker_typed_outcome` | PASS |
| `fixture_app_classification` | PASS |
| `redaction_before_persistence` | **2 failing** |
| `offline_session_reconstruction` | **2 failing** |

## The 3 open defects, with diagnosis

### 1. `urlToken` still reaches the raw event log

```
secret urlToken leaked into .../artifacts/raw-event-log/2a/2adf....jsonl
```

`?access_token=AKIAIOSFODNN7EXAMPLEKEY123` survives into the persisted raw log.

Collection-time URL redaction was added (`Redactor.redactUrlString`, wired into the collector's
request/response/finished/failed/navigation handlers). It did not fully close the leak, so the
token is arriving by a path that is still unredacted. Most likely remaining source: the fixture
issues the request from inline page script, so the URL may also appear in a **DOM snapshot's
script body** — that is now dropped — or in a **console/exception message**, or the
`url-query-secrets` rule is not matching `access_token` in the `network.url` scope the way
`redactUrl` invokes it (`compiledQueryKey` is consulted only in `redactUrl`, and the fallback
path calls `redactField` with `key`, which uses `compiledKey`, not `compiledQueryKey`).

**Next step:** grep the failing `raw-event-log` artifact for the token and identify which event
category carries it. Do not widen the policy until the carrying field is known.

### 2. `cartCount` absent from normalized evidence

```
expected '{ "actions": [ ... ' to contain 'cartCount'
```

Storage capture now works — a single run shows `storage: {status: complete, collected: 3}`. So
this is specific to the `sensitive` fixture run. Likely: `captureStorage()` runs after the last
action, but the sensitive experiment's final action is `waitFor networkidle`, and the page may
have navigated or the values may be written after capture. Verify by dumping the storage event
from that run's raw log.

### 3. Offline reconstruction not byte-identical

```
expected { actions: {...}, ...(11) } to deeply equal { ...(12) }
```

The rebuilt object has 11 top-level keys where the original has 12 — a **structural** difference,
not a value one. Find the missing key first; that will name the cause. The per-event running
counter in the redaction stamp was already fixed (`policyStamp()`), so this is something else —
check whether `assertionOutcomes` or `artifactIdsBySeq` are absent on the rebuild path, since the
test supplies the former but not the latter.

## What was already found and fixed this session

All seven are logged with causes in `docs/FREEZE-M0.md` (amendment log). The gate caught every one
of them; none were found by reading the code.

1. **DOM snapshots persisted under a `RedactionStamp` without ever being redacted** — a JWT in an
   inline `<script>` reached disk while the stamp claimed redaction had run. The exact false
   assurance ADR-0008 exists to prevent. Snapshots now redact text and attributes; script/style
   bodies are dropped as page source.
2. **Transport failure on first navigation classified `AUTOMATION_FAILED`** instead of
   `INFRASTRUCTURE_FAILED`. ADR-0005 names this as the hardest boundary in the system and the
   implementation had it backwards.
3. **`seq` allocated at event construction, not at push** — the async response-body path awaited
   between allocation and push, leaving the persisted log out of seq order. Everything downstream
   correlates by seq.
4. **Per-event redaction stamps embedded a running occurrence counter**, so replay produced
   different bytes than the original run, breaking ADR-0007's byte-identical claim.
5. **URLs were redacted only at normalization**, but the raw log is persisted, so query secrets
   reached disk regardless. (Partially fixed — see open defect 1.)
6. **Storage was a declared capture category no code ever populated.**
7. **Bounded infrastructure retry was specified but never implemented** —
   `maxInfraRetriesPerRepetition` sat in config with nothing reading it. Now implemented in
   `Worker.drain`: `INFRASTRUCTURE_FAILED` retries as a new linked row; `PRODUCT_FAILED`,
   `VALID_COMPLETED`, `AUTOMATION_FAILED`, and `INTERRUPTED` are never auto-retried.

Two further changes were to my own tests, not the product:

- `network_action_correlation` asserted attribution be identical across repetitions, which
  conflated "our rule is deterministic" with "the network is deterministic". Now asserts the rule.
- `same_test_100_runs` asserted zero retries ever occurred, which asserts the environment never
  hiccups. Now asserts every **repetition** yields a valid observation, and that retries are
  bounded and linked.

The intermittent fixture was also genuinely defective — it raced on wall-clock timing rather than
being seed-deterministic, so predicted and actual failing sets disagreed. Rewritten so the seed
decides. `fixture_app_classification` now passes.

## Deliberately NOT done

**The performance budget was not relaxed.** The reliability strategy says a budget that cannot be
met is renegotiated in writing, never quietly edited. At 12 runs the current numbers fit inside
the scaled budget, so no renegotiation is needed yet. The full 100-run budget has **not** been
measured — run without `RELIABILITY_RUNS` to test it. Note this machine is not a CI runner
(15-minute npm installs, 45-minute browser download).

## Still open from M0

- **Q3 — CI provider and runner class.** `.github/workflows/gate.yml` exists as the reference
  implementation but has never executed. Until it runs green somewhere, "M1 gate passes in CI" —
  your stated M2 entry criterion — is not satisfied, however green it is locally.
- **Q5 — partially resolved.** Credential located (DeepSeek platform key in
  `ANTHROPIC_AUTH_TOKEN`). Still needed: the `REASONING_MODEL` id, and a decision on endpoint
  shape (the env points at the Anthropic-compatible `/anthropic`; ADR-0009 targets the
  OpenAI-compatible `/v1`). M3 only.
- Q4 (real target app), Q6 (price table), Q7 (CI secret) — none block M1.

## Milestone discipline

M2 may not begin until the gate is 10 of 10 and passing in CI. Two spec files and three
assertions stand between here and the first of those.
