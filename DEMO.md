# ReproAgent — demo guide

> Playwright produces evidence. Deterministic software normalizes and measures evidence. DeepSeek
> interprets and prioritizes evidence. Humans authorize consequential transitions.

## Run it

```bash
npm ci && npm run build
npx playwright install chromium chromium-headless-shell
npm run demo
```

About 40 seconds. It creates a throwaway workspace in your temp directory and deletes it
afterwards.

| Flag                            | Effect                                                              |
| ------------------------------- | ------------------------------------------------------------------- |
| `node scripts/demo.mjs --pause` | Waits for Enter between chapters — use this in front of an audience |
| `node scripts/demo.mjs --keep`  | Keeps the workspace and prints its path, so you can poke around     |

**No DeepSeek API key is needed.** The script actively clears every `DEEPSEEK_*` variable before
it starts, so "the deterministic path needs no credential" is demonstrated rather than claimed.

## The one-sentence pitch

An agent that investigates intermittent browser bugs, where **nothing reaches a browser without a
recorded human decision**, and every conclusion traces back to evidence a machine measured.

## What each chapter proves

| #   | Chapter                    | The point                                                                                                                |
| --- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| 1   | Create a workspace         | SQLite in WAL, redaction policy seeded, everything local                                                                 |
| 2   | Take in a bug report       | Stored verbatim — _after_ redaction. A bug report is often where a secret first enters                                   |
| 3   | Render the gate-1 proposal | The rendering leads with **what would disprove** each hypothesis, so approving is a judgement rather than a rubber stamp |
| 4   | **Try to run it**          | `GATE_REQUIRED`, exit 2 — and **zero jobs enqueued**. Refusing is not enough on its own                                  |
| 5   | A human approves           | A wrong checksum is refused (exit 3). The operator approves one of two experiments and edits the repetition count        |
| 6   | Now it runs                | Real Chromium. Only the approved experiment runs, and the **edited** count is what executes                              |
| 7   | What authorised this?      | Full provenance, offline, with human/deterministic marked on every hop                                                   |
| 8   | Hand it to a developer     | Ordinary Playwright that runs without ReproAgent                                                                         |
| 9   | Health and integrity       | Artifacts content-hashed, lineage hash chain verified                                                                    |

## The three moments worth pausing on

**Chapter 4 — the refusal.** This is the product. A proposal exists, a fixture app is available,
and the agent still refuses and schedules nothing. The M1 bypass flag that used to allow this was
deliberately deleted.

**Chapter 5 into 6 — proposal versus effective proposal.** The human approved `EXP-001` only and
changed repetitions from 6 to 4. Two different checksums result, and what executes is the
**effective** one. So a human's edit is not advisory — it is what runs.

**Chapter 6 — `PRODUCT_FAILED` is a success.** Four runs failed and the exit code is 0. Finding a
product defect is the job. The system never retries a product failure away.

## Likely questions

**"Does it need an API key?"** Not for any of this. AI configuration resolves lazily, only when an
AI-dependent step runs. `doctor` reports it as `missing` and carries on.

**"How do you know the evidence is real?"** Every artifact is content-hashed at write time and
verified on read; lineage is append-only with a per-investigation hash chain. `doctor
--verify-lineage` reports the first break if there is one. It is tamper-**evident**, not
tamper-proof — the honest guarantee for a local tool.

**"Could the AI just run something?"** No. The approval gate sits between any proposal and the
executor, and one test walks the source to assert that only the `approve` command can create an
approval record. There is no `--yes`, `--force-approve`, or `--auto` flag; a test asserts their
absence too.

**"Is it flaky?"** The reliability gate runs 100 sequential browser runs and requires 100/100
`VALID_COMPLETED` with **zero retries** and **zero infrastructure failures**, twice in a row.
`npm run gate:twice` (~13 minutes).

## What is NOT built yet

Say this plainly if asked — it is in the README and in the demo's closing lines:

- **M4** run classification with DeepSeek
- **M5** failure-frequency statistics
- **M6** minimization, natural reproduction, controlled trigger, passing control
- **M7** Jira-ready report generation and reproducer export
- **M8** trace redaction pipeline

Built and working: M0 architecture, M1 deterministic execution and evidence, M2 the three approval
gates and lineage, M3 the AI gateway, flow artifacts, read-only tools and the replay eval harness.

The DeepSeek-backed steps (`intake --ai`, `plan --ai`) are implemented and wired, but have only
been verified against recorded fixtures — no live credential was available. That is stated as an
external blocker rather than glossed.

## If something goes wrong live

| Symptom                      | Fix                                                    |
| ---------------------------- | ------------------------------------------------------ |
| `Build first: npm run build` | Run it                                                 |
| Chromium fails to launch     | `npx playwright install chromium`                      |
| A port or temp-dir error     | Re-run; the demo uses a fresh temp workspace each time |

Fallback: `npm run test:e2e` runs the same guarantees as assertions in about 3 minutes.
