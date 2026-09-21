# ReproAgent

A local agent that investigates **intermittent** Chrome-based web issues: the bugs that happen one
time in five, that nobody can reproduce on demand, and that get closed as "cannot reproduce".

You describe the bug in your own words. The agent drives a real browser until it reaches the
reported behaviour. It turns that session into a Playwright script, checks the script replays,
and repairs it if it doesn't. Then it runs the script as many times as you ask and tells you how
often the bug actually happened.

> Playwright produces evidence. Deterministic software normalizes and measures evidence. DeepSeek
> interprets and prioritizes evidence. Humans authorize consequential transitions.

That sentence is the architectural contract. Browser execution and evidence capture never call a
model. A model never decides an outcome, a statistic, or an approval.

---

## Why it exists

A single run of an intermittent bug tells you almost nothing. One green run doesn't show the
defect is gone, and one red run doesn't show where it lives. You need many identical runs, and
you need to tell them apart afterwards. The usual shortcuts corrupt that answer:

| The shortcut                         | What it costs you                                               |
| ------------------------------------ | --------------------------------------------------------------- |
| Re-run until it passes               | The failure is now invisible, and the rate is unknown           |
| Retry on failure                     | A product defect is hidden by the retry that "fixed" it         |
| Let a model read logs and explain    | A fluent explanation with no way to check whether it is true    |
| "It failed, so the app is broken"    | A broken step in your own script is counted as a product defect |
| Eyeball two runs and spot the change | Works for three runs, not thirty                                |

ReproAgent runs the same sequence N times and records each run. It separates runs that never got
as far as the bug from runs that reached it, and counts only the second kind.

## What happens, end to end

```
  your bug report (prose, a URL, test-account details, the platform — in any order)
          │
          ▼
   ① plan ────────────► the authoring model writes a numbered plan, with NO browser tools,
          │              naming every value it would type and every gap it can't fill
          ▼
   ② you read it ─────► "Looks right — go", or a correction
          │
          ▼
   ③ author ──────────► a real Chrome, driven through Playwright MCP, on the platform you named
          │              (desktop, Android Chrome emulation, throttled low-end Android).
          │              You watch it live. It stops and asks when only you know the answer.
          ▼
   ④ script ──────────► every browser call it made is recorded as a Playwright statement and
          │              assembled into a standalone suite — not rewritten from a description
          ▼
   ⑤ replay check ────► the agent runs the script twice by itself
          │                 reached the final check both times? ──► ⑦
          │                 stopped early?                      ──► ⑥
          ▼
   ⑥ repair ──────────► the same session is resumed with where the replay stopped, what it
          │              was waiting for and what the page showed; it records the flow again.
          │              At most twice, then back to ⑤
          ▼
   ⑦ run it N× ───────► you pick the count; the agent runs it, records every run's evidence,
          │              and reports reached the check · failed at the check · stopped early
          ▼
   ⑧ analyse ─────────► what separates failing runs from passing ones, and the one condition
          │              worth testing (for example: "it fails when the network is slow")
          ▼
   ⑨ confirm ─────────► one click runs the script with that condition and without it, interleaved,
                         and counts only failures that look like the ones already seen
```

The same flow as four agents:

| Agent            | Steps                | What it is                                                                              |
| ---------------- | -------------------- | --------------------------------------------------------------------------------------- |
| **Planner**      | ①–②                  | the authoring model with no browser; asks until you press **That's all I know**         |
| **Reproducer**   | ③–⑥                  | the authoring model driving Playwright MCP; goes back to the Planner when it gets stuck |
| **Executor**     | ⑦, and the runs of ⑨ | deterministic: the script, N times, with every run's evidence recorded                  |
| **Investigator** | ⑧–⑨                  | a deterministic contrast, a DeepSeek reading of it, and a measured confirmation         |

Alongside the suite, a session also writes the same flow as an **experiment proposal**. That feeds
the measured path, where a human approves a checksum-bound proposal before anything runs. Runs
there get full evidence capture, and afterwards the agent computes what separates failing runs
from passing ones. See [The measured path](#the-measured-path).

## Setup

### Prerequisites

| Need                  | Why                                                                                  |
| --------------------- | ------------------------------------------------------------------------------------ |
| **Node 22.5+**        | Storage uses `node:sqlite`, which does not exist before 22.5 (ADR-0021)              |
| **Chrome / Chromium** | Installed by Playwright below                                                        |
| **`claude` CLI**      | Runs the authoring session. On `PATH`                                                |
| **A DeepSeek key**    | The authoring model runs on DeepSeek; the optional `--ai` analysis steps also use it |

There is no database server, no Docker and no native build toolchain. A workspace is a directory.

### Install

```bash
git clone <repo-url> reproagent
cd reproagent
npm ci
npm run build
npx playwright install chromium chromium-headless-shell
```

### Check the install — no key needed

```bash
npm run demo
```

This creates a throwaway workspace and runs the deterministic pipeline against a local fixture
app: a refused run, an approval, four real Chromium runs, and a verified lineage chain.

### Configure the authoring model

The authoring session spawns `claude` with `deepseek-v4-flash` at `medium` effort, through
DeepSeek's Anthropic-compatible endpoint. It resolves its settings in this order:

1. `ANTHROPIC_MODEL`, `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN` in the environment
2. the `env` block of `~/.claude/settings.json`
3. `deepseek.json` in the working directory or your home directory
4. for a `deepseek-*` model with no base URL, `https://api.deepseek.com/anthropic`, and
   `DEEPSEEK_API_KEY` as the token

Variables that would redirect the CLI to another provider (Bedrock, Vertex and similar) are
stripped. `investigate doctor` shows the model, effort, endpoint host and whether a token is set.

### Configure the analysis steps (optional)

Only `intake --ai`, `plan --ai` and `analyze --ai` need this:

```bash
cp .env.example .env      # gitignored
```

```bash
DEEPSEEK_API_KEY=...
DEEPSEEK_BASE_URL=https://api.deepseek.com      # the OpenAI-compatible base
DEEPSEEK_FAST_MODEL=<id>
DEEPSEEK_REASONING_MODEL=<id>
DEEPSEEK_FALLBACK_MODEL=<id>
```

Model ids are never guessed or substituted. The real environment always wins over `.env`, and
`REPROAGENT_NO_ENV_FILE=1` ignores the file. If the key already lives in another variable, name it
in `config.yaml` instead of copying it: `llm.apiKeyEnv: MY_EXISTING_VARIABLE`.

### Start it

```bash
node apps/cli/dist/bin.js init --workspace ./repro-workspace    # once
npm run serve
```

Open **http://127.0.0.1:9999/**. `npm run serve` supervises the server: if it exits it comes back
on the same port, backs off on repeated failures, and logs to `.logs/web-<port>.log`. It takes
`--port` and `--workspace`. `npm run web` runs the same server in the foreground, unsupervised.

After changing the agent's code, rebuild and restart the server, then reload the page.

## Using the chat page

### Describing the bug

Paste whatever you have: a paragraph, steps, a URL, the test account, the device. There is no form.
Everything you send, in the first message or any later one, is treated as information. The agent
works out what each piece is and asks only when something is genuinely ambiguous.

- **Where to run.** The first `http(s)` URL in the report becomes the target, named after its host.
  You are asked for a URL only when the report has none and no target is configured.
- **Which platform.** "mobile web", "Android Chrome", "on a slow phone" and similar pick an emulation
  profile (`desktop-chrome-1440`, `pixel-7-chrome-mobile`, `low-end-android-throttled`). The plan
  says which one it chose and why, and the browser is launched with it.
- **Test accounts.** A phone number, OTP, email or password you mention goes to this session's
  credential store. The model is only ever told its name, e.g. `ACCOUNT_PHONE`. See
  [Credentials](#credentials).

### Settling the plan

Before any browser opens, the agent writes a plan and may ask up to three questions about what only
you know: which account, which data, which variant of the flow. Answering **revises the plan** and
shows it again. It does not open the browser. Each version is kept as `plan.v<N>.md` beside the
current `plan.md`.

**That's all I know** sits beside the input box for as long as the plan is being worked out. It
stops the questions: the agent writes the final plan with whatever is still missing marked `???`,
and the browser session works those out from the page. Anything you had typed is sent with it.

"Looks right — go" approves the plan card you are reading, bound to its SHA-256. If the plan on disk
changed after it was shown, the approval is refused with `GATE_CHECKSUM_MISMATCH` and nothing
opens.

### Watching it work

While the session drives the browser, a **live viewport** stays pinned at the top of the
conversation and refreshes about once a second. The step log scrolls underneath it, so the page
and the latest steps are visible together. Mobile profiles are shown in portrait.

When the agent offers choices, such as "Looks right — go", "Change something" or "Watch the
browser", the input box is disabled until you pick one. When it asks a free-text question, the
box is live and your answer resumes the same session. The browser profile and the steps already
done are kept. **That's all I know** is offered again there. It tells the same session you have
nothing more, so it carries on with what it has or stops and says exactly what is missing.

If the session stops without getting there, and not just because it ran out of turns, the card
offers **Re-plan with this**. The reason it stopped goes into a new planning turn, the same one an
answer to the plan uses. You get a revised plan card (the previous version is kept as
`plan.v<N>.md`), and approving it starts a fresh browser session. "Add more detail" and "Try again"
are still there.

The **variables** pill in the header opens a side panel listing the credential names and
descriptions this session holds. You can add or delete one there. Values are always masked.

### When the script is ready

The ready card shows the steps, the script, and any screens marked as appearing only on some runs.
Then, without another click:

1. The agent replays the script twice.
2. If a replay stops before the final check, the agent says where and sends that back to the
   authoring session to record the flow again. This happens at most twice.
3. Once both replays reach the final check, the card offers **Run it N×**, with 30× and 100×
   shortcuts. Above the buttons it plays the **recording of the replay**, so you can see the script
   do the flow before you run it many times. The video is loaded when the card appears, so a later
   N× run, which clears the suite's `artifacts/` folder, does not change what the card shows. The
   server reads the video's path from the suite's own Playwright report and serves only a `.webm`
   inside that `artifacts/` folder.

If the replay still stops before the final check after two repairs, the card says so and adds
**Re-plan with this**. The replay summary goes into a new planning turn, the same way as above.

The results card splits the runs:

| Line                    | Means                                                                      |
| ----------------------- | -------------------------------------------------------------------------- |
| **Reached the check**   | The flow got to the point where the bug shows or doesn't                   |
| **Failed at the check** | The bug happened. The failure rate is this over _reached the check_        |
| **Stopped before it**   | The script or the site, not the bug. Listed by line and what it waited for |

A failure at the final check is never sent to repair, because it may be the bug itself.

### Analyse, see the condition, confirm

After a run, the results card offers **Analyse**. It works on that batch's recorded evidence:

- the contrast between failing and passing runs
- a DeepSeek reading of that contrast
- at most one plain line for any finding held back because the evidence it rests on was incomplete

If the reading names a condition worth testing, a **See condition** card follows. It shows:

- the condition
- what would disprove it
- exactly what **Confirm** will run: the script 12 times with the condition (for example the network
  slowed to slow 3G) and 12 times without, interleaved

Only failures that match the ones already seen are counted.

**Confirm** is one click. The result card says **Confirmed** or **Not confirmed**, with:

- the plain counts for each arm
- other failures, which are shown but not counted
- the reason when not confirmed
- the likely cause when confirmed

There is no second approval step and no statistics to set. The settings are frozen into the
experiment the click confirms.

### Sessions

Each browser tab gets its own session and its own folder. A reload resumes the conversation, and
sessions survive a server restart. Sessions run concurrently without interfering. A page that
stops heartbeating releases its session after 60 seconds. A request without a live session is
refused rather than written into the shared workspace.

## Authoring

### Two phases, and the first has no browser

```bash
investigate author --investigation INV-001                         # writes the plan, opens nothing
investigate author --investigation INV-001 --approve-plan          # drives the browser (headless)
investigate author --investigation INV-001 --approve-plan --headed # watch it
```

The planning turn is spawned with no MCP config and no tool allowlist, so it cannot navigate,
click or submit while deciding what to do. Its plan names every value it would type and marks the
ones nobody supplied instead of inventing them:

```
PLATFORM: pixel-7-chrome-mobile — the report says "on my Android phone"
2. Sign in with ACCOUNT_PHONE and the OTP ACCOUNT_OTP.
4. Fill "New Password" with ??? — not given, need a value to type.
7. Check: wait for the confirmation text.
```

Before approving, the plan can be revised, and each revision is kept as `plan.v<N>.md`:

```bash
investigate author --investigation INV-001 --answer "sign in as the QA account"   # re-plans
investigate author --investigation INV-001 --thats-all                            # final plan, gaps marked
investigate author --investigation INV-001 --approve-plan --plan-checksum sha256:<planChecksum>
```

The planning turn's `--json` output carries `planVersion` and `planChecksum`. With
`--plan-checksum`, an approval is refused (exit 3) unless `plan.md` still hashes to it. The
approved plan's hash is recorded in lineage as `PLAN-<investigation>-v<N>`. That record is an
authoring authorization, not one of the three gates, and it never authorizes a measured run.

When the session meets something only you know, it pauses and asks. Answering resumes it:

```bash
investigate author --investigation INV-001 --resume <sessionId> --answer "the one in the dialog"
```

Each resumed turn starts a fresh page on the same browser profile, and the session is told so.
Steps it already recorded stay in the script.

### What the brief asks of the session

The authoring brief (`ai/authoring/brief.md`) is versioned and shapes the script the session
leaves behind:

- **Finish on a check.** The script ends by waiting for the outcome the report describes, right
  when it is on screen. A script with no check passes every time and measures nothing, so it is
  refused at emit time.
- **Wait for what you submit to finish.** After a sign-in, sign-up, save or delete, wait for
  on-screen proof it went through before the next step. Without that, replays race the page.
- **Declare screens that only appear on some runs.** A sign-up form that shows for a new account
  but not an existing one is declared as `OPTIONAL: "Full Name" | 5`. The script handles it when it
  appears and carries on when it doesn't.
- **Spend turns on the flow.** No progress screenshots and no digging through saved files.

### What a session emits

A session that reaches the behaviour writes to `<investigation>/authoring/`:

| Artifact                     | For                                                                       |
| ---------------------------- | ------------------------------------------------------------------------- |
| `suite/tests/repro.spec.ts`  | The reproduction as ordinary Playwright                                   |
| `suite/playwright.config.ts` | The emulation profile, video and trace, and time limits sized to the flow |
| `suite/package.json`         | Its own `@playwright/test`, so it never resolves a mismatched copy        |
| `experiment-proposal.json`   | The same flow in the closed action vocabulary, for the measured path      |

A session that doesn't reach the behaviour writes nothing. A partial reproduction looks complete,
and the next person would run it.

**The script is assembled, not reconstructed.** Playwright MCP records the exact statement behind
every browser call, so the suite uses the same calls, order and selectors as the run that worked.
Selectors are role plus accessible name, which survive a CSS refactor.

**Time limits fit the flow.** Each action gives up after 15 seconds. The whole run gets
30 seconds plus 10 seconds per step, so a slow step fails on its own line instead of the run
hitting a flat ceiling.

**Optional screens are checked, not trusted.** A declaration becomes a block only if its trigger
matches a recorded step and the block contains no navigation or check. Otherwise the step stays
mandatory, and the ready card says why. The emitted block waits for whichever comes first, the
optional screen or the next step:

```ts
const optional1 = page.getByRole("textbox", { name: "Full Name" });
if (
  await optional1
    .or(NEXT)
    .first()
    .waitFor({ state: "visible" })
    .then(
      () => optional1.isVisible(),
      () => false
    )
) {
  // the recorded steps for that screen
}
```

A suite with optional blocks is not translated into an experiment proposal, because the action
vocabulary has no conditional. The card says so.

### Replaying and repairing

```bash
investigate rerun --investigation INV-001 --repeat 30
```

`rerun` installs the suite's own dependencies on first use, then runs
`playwright test --repeat-each=N` with stored credentials in the child environment. It writes:

- `suite/artifacts/last-run.report.json`, Playwright's JSON report
- `suite/artifacts/last-run.evidence.json`, the breakdown below plus, for each place a run stopped,
  the line, the statement, what it was waiting for, how many runs stopped there, and the page
  snapshot Playwright saved

It reports `reachedCheck`, `failedAtCheck`, `stoppedEarly` and
`failureRate = failedAtCheck / reachedCheck`.

#### Every run's evidence

Each repeat is also recorded by the same collector the measured path uses:

- console messages and page errors
- every request and response, with bodies when `execution.capture.responseBodyMaxBytes` allows
- navigations
- local storage, session storage and cookies at the end of the run

Collection-time redaction runs before anything is buffered. It applies the workspace's redaction
policy, and every stored credential value is masked by identity.

The suite itself is not changed:

- For the run, `rerun` writes a copy of its tests into `suite/.reproagent/`. The only change in the
  copy is the `@playwright/test` import line, which becomes a capture fixture, so line numbers are
  identical.
- It runs that copy with the suite's own config, then deletes the folder.
- If a spec loads Playwright some other way, the suite runs exactly as before, and the result
  says `capture: { supported: false, reason }`.

The runs are stored as a batch in the evidence store:

- per run, the raw event log and the normalized evidence
- the recording, stamped `video-raw-unredactable` like every video
- a `rerun-batch` record listing each run's classification and outcome
- an `evidence-quality` record, which is internal (see below)

Before anything is written, stored credential values are masked again in the raw logs. Authored
runs have ids like `ARUN-001-003` and no row in the measured path's `runs` table, so the 100-run
gate and `investigate analyze` of measured runs are unaffected.

Outcomes come from the existing six rules:

| Run                          | Outcome                 |
| ---------------------------- | ----------------------- |
| failed at the final check    | `PRODUCT_FAILED`        |
| stopped earlier              | `AUTOMATION_FAILED`     |
| reached the check and passed | `VALID_COMPLETED`       |
| failed before any step       | `INFRASTRUCTURE_FAILED` |

The script's own statements are not seen as actions, so `actions` is `unsupported` for these runs
rather than looking complete.

`rerun --json` keeps every field it had. It adds:

- `capture`
- `evidenceIngested`
- when stored: `batchId`, `runIds`, `evidenceQualityRef` and `batchRef`
- `evidenceError` when the batch could not be stored. That never fails the run, and the counts
  stand.

**Evidence quality.** Each batch has a summary of which evidence categories were complete in which
runs, and a fixed table of what each kind of claim needs. For example, a `console` claim
needs `console`, and a `network` claim needs `networkMetadata`. It never blocks a batch and is
not shown. The Investigator uses it to withhold a finding only when the evidence that finding needs
was incomplete in a run it cites.

```bash
investigate author --investigation INV-001 --resume <sessionId> --repair
```

`--repair` reads that evidence and resumes the authoring session with it. Every stored credential
value is replaced by its name first. The session is told the browser restarted in the state the
replay left, and is asked to record the whole flow again from the start. That includes the
post-submit waits and declaring any screen the replay met that the first recording never saw. It
refuses when there is no evidence, or when nothing stopped early.

## Credentials

Most intermittent bugs happen only while signed in, so "use this test account" is the normal
case. A value you supply takes its own road:

- It is written by the local server straight into `<session>/.investigator/.credentials.json`, and
  never passed on a command line. Each authoring run copies them into the `.secrets.env` file it
  hands to Playwright MCP.
- The report, the transcript and every prompt carry only its **name**. Playwright MCP resolves the
  name from a secrets file at the moment it types the value.
- Every stored value is registered with the redactor before a batch runs, so a value that surfaces
  in a DOM snapshot or console line is masked by identity.
- A repair prompt replaces every stored value with its name before it is sent.
- `DEEPSEEK_API_KEY` never lives in the store.

The store is for throwaway test accounts on the machine already driving the browser. It is not a
vault.

Values stay out of text, but **video is raw pixels**. A credential visible on screen is visible in
the recording. On the measured path, videos are stamped `video-raw-unredactable` for that reason.

## The measured path

The authored suite answers "how often does this happen?". The measured path answers "what is
different about the runs that failed?", with full evidence and human approval.

```bash
CLI="node apps/cli/dist/bin.js"; WS=./repro-workspace

$CLI plan    --workspace $WS --investigation INV-001 --from <investigation>/authoring/experiment-proposal.json
$CLI approve experiment_selection --workspace $WS --investigation INV-001 --scaffold --approver "Your Name"
$CLI approve experiment_selection --workspace $WS --investigation INV-001 --from <approval.yaml> --checksum <sha256:...>
$CLI run     --workspace $WS --investigation INV-001 --target my-target
$CLI analyze --workspace $WS --investigation INV-001            # add --ai for an interpretation
$CLI lineage --workspace $WS --investigation INV-001 RUN-001
```

### Translation, not execution

Model-authored source is never run on the measured path. Each recorded statement is reduced to the
declared vocabulary: `getByRole(...)` becomes a `role` selector, and `.filter({ hasText })` and
`.nth()` become fields on it. Anything the vocabulary cannot express is refused by name.

Every translated action is then rendered back into a Playwright statement and compared with the
original. One mismatch refuses the whole translation. A proposal missing a step from the middle is
not a shorter flow, it is a different one. A typed value matching a supplied credential becomes a
`secretRef`.

### Approvals

There are three gates: `experiment_selection`, `target_failure` and `final_reproduction`. Each is
file-based and SHA-256-bound to the exact proposal bytes a human read.

- Scaffolding approves nothing.
- Edits are allowed inside a gate's edit surface, and **execution consumes the edited proposal**.
- Removing an item from `approvedItemIds` rejects it.
- There is no `--yes`, `--force-approve` or `--auto`, and a test asserts their absence.
- The chat page approves in one click, bound to the checksum of the card you read. The CLI
  recomputes it and refuses any mismatch.

Re-running `plan` re-renders the proposal with a new timestamp, so an existing approval no longer
matches. Delete the approval file, scaffold again and approve with the new checksum.

### Runs and evidence

One browser per batch, a fresh `BrowserContext` per run. Execution and normalization take a
seeded RNG and an injected clock, and normalization is a pure function, so a session can be
rebuilt byte-identically offline.

Twelve evidence categories are captured: actions, navigation, console, exceptions, network
metadata, response bodies, DOM snapshots, storage, screenshots, video, trace and WebSocket frames.
Every run gives every category a status:
`complete` · `partial` · `missing` · `redacted` · `unsupported` · `corrupted` · `disabled`.
A signal absent from a `missing` category means "not captured", never "did not happen".

Redaction happens before persistence and fails closed. A store call without a redaction stamp
raises `REDACTION_NOT_APPLIED`. Every artifact is content-hashed at write time.

### How a run is classified

Six ordered rules. The order is the design:

| #   | Outcome                 | When                                                                  |
| --- | ----------------------- | --------------------------------------------------------------------- |
| 1   | `INTERRUPTED`           | The run was cut short                                                 |
| 2   | `INFRASTRUCTURE_FAILED` | The harness or environment failed, not the product                    |
| 3   | `AUTOMATION_FAILED`     | Our instructions were wrong: a selector missed, an origin was refused |
| 4   | `PRODUCT_FAILED`        | A declared assertion failed, or a failure predicate matched           |
| 5   | `VALID_COMPLETED`       | Everything declared passed **and** required evidence is usable        |
| 6   | `INCONCLUSIVE`          | Green, but a required evidence category is missing                    |

Rule 3 comes before rule 4, so a broken script is never reported as a product defect. Only
`INFRASTRUCTURE_FAILED` and `INTERRUPTED` are retried, so a retry can never hide a product failure.

### Analysis

`analyze` first computes a contrast with `contrastRuns`, a pure function. It finds which console
fingerprints appear only in failing runs, which request orderings separate the groups, and how
timings differ. With `--ai`, DeepSeek then reads that contrast and proposes what it means:

- Output is schema-validated, and unknown fields are rejected.
- A citation to a run the tools never returned is refused, not repaired.
- A claim at `probable_trigger` or above needs a citation with a field and an expected value.
- `confirmed_root_cause` is unreachable by design. It needs evidence from inside the application,
  which a client-boundary tool cannot have.

Claim levels: `observed` → `correlated` → `probable_trigger` → `high_confidence_trigger` →
`confirmed_trigger` → `root_cause_hypothesis` → `confirmed_root_cause`.

### Lineage

Every consequential step appends to a per-investigation, append-only, hash-chained graph.
`investigate lineage <id>` answers offline which human decision authorised a run, and which flow
and prompt bytes produced an interpretation. It is tamper-evident, not tamper-proof.

## Command reference

| Command                                                                   | Does                                                                                           | Model     |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | --------- |
| `init`                                                                    | Create a workspace: database, `config.yaml`, redaction policy, directories                     | no        |
| `intake`                                                                  | Open an investigation from a report file                                                       | `--ai`    |
| `author`                                                                  | Write the plan; `--approve-plan` drives the browser; `--resume` answers; `--repair` re-records | authoring |
| `rerun`                                                                   | Run the authored suite `--repeat N` times (1–500), break down where runs ended, store evidence | no        |
| `confirm`                                                                 | Show (no `--checksum`) or run (with it) a proposed condition against a control                 | no        |
| `plan`                                                                    | Render the gate-1 proposal a human decides on                                                  | `--ai`    |
| `approve <gate>`                                                          | Record a checksum-bound approval; `--scaffold` writes a blank one                              | no        |
| `run`                                                                     | Execute approved experiments. Never calls a provider                                           | no        |
| `analyze`                                                                 | Report what separates failing runs from passing ones; `--batch <id>` reads a rerun batch       | `--ai`    |
| `suite generate`                                                          | Emit a standalone Playwright spec for approved experiments                                     | no        |
| `status`                                                                  | Gate states, run outcomes, queue and lineage health                                            | no        |
| `show <what>`                                                             | Print a rendered proposal or an artifact                                                       | no        |
| `lineage <nodeId>`                                                        | Ancestors and descendants of a node, with the actor on every hop                               | no        |
| `doctor`                                                                  | Workspace, config, queue, integrity, provider and authoring setup; `--verify-lineage`          | no        |
| `retention apply`                                                         | Tombstone artifacts past their retention age; dry run without `--confirm`                      | no        |
| `classify`, `frequency run`, `minimize`, `revalidate`, `report`, `export` | Registered but not implemented; exit 1 with `NOT_IMPLEMENTED`                                  | —         |

Global flags: `--workspace <dir>`, `--investigation <id>`, `--json`, `--verbose`, `--seed <int>`,
`--no-color`. `--json` puts machine-readable output on stdout and human text on stderr.

Other `author` options: `--headed`, `--max-turns <n>` (default 60), `--env <name>`, `--thats-all`
(planning: write the final plan without asking again), `--plan-checksum <sha256:…>` (with
`--approve-plan`: refuse unless the plan on disk is the one read). In the planning phase, `--answer`
revises the plan.

`confirm` options: `--condition <n>`, the proposed condition from 1; `--checksum <sha256:…>`, the
checksum of the experiment shown, which runs it; `--per-arm <n>`, 10–100, default 12; `--batch <id>`.
Without `--checksum` it prints the experiment and its checksum and runs nothing. With a checksum
that no longer matches, it refuses with `GATE_CHECKSUM_MISMATCH` (exit 3) before any browser
opens. See ADR-0031 for what is counted and how the verdict is decided.

### Exit codes

| Code | Meaning                | Code | Meaning              |
| ---- | ---------------------- | ---- | -------------------- |
| 0    | OK                     | 6    | Provider unavailable |
| 1    | Usage                  | 7    | Execution failed     |
| 2    | Gate required          | 8    | Evidence incomplete  |
| 3    | Gate checksum mismatch | 9    | Integrity failed     |
| 4    | AI output invalid      | 10   | Inconclusive         |
| 5    | Budget exceeded        |      |                      |

A run that observes a product defect exits **0**. Finding the bug is the job.

## Configuration

`<workspace>/.investigator/config.yaml` has six blocks: `llm`, `storage`, `execution`, `approvals`,
`safety` and `logging`. Any value may use `env:NAME`, and an unset variable is an error naming it.

```yaml
execution:
  video: "on" # quote it — bare `on` is boolean true in YAML 1.1
  targets:
    my-target:
      baseUrl: https://staging.example.com
      classification: test # fixture | test | staging — there is no "production"
      resetStrategy: per-run-tenant
      correlationHeaderAllowed: false

safety:
  allowedOrigins:
    - https://staging.example.com # this origin and its subdomains
  blockDestructiveActions: false # true requires a written justification per destructive action
  maxRepetitionsPerRun: 100
  maxRunsPerInvestigation: 10000

llm:
  apiKeyEnv: DEEPSEEK_API_KEY # a variable NAME, never a value
```

- **No `production` classification.** Declaring a target `test` asserts you are authorised to act on
  it.
- **Destructive actions.** Clicks labelled delete, remove, deactivate and similar are classified
  destructive. `blockDestructiveActions` is off by default, because deleting a disposable QA account
  is often the flow under investigation. When it is on, it applies at enqueue, at approval and in
  the executor, and it refuses outright on a `staging` target.
- **Emulation profiles.** `desktop-chrome-1440`, `pixel-7-chrome-mobile` (a pinned Android user
  agent, touch and device scale, not just a small viewport) and `low-end-android-throttled`. The
  chat page picks one from the report. On the measured path, set `emulationProfile` per experiment.

## Workspace layout

```
<workspace>/
  .investigator/                     The root workspace: config.yaml, investigator.db, policies/
  .web/                              Chat users, sessions and the API token (not evidence)
  sessions/<timestamp>-<id>/         One folder per chat session, itself a workspace
    .investigator/
      config.yaml                    Machine settings from the root; targets deliberately NOT copied
      investigator.db
      .credentials.json              Test-account values supplied in this session
      investigations/INV-001/
        manifests/  approvals/  artifacts/  normalized/
        authoring/
          plan.md, plan.v<N>.md (earlier versions), platform.json, attempt.json,
          browser-config.json, mcp-config.json,
          .secrets.env, live/ (the live-view frame)
          suite/                     tests/repro.spec.ts, playwright.config.ts, package.json,
                                     artifacts/last-run.report.json, last-run.evidence.json,
                                     .reproagent/ (only while a rerun is capturing)
        artifacts/rerun-batch/, artifacts/evidence-quality/   One record each per rerun batch
          experiment-proposal.json
    reports/report.md                The report as the CLI reads it; reports/versions/ keeps each edit
    session.jsonl                    What happened, appended as it happened
```

Nothing about what is being investigated crosses sessions. A new session inherits the provider,
storage, redaction policy and budgets, but no target and no credentials. Deleting a session folder
deletes its evidence; there is no second copy.

## Security posture

- **The web page is a privileged local surface**, because it starts processes. It binds `127.0.0.1`
  only, requires a token on every call, and refuses cross-origin requests. It accepts an action id
  with typed parameters, never a command line. The allowlist in `apps/web/src/actions.ts` is that
  boundary, and `apps/web/src/actions.spec.ts` covers what must not get through.
- **The page contains no pipeline logic.** Every action spawns the same `investigate` command you
  would type. Gates, redaction and the API key all live in that child process, so a web bug cannot
  approve a gate the CLI would refuse.
- **The API key is read from the environment only**, through a name allowlist, and wrapped in a
  `Secret` that refuses to serialise itself. It is never logged, persisted or put in an error.
- **The authoring session's browser tools are an allowlist**, checked against the pinned Playwright
  MCP server's real tool list in both directions. Tools that could fake a reproduction are refused.
- **Model output is untrusted.** It is validated before use and never overwrites a recorded fact,
  a measurement or an approval.
- **Video is not redacted**, and is labelled so. It is written only when `execution.video` is `on`.

## Scope

Chrome desktop and Chrome mobile **emulation**, for issues that reproduce at least occasionally and
are observable from the browser, in environments you are authorised to test.

It does not claim to reproduce real-device Android behaviour or to capture everything a browser
can see. Where an evidence category is missing, partial, redacted or unsupported, it says so. It is
not a generic test generator, a log viewer, a session recorder, or a replacement for QA.

## Development

```bash
npm run build && npm run lint && npm run format:check && npm run typecheck
npm test                  # unit
npm run test:docs         # governing principle, schemas, import boundaries, flow examples
npm run test:e2e          # the CLI against the built binary, including every web action
npm run test:reliability  # browser-backed behavioural gates; run on an idle machine
```

```
apps/cli/            The `investigate` binary, authoring, rerun and repair
apps/web/            The chat page and its local server; spawns the CLI
packages/            core · storage · execution · evidence · lineage · approvals ·
                     ai-gateway · tools · ai-flows · test-fixtures · reporting
ai/authoring/        The authoring brief
ai/flows/            Versioned prompts for the DeepSeek analysis steps
schemas/             Versioned JSON schemas for every persisted and model-produced document
docs/adrs/           Architecture decision records
docs/architecture/   Component, evidence, queue and approval models
docs/security/       Security model and redaction policy
docs/operations/     Runbook
```

`packages/execution`, `packages/evidence` and `packages/test-fixtures` cannot import the AI
packages. `tests/docs/import-boundary.spec.ts` walks the module graph to enforce it.

## License

`UNLICENSED` / private. Not published to a registry and not licensed for redistribution.
