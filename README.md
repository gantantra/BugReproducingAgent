# ReproAgent

A standalone local CLI agent that investigates **intermittent** Chrome-based web issues — the
bugs that happen one time in five, that nobody can reproduce on demand, and that get closed as
"cannot reproduce".

> Playwright produces evidence. Deterministic software normalizes and measures evidence. DeepSeek
> interprets and prioritizes evidence. Humans authorize consequential transitions.

That sentence is the architectural contract, not a slogan. Browser execution and evidence capture
are deterministic and never call a model; a model never decides an outcome, a statistic, or an
approval. Any change that violates it is rejected regardless of convenience or test coverage.

---

## The problem this exists for

An intermittent bug is hard for a specific reason: **a single run tells you almost nothing.** One
green run is not evidence the defect is gone, and one red run is not evidence of where it lives.
You need many runs, executed identically, with enough captured from each to tell them apart
afterwards.

That is tedious to do by hand, and the usual shortcuts quietly corrupt the answer:

| The shortcut                             | What it costs you                                                           |
| ---------------------------------------- | --------------------------------------------------------------------------- |
| Re-run until it passes                   | The failure is now invisible, and the rate is unknown                       |
| Retry on failure                         | A product defect gets hidden by the retry that "fixed" it                   |
| Let a model look at logs and explain     | A fluent explanation with no way to check whether it is true                |
| "It failed, so the app is broken"        | A broken selector in your own script counted as a defect in the application |
| Eyeball two runs and spot the difference | Works for three runs, not thirty                                            |

ReproAgent is the opposite of each of those. It runs the same approved sequence N times, captures
a fixed evidence set from every run, classifies each run by an ordered rule set, and then answers
_"what is different about the runs that failed?"_ **by arithmetic**. A model is used only to
interpret that measurement, and only where every claim it makes can be checked against it.

## What it actually does

```
  a human's bug report
          │
          ▼
   ① intake ──────────► stored verbatim, redacted, content-hashed
          │                   └─ optional: DeepSeek reads it into a structured Flow
          ▼
   ② plan ────────────► a gate-1 proposal: ranked experiments, each with a FALSIFIER
          │
          ▼
   ③ approve ─────────► a HUMAN decision, SHA-256-bound to the exact bytes they read
          │              (nothing below this line can happen without it)
          ▼
   ④ run ─────────────► N deterministic Chromium runs, fresh context each,
          │              full evidence capture, redacted before it is stored
          ▼
   ⑤ analyze ─────────► what separates failing runs from passing ones — computed
          │                   └─ optional: DeepSeek reads that contrast and proposes causes
          ▼
   ⑥ suite generate ──► a standalone Playwright spec you hand to a developer
```

Every arrow is auditable afterwards: `investigate lineage <runId>` walks an append-only,
hash-chained graph and tells you which human decision authorised each step, and which flow and
prompt bytes produced each interpretation.

## Status

| Milestone                                                  | State                                                     |
| ---------------------------------------------------------- | --------------------------------------------------------- |
| M0 — architecture, ADRs, schemas                           | Accepted with recorded corrections (`docs/FREEZE-M0.md`)  |
| M1 — deterministic execution and evidence core             | Implemented; 100/100 runs, zero retries                   |
| M2 — lineage, the three approval gates, CLI workflow       | Implemented                                               |
| M3 — AI gateway, flows, read-only tools, eval harness      | Implemented; `intake --ai` verified against live DeepSeek |
| Chat UI (`apps/web`)                                       | Implemented; drives the CLI, holds no pipeline logic      |
| M4–M8 — classification, frequency, minimization, reporting | **Not implemented, and not planned**                      |

**What you can do today:** run a full investigation end to end against a local fixture or a real
target, with human approval, full evidence capture, provenance, an exported Playwright
reproduction, and a measured contrast between failing and passing runs.

**What you cannot:** get a failure-rate statistic with a confidence interval, automatic run
clustering, minimization of a reproduction down to its essential steps, or a Jira-ready report.

Those were M4–M8, and they are **not being built**. The partial groundwork that had been written
for them was removed rather than left in place: Wilson score intervals and ordering-inversion
counts for M5, capture-status aggregation and the overclaiming lint for M7, independent outcome
recomputation for M4, and around thirty other exported symbols with no caller anywhere, tests
included. Scaffolding for work that is not coming is not an asset — it is code every later reader
has to evaluate and every refactor has to carry.

Anything reinstating those milestones starts from the ADRs, which are unchanged and still record
the decisions. One consequence to note if M7 ever returns: `lintForOverclaiming` enforced this
project's language-discipline rule against generated report prose, and it went with the rest.

Every unimplemented command is still registered and exits 1 naming its milestone, rather than
silently doing nothing:

```bash
node apps/cli/dist/bin.js classify      # -> NOT_IMPLEMENTED, "Arrives in M4"
```

**Fixed, and worth recording because it hid three separate bugs.** `plan --ai` previously failed
with `AI_CAPABILITY_MISSING`. Behind that were:

1. **A circular capability probe.** The adapter refused to send `tools` unless capabilities already
   reported tool calling as supported, but the only way to observe that is to send tools. The
   probe's own request was refused, the refusal was recorded as evidence of non-support, and
   `toolCalls` could never leave `unknown`. A request may now declare itself a probe.
2. **The probe's answer was discarded.** `apps/cli/src/ai.ts` ran the probe but never gave the
   result to the provider — `capabilityLookup` was never set, so `complete()` kept reading the
   "unknown" defaults. It is now wired back per alias.
3. **A malformed tool history.** The runner appended tool results without the assistant message
   that had requested them, and then appended a fabricated assistant turn after them. The provider
   rejected it: _"Messages with role 'tool' must be a response to a preceding message with
   'tool_calls'"_. The assistant turn is now replayed with its `tool_calls`, and the fabricated
   one is gone.

The budget was then raised (`propose_experiments` 1.1.0) because it had been sized when no tool
call ever reached the provider: a real run refused before dispatch at a worst case of 29372 tokens
against a 26000 ceiling.

With those fixed the tool loop runs: the model calls all three read-only tools in parallel, the
results come back, and it reasons over them. **It still needs a configured target to produce
experiments** — without one, `get_application_constraints` returns `NOT_FOUND` and the model
correctly refuses to propose anything, which the output schema reports as a partial result. That is
the agent working as designed, not a defect. See [Pointing it at a real site](#8-pointing-it-at-a-real-site).

A fourth cause was then found and fixed: the outline of the required output shape sent to the
model (`requiredShape` in `packages/ai-flows/src/runner.ts`) followed only `$ref`s ending in
`.json` and never looked at `allOf`/`if`/`then`. So the model was told _"action requires actionId,
type"_ and nothing about the conditional shapes — that a `goto` also requires `url`, that an
`assert` requires an `assertion` **object**. Three separate live failures came from that one gap.
It now emits lines like `when type=goto: also requires url (may be null)`.

A fifth cause, confirmed by capturing the raw turns: **reasoning tokens are billed against the
same completion budget as the answer**, and `inferenceMode` was never sent to the provider. An
alias could declare `non-thinking` while the model reasoned anyway, because nothing put that on
the wire. A live `intake_to_flow` run spent all 7000 of its `max_tokens` on `reasoning_tokens` and
returned an empty `content`, which surfaced as "response is not parseable JSON" — a message that
says nothing about the cause.

`inferenceMode: non-thinking` now sends `thinking: {"type": "disabled"}`, verified against the
provider to remove reasoning entirely (`enable_thinking: false` was also tried and does nothing;
`unspecified` sends nothing and leaves the provider's default). The effect on the same report that
had been failing:

|                     | before              | after        |
| ------------------- | ------------------- | ------------ |
| `completion_tokens` | 7000                | 845          |
| `reasoning_tokens`  | 7000                | 0            |
| `content`           | empty               | 3571 chars   |
| result              | failed after repair | a valid flow |

`REASONING_MODEL` still thinks, which is the point of it, so `propose_experiments` is 1.2.0 with
`maxOutputTokens: 16000` — sized to leave the answer room after the model has finished thinking.

**Fixed.** With the budget raised, the flow completes and returns valid JSON explaining itself:

> "No experiments can be proposed. The flow targets the 99acres site, but the only allowed origin
> is http://127.0.0.1:8099. … none of these unknowns can be filled without inventing values, so
> there is no runnable experiment."

That is the correct answer, and the schema could not express it: `items` carried `minItems: 1`, so
an empty list failed validation, the flow spent its one repair attempt re-deriving the same answer,
and the extra turn exceeded the 120s wall clock — a correct result surfacing as a timeout. Raising
the wall clock would have treated the symptom.

`items` is now `minItems: 0`, and an empty list **must** carry a `summary` saying why (a schema
conditional, so the model is told: `when items is empty: also requires summary`). An empty list
with no reason is not an answer at all. `plan` reports it as `proposalRendered: false` with the
reason rather than failing, and writes no proposal triple — there is nothing to approve, and a
checksum over an empty bundle would let someone approve nothing.

A proposal can still only be grounded against a target whose origin matches the report: pointing
an investigation of a live site at a local fixture correctly produces no experiments, and now says
so.

A target is bound to an investigation **at intake**, not by existing in `config.yaml`. An
investigation opened before its target was recorded reads `target (none)` and the constraints tool
has nothing to answer with, so the chat UI re-opens the investigation after recording one.

Note also that `deriveRequestId` is content-addressed, so re-running a flow that failed _after_ the
ledger row was written collides on `ai_calls.request_id`. A retry needs a fresh investigation until
that is resolved.

## Setup and first run

Everything below was walked from a fresh clone on a clean machine. If a step here does not work,
that is a bug in this document.

### 1. Prerequisites

| Need             | Why                                                                                                           |
| ---------------- | ------------------------------------------------------------------------------------------------------------- |
| **Node 22.5+**   | The storage layer is built on `node:sqlite`, which does not exist before 22.5 (ADR-0021). Verified on Node 24 |
| **~400 MB disk** | The Chromium download                                                                                         |
| Git              | To clone                                                                                                      |
| A DeepSeek key   | **Optional.** Only the three `--ai` steps need one; nothing else does                                         |

No database to install, no native build toolchain, no Docker. SQLite is in-process and the
workspace is a directory.

### 2. Install

```bash
git clone <repo-url> reproagent
cd reproagent
npm ci
npm run build
npx playwright install chromium chromium-headless-shell
```

`npm ci` reports some advisories from transitive dev dependencies; they do not affect the CLI.

### 3. Check it works — 40 seconds, no key needed

```bash
npm run demo
```

This is the fastest proof the install is good. It creates a throwaway workspace, runs the whole
story against a local fixture app, and deletes it afterwards. You should see a **refused** run, an
approval, four real Chromium runs, and `lineage 14 records, chain verified`.

If that works, everything deterministic works.

### 4. The easy path: answer questions

```bash
npm run reproduce
```

Describe a bug in prose and it walks you through the rest: storing the report, showing where your
account points, asking about gaps, rendering a proposal, taking your approval, running it, showing
the recording, exporting a Playwright script, measuring more runs, and reporting what separates
the failures.

Choose **option 1 (a local fixture)** the first time. It touches nothing real and takes two
minutes, and you will then recognise every prompt when you point it at something that matters.

If you would rather click than type, `npm run web` gives the same workflow as a chat page —
see [The chat UI](#the-chat-ui).

### 5. The manual path, command by command

Same workflow, one command at a time. `$CLI` is just shorthand.

```bash
CLI="node apps/cli/dist/bin.js"
WS=./demo-ws

# 1. Create a workspace: SQLite database, config.yaml, redaction policy, directories.
$CLI init --workspace $WS

# 2. Open an investigation from a bug report.
$CLI intake --workspace $WS --from docs/examples/intake/blank-results.md
#    -> INV-001

# 3. Render the gate-1 proposal, and READ it. It leads with what would DISPROVE each hypothesis.
$CLI plan --workspace $WS --investigation INV-001 \
  --from docs/examples/proposals/gate-1.input.json

# 4. Try to run. This is REFUSED: exit 2, GATE_REQUIRED, and nothing is enqueued.
$CLI run --workspace $WS --investigation INV-001 --fixture-app product-failing-intermittent

# 5. Scaffold an approval file. This approves NOTHING; it prints the exact command for step 6.
$CLI approve experiment_selection --workspace $WS --investigation INV-001 \
  --scaffold --approver "Your Name"

# 6. Edit the scaffold if you want, then record the decision.
#    Easiest: copy the command step 5 printed — it already has the right checksum.
#    Or read the checksum from disk:
CK=$(cut -d' ' -f1 $WS/.investigator/investigations/INV-001/manifests/gate-1.experiment_selection.proposal.json.sha256)
APPROVAL=$WS/.investigator/investigations/INV-001/approvals/gate-1.experiment_selection.approval.yaml
$CLI approve experiment_selection --workspace $WS --investigation INV-001 \
  --from "$APPROVAL" --checksum "$CK"

# 7. Now it runs, and runs only what you approved.
$CLI run --workspace $WS --investigation INV-001 --fixture-app product-failing-intermittent

# 8. Read what the runs show. Deterministic; add --ai for an interpretation.
$CLI analyze --workspace $WS --investigation INV-001

# 9. Ask what authorised any of it, and check integrity.
$CLI lineage --workspace $WS --investigation INV-001 RUN-001
$CLI status  --workspace $WS --investigation INV-001
$CLI doctor  --workspace $WS --verify-lineage
```

Things worth understanding rather than just running:

**Step 4 is the product.** A proposal exists and a fixture app is available, and it still refuses
and enqueues nothing.

**Step 7 reporting `PRODUCT_FAILED` is success.** The agent observed a product defect. Exit code
is 0 and the failure is never retried away.

**Step 8 needs both groups to say anything.** With every run failing there is no control group, so
it says so and refuses to present anything as discriminating. Approving both experiments (as
above) gives a mix and a real contrast.

**Edit the approval to see the point of it.** Change `/repetitions` and step 7 runs the edited
count, because execution consumes the _effective_ proposal. Remove an item from `approvedItemIds`
and only the remaining one runs.

### 6. The one gotcha that will catch you

**Re-running `plan` invalidates any approval you already made**, even if the proposal content is
identical. The rendered proposal embeds `renderedAt`, so every render produces different bytes and
therefore a different checksum.

If you re-render, recover like this:

```bash
rm $WS/.investigator/investigations/INV-001/approvals/gate-1.experiment_selection.approval.yaml
$CLI approve experiment_selection --workspace $WS --investigation INV-001 --scaffold --approver "Your Name"
# then approve again with the NEW checksum
```

Scaffolding refuses to overwrite an existing approval file, which is why the `rm` comes first. The
error message says so when it happens.

### 7. Optional: turn on the AI steps

Only `intake --ai`, `plan --ai` and `analyze --ai` need this. Everything above works without it.

```bash
cp .env.example .env      # .env is gitignored
```

Fill in four values. Get your model ids from the provider rather than guessing — the CLI never
substitutes a model id it was not given:

```bash
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_FAST_MODEL=<id>
DEEPSEEK_REASONING_MODEL=<id>
DEEPSEEK_FALLBACK_MODEL=<id>
```

Use the **OpenAI-compatible** base URL. The provider adapter calls `${baseUrl}/chat/completions`;
an Anthropic-compatible endpoint takes a different request shape and will reject every call.

For the key, either set `DEEPSEEK_API_KEY`, or — if the key already lives in another variable —
name that variable in your workspace's `.investigator/config.yaml` so it is not copied into a
second place:

```yaml
llm:
  apiKeyEnv: MY_EXISTING_VARIABLE
```

Then confirm:

```bash
$CLI doctor --workspace $WS
# Provider  deepseek  host=api.deepseek.com  key(DEEPSEEK_API_KEY)=configured  ai=configured
```

`ai=missing` names exactly which variables are unset. The real environment always wins over
`.env`, and `REPROAGENT_NO_ENV_FILE=1` ignores the file entirely.

### 8. Pointing it at a real site

The fixtures are local and disposable. A real target needs three deliberate decisions, and the
system will refuse until you make them.

In `$WS/.investigator/config.yaml`:

```yaml
execution:
  targets:
    my-target:
      baseUrl: https://staging.example.com
      classification: test # fixture | test | staging. There is deliberately no "production"
      resetStrategy: per-run-tenant
      correlationHeaderAllowed: false

safety:
  allowedOrigins:
    - https://staging.example.com # this origin and its subdomains; other sites are refused
```

Then run against it with `--target my-target` instead of `--fixture-app`.

Three things that will stop you, by design:

1. **There is no `production` classification.** Declaring a target `test` is you asserting it is
   an environment you are authorised to act on.
2. **Destructive actions.** A click whose label matches `delete`, `remove`, `deactivate` and
   similar is classified destructive automatically. `safety.blockDestructiveActions` decides what
   happens next, and it is **off by default**, because the product is deployed to in-house QA
   servers whose whole job is running such a flow repeatedly against disposable accounts. Turn it
   on for an environment where an unintended write would matter: it then requires a per-action
   justification in `safetyAcknowledgements`, and refuses outright on a `staging` target. It never
   affects the approval gates — a human authorises the batch either way.

   The flag governs **three** checkpoints: enqueue, the approval acknowledgement, and the executor
   itself. It governed only the first two for a while, so turning it off unblocked enqueue and
   then threw `EXEC_DESTRUCTIVE_BLOCKED` on the first delete anyway. A flag that governs some of
   its checkpoints governs none of them.

3. **Selectors.** An interpretation will not invent a `css` or `testid` selector. What it emits
   instead is a `described` selector carrying your words, and the executor RESOLVES that by role
   and accessible name — the same information a person reading the page acts on. "the delete
   button" becomes `getByRole("button", { name: /delete/i })`. If you have real selectors,
   `npx playwright codegen --device="Pixel 7" <your url>` and put them in the proposal; they are
   more precise and are used as written.

A first run against a real site commonly returns `AUTOMATION_FAILED` rather than a product
failure. That is the system working: rule 3 fires before rule 4, so a selector that did not match
is never miscounted as a defect in your application.

### 9. If something goes wrong

| Symptom                                        | Cause and fix                                                                                               |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `Build first: npm run build`                   | `npm run build`                                                                                             |
| Chromium fails to launch                       | `npx playwright install chromium chromium-headless-shell`                                                   |
| `GATE_REQUIRED`, exit 2                        | Working as intended. Approve gate 1 first                                                                   |
| `GATE_CHECKSUM_MISMATCH`                       | You re-ran `plan`. See the gotcha above                                                                     |
| `An approval file already exists`              | Delete it to scaffold afresh                                                                                |
| `Runs completed: 0 of N`                       | Those repetitions already ran. Repetitions are keyed by index; raise `--repeat` or approve a new experiment |
| `EXEC_VALUE_UNRESOLVED`                        | A selector or URL was never resolved from prose. Fix it in the proposal and re-approve                      |
| `AI_PROVIDER_UNAVAILABLE`                      | An `--ai` step with no configuration. It names the missing variables                                        |
| `EXEC_ORIGIN_NOT_ALLOWED`                      | Navigation left `safety.allowedOrigins`. Subdomains of a listed origin are allowed; other sites are not     |
| `No runs with normalized evidence`             | `analyze` before anything ran. Do step 7 first                                                              |
| Reliability suite fails on **wall clock only** | Machine contention. Run it on an otherwise idle machine                                                     |

## The chat UI

```bash
npm run build
npm run serve                                    # supervised, port 9999, restarts itself
```

Then open **http://127.0.0.1:9999/**. `npm run serve` supervises the server: if it exits, it comes
back on the same port, so a link you have open keeps working. It backs off on repeated failures
rather than spinning, logs to `.logs/web-<port>.log`, and takes `--port` and `--workspace`.

`npm run web` is the same server in the foreground, unsupervised, for when you want to watch it
die:

```bash
npm run web -- --workspace ./my-workspace --port 9999
```

A local page that walks the same pipeline as a conversation: describe the bug, see the flow it
inferred and where it thinks the break is, answer what it could not infer, approve a proposal,
watch the batch run, play the recording, and read the contrast.

The pipeline is shown against the loader rather than as a permanent strip across the top. A rail
you have already read is scenery; the moment you are waiting is exactly when "where am I, and what
is it doing?" is a real question. So while anything is in flight the page shows what it is doing
in words, which step is live, and how long it has been going — the last of those being the
difference between "it is thinking" and "it has hung", which a spinner alone cannot tell you. The recording is why this is a
browser page rather than a terminal UI — a video is the artefact the second gate asks you to
judge, and a terminal cannot show one.

**One column, one scroll.** Nothing on the page draws a scrollbar and nothing scrolls inside
anything else. Cards, the live run log, the composer and the step rail all sit on the same left
gutter and the same right edge, so the column reads as one line down the page; the page itself is
the only thing that scrolls, by wheel, trackpad, keys or touch. Two things followed from that: a
scrollbar gutter appearing as content grew used to shift the layout by its own width, and the run
log used to be a 260px box with a second scrollbar inside a card. The log is now a **tail** — the
last 200 lines, sized to its content. The full output is in the job record and the artifacts
either way, so what is dropped is what a tail drops, not evidence.

**It contains no part of the pipeline.** Every action spawns the same `investigate` command you
would type, with `--json`, and renders the answer. That is a safety property rather than a
shortcut: the approval gates, the redaction boundary and the API key all live inside that child
process, so a bug in the web layer cannot approve a gate the CLI would refuse, write an
unredacted byte, or read the key. `tests/e2e/web-actions.test.ts` asserts an unapproved batch is
still refused when driven from the UI.

Because it starts processes on your machine, it is treated as a privileged local surface:

| Control              | What it does                                                                       |
| -------------------- | ---------------------------------------------------------------------------------- |
| Loopback bind        | Listens on `127.0.0.1` only; never reachable from the network                      |
| Token                | Stored with the workspace, injected into the page, required on every call          |
| Origin check         | A request from another origin is refused                                           |
| Action allowlist     | The browser sends an action id and typed parameters, never a command line          |
| Parameter validators | Ids, gates, checksums and paths must match narrow patterns or the call is refused  |
| Path containment     | Workspace-relative paths are resolved and re-checked; anything escaping is refused |

The allowlist in `apps/web/src/actions.ts` is the boundary: without it, a page open in your
browser would be a shell. `apps/web/src/actions.spec.ts` covers what must not get through.

### The interview

The agent asks for what it could not infer, rather than reporting it and stopping. After the
report is interpreted, every entry in the flow's `unknowns` is put back to you as a question —
the URL it was not given, the selector it refused to invent, the account it will not fabricate.
Answers are folded into the **report** and the report is re-interpreted, not patched into the
flow: the report is the grounded source, and a flow edited behind the reporter's back is an
invention with their name on it. You can skip any question, and it stays recorded as an unknown.

It then asks where to run, because it cannot plan without a target: `get_application_constraints`
returns `NOT_FOUND` and the model correctly declines to propose experiments it cannot ground. The
page records the target into `config.yaml` for you, and the decisions the design insists a human
makes are asked, never defaulted:

- **Classification** — `fixture`, `test` or `staging`. There is deliberately no `production`, and
  the page refuses it by name with the reason, not a schema error.
- **Allowed origins** — the target's origin is added because every target origin must appear
  there; nothing else is.
- **Destructive actions.** `safety.blockDestructiveActions` now defaults to `false`, because this
  runs against in-house QA targets where a delete flow is the thing being investigated, not an
  accident. The page neither sets nor clears the flag — an absent key means "take the default" —
  and the three approval gates still apply. What is gone is being asked to re-justify each
  `delete` inside a proposal you have already read.

### Credentials the reporter supplies

Most intermittent bugs only happen while signed in, so "use this test account" is the normal case.
It used to be the one thing the agent could not accept: an answer typed into the interview was
folded into the report, and the report is a durable artifact, so the redaction policy masked the
phone number or email inside it — correctly. The operator supplied the data and the agent then
reported it as missing.

An answer that is a credential now takes a different road. The value goes to this session's
credential store (`<session>/.investigator/.credentials.json`); the **report records only the
name**. The flow references it as `{ "kind": "secretRef", "envVar": "ACCOUNT_PHONE" }` and the
value is resolved inside the executor at run time.

What that indirection buys, and why supplying a credential is safe rather than something to
refuse:

- **No model ever sees a value.** Only names are sent, as
  `constraints.declaredCredentialEnvVarNames`.
- **No value reaches an artifact.** Every stored value is registered with the redactor before a
  batch starts, so an OTP that surfaces in a DOM snapshot or a console line is masked by identity
  — exact, where a pattern could only guess. `packages/evidence/src/masked-values.spec.ts`.
- **No value reaches argv.** The page writes through the local server directly, never by spawning
  a command with the value on a command line where any process could read it.
- **`DEEPSEEK_API_KEY` does not live here and cannot.** That stays environment-only, read by
  `EnvSecretStore`, which is still its only reader.

The store is a local convenience for throwaway test accounts on the machine that is already
driving the browser those values are typed into. It is not a vault, and nothing that matters
belongs in it. `packages/storage/src/credential-store.spec.ts` covers it.

`config.yaml` is edited in place rather than rewritten, so comments, ordering and quoting survive
— including `video: "on"`, which is quoted because bare `on` is boolean `true` under YAML 1.1.
`apps/web/src/target.spec.ts` asserts all of that.

### Approving from the page

The page records the approval itself, in one click. That is not an auto-approval: you read the
proposal card, you pressed the button, and what is recorded is bound to the SHA-256 of the exact
bytes you read — the CLI recomputes it and refuses on any mismatch. There is no path in the
allowlist that approves without a checksum, and `apps/web/src/actions.spec.ts` asserts it.

What has gone is the round trip. The page previously scaffolded a file and told you to open the
workspace and type the word "approve" into a document the scaffold had already filled in, which
was friction rather than a decision.

**The checksum crosses the boundary in the CLI's own spelling**, `sha256:<64 hex>`, and is never
reformatted on the way. That sounds like a detail and was a total failure: the allowlist pattern
accepted only bare hex, so the page stripped the prefix to satisfy it, and `approve` — which
compares the flag against `checksumOfBytes`, a prefixed value — rejected every single approval
with `GATE_CHECKSUM_MISMATCH`. The refusal read as a tampered proposal when the two values were
the same hash spelled two ways. An artifact `sha` IS bare, because it is addressed that way on
disk; the two patterns are now separate and named for what they are.

The test that missed it is worth naming too. `tests/e2e/web-actions.test.ts` spawned the real
binary for every action but deliberately did not assert success, since most actions correctly fail
on a precondition — and it passed a dummy checksum, so the mismatch looked like one of those. It
now also runs plan → scaffold → approve with the checksum the CLI itself printed and requires exit 0. Verified against the running agent: gate 1 approved, `APPR-001`, two experiments bound to
`sha256:d3daa040…`.

### Sessions

Refreshing the page does not lose your place. The transcript and where you got to are held server
side against a session cookie, so a reload resumes the conversation. Restored messages are history
and their buttons are not live — a resume card offers the action that is actually next instead.

**Sessions run concurrently.** Open as many tabs as you like; each gets its own session, its own
folder and its own investigation numbering, and they do not interfere.

This used to be one session per client address, and the reason given was that "two tabs would
issue commands into the same workspace database and the same investigation, and each transcript
would be missing half of what happened". That was true while every session shared one workspace.
It stopped being true when each session got its own — so the guard was protecting against a
collision that can no longer happen, and since the server is loopback-only and every connection
resolves to one address, what it actually did was make a second tab wait up to a minute. It is
gone.

The page heartbeats while it is open and releases its session as it unloads. A session that stops
heartbeating expires after 60 seconds. Expiry still matters, for a different reason than before: a
request arriving without a live session is refused rather than written into the shared root
workspace. `apps/web/src/sessions.spec.ts` asserts both directions — a live session is never
disturbed by a newcomer, and an abandoned one always expires.

Users and sessions are written to the host's own disk, two files under `<workspace>/.web/`, so a
session survives restarting the server and not just refreshing the page. They sit outside
`.investigator/`, which is the schema-governed evidence tree — chat state is not evidence and must
not look like it to anything walking that directory. Writes are atomic, because a half-written
transcript read back at startup would be presented as a real one.

The API token lives beside them, for the same reason. Minting a fresh one per start meant every
supervised restart silently invalidated whatever page was open: the next action came back
`FORBIDDEN: bad or missing token`, in the middle of typing a report. Restarts are routine by
design here, so a token that cannot survive one is the wrong default. The trade, stated plainly:
the token rests on disk rather than only in memory, inside a gitignored workspace, guarding a
loopback-only service on the operator's own machine — anyone who can read that file can already
run the CLI directly. Delete `<workspace>/.web/token` to rotate it.

If a page does end up holding a stale token it says so and puts the unsent message back in the
box, rather than showing a raw `FORBIDDEN` where an answer should be.

Commands that are registered but unimplemented (M4–M8) are exposed on purpose — the UI shows
the typed `NOT_IMPLEMENTED` answer and the milestone that brings each one, rather than hiding a
step and implying the pipeline is shorter than it is.

## How it works

### The one rule everything follows

Four kinds of work, kept strictly apart, because mixing them is how an investigation tool starts
lying:

| Who                    | Does                                      | Never does                                        |
| ---------------------- | ----------------------------------------- | ------------------------------------------------- |
| **Playwright**         | Drives a browser, produces raw evidence   | Decides what the evidence means                   |
| **Deterministic code** | Normalizes, redacts, measures, classifies | Guesses, or asks a model                          |
| **DeepSeek**           | Interprets, ranks, hypothesises, explains | Touches a browser, or decides an outcome          |
| **A human**            | Authorizes every consequential transition | Gets bypassed by a `--yes` flag — there isn't one |

The import graph enforces the second and third rows rather than trusting them.
`packages/execution`, `packages/evidence` and `packages/test-fixtures` **cannot** import
`ai-gateway` or `ai-flows`; `tests/docs/import-boundary.spec.ts` walks the resolved module graph
and fails if they ever do.

### Layering

```
core ← storage ← execution ← evidence ← lineage ← ai-gateway ← tools ← ai-flows ← reporting
                     ↑                                                       |
                     └───────────────────── approvals ───────────────────────┘

apps/cli depends on everything. Nothing depends on apps/cli.
```

| Package         | Responsibility                                                                   |
| --------------- | -------------------------------------------------------------------------------- |
| `core`          | Vocabulary, ids, config, errors, schema registry, `Secret`, clock and seeded RNG |
| `storage`       | SQLite metadata store, durable job queue, content-hashed artifact store          |
| `execution`     | The Playwright worker, action interpreter, collector, destructive classifier     |
| `evidence`      | Redaction, the normalization plane, capture status, the outcome rules            |
| `lineage`       | The append-only, hash-chained provenance graph                                   |
| `approvals`     | Gate state, the edit surface, checksum binding, the nine approval checks         |
| `ai-gateway`    | Provider adapter, retry and circuit breaker, budgets, cost ledger, validation    |
| `tools`         | Read-only projections over normalized evidence, and `contrastRuns`               |
| `ai-flows`      | Flow loading, `flowHash`, the turn loop with double allowlist enforcement        |
| `test-fixtures` | Deterministic local applications that fail in specified ways                     |
| `reporting`     | M7. A placeholder today                                                          |

### Determinism

Reproducibility is the whole product, so it is a constraint on the code, not an aspiration:

- No `Math.random()`, `Date.now()` or ambient locale/timezone in execution or normalization. A
  seeded `Rng` and an injected `Clock` are passed in.
- Normalization is a **pure function** of `(raw artifacts, redaction policy version, normalizer
version)`. The same inputs produce byte-identical output, and a session can be rebuilt offline
  from stored artifacts with the network and browser unavailable — asserted by
  `tests/reliability/offline_session_reconstruction.spec.ts`.
- Every artifact is SHA-256 content-hashed at write time. Manifests are immutable once sealed;
  SQLite triggers reject any update or delete.
- One browser per batch, a **fresh `BrowserContext` per run** (ADR-0025). Runs cannot leak state
  into each other.

### Evidence, and being honest about it

Twelve categories are captured: `actions`, `navigation`, `console`, `exceptions`,
`networkMetadata`, `responseBodies`, `domSnapshots`, `storage`, `screenshots`, `video`, `trace`,
`webSocketFrames`.

Each carries a status, every run, for every category — there are no absent keys, because an
omitted key is indistinguishable from a forgotten one:

`complete` · `partial` · `missing` · `redacted` · `unsupported` · `corrupted` · `disabled`

This matters more than it sounds. **An absent signal in a `missing` category means "not
captured", never "did not happen"**, and a finding that leans on it is capped accordingly. The
human-readable limitations are generated from the machine-readable reasons, so the prose and the
data cannot drift apart.

Redaction happens **before persistence**, and fails closed: a store call arriving without a
`RedactionStamp` raises `REDACTION_NOT_APPLIED`. There is no code path that writes evidence
without one.

The one deliberate exception is **video**, which is raw pixels no text rule can mask. It is
written only when explicitly enabled, and stamped `video-raw-unredactable` rather than inheriting
a stamp implying the bytes were cleaned.

### How a run is classified

Six ordered rules. The order is the design:

| #   | Outcome                 | When                                                                  |
| --- | ----------------------- | --------------------------------------------------------------------- |
| 1   | `INTERRUPTED`           | The run was cut short. Nothing else about it is trustworthy           |
| 2   | `INFRASTRUCTURE_FAILED` | The harness or environment failed — not the product                   |
| 3   | `AUTOMATION_FAILED`     | Our instructions were wrong: a selector missed, an origin was refused |
| 4   | `PRODUCT_FAILED`        | A declared assertion failed, or a failure predicate matched           |
| 5   | `VALID_COMPLETED`       | Everything declared passed **and** required evidence is usable        |
| 6   | `INCONCLUSIVE`          | Green, but a required evidence category is missing                    |

**Rule 3 precedes rule 4** so a broken script is never reported as a product defect — the single
most damaging mistake this tool could make. **Rule 6 follows rule 5** so a green run with missing
evidence is not counted as proof of correctness.

Queue state and run outcome are separate dimensions (ADR-0005) and are never conflated:
`JobState` (`PENDING`/`CLAIMED`/`RUNNING`/`TERMINAL`), `JobTerminalReason`
(`COMPLETED`/`INTERRUPTED`/`WORKER_ERROR`), and `RunOutcome` above. The legal combinations are
enforced by SQLite CHECK constraints, so an illegal pair cannot be written even by buggy code.

**Retries cannot hide a product failure.** Only `INFRASTRUCTURE_FAILED` and `INTERRUPTED` are
retryable. `AUTOMATION_FAILED` is deliberately not: it means the approved sequence is wrong, which
is a human decision, not something to paper over with another attempt.

### Approvals

Three gates: `experiment_selection`, `target_failure`, `final_reproduction`. All file-based, all
SHA-256-bound to the exact proposal bytes a human read.

- Scaffolding approves nothing. It writes a schema-valid file with an empty decision.
- Editing is allowed, but only inside that gate's **edit surface**. The result is the _effective_
  proposal, and **execution consumes the effective proposal**, never the one merely proposed.
- Removing an item from `approvedItemIds` rejects it by omission.
- A destructive action requires a per-action acknowledgement with a written justification.
- There is no `--yes`, no `--force-approve`, no `--auto`. A test asserts their absence, and
  another walks the source to assert only the `approve` command can create an approval record.

### Lineage

Every consequential step appends an edge to a per-investigation, append-only, hash-chained graph.
Each record hashes its own content together with its predecessor's hash, so rewriting history
means rewriting everything after it.

It answers, offline: _what authorised this run?_ — and for an AI-produced node, which flow,
version and `flowHash` produced it. `verifyChain` distinguishes a sequence gap from a broken link
from an in-place edit, because those are different failures.

It is tamper-**evident**, not tamper-proof. That is the honest guarantee for a local tool.

### Where the AI boundary actually sits

The most important line in the system: **`analyze` computes its contrast, then asks a model what
it means.**

`contrastRuns` is a pure function over measurements the extractor already produced — which console
fingerprints appear only in failing runs, which request orderings separate the groups, how timings
differ. It decides nothing, and it runs whether or not a provider is reachable.

So the question an intermittent bug turns on is answered by arithmetic. The model reads that
answer and proposes what it means, and then:

- Output is parsed, schema-validated with unknown fields **rejected**, then reference-validated.
- A citation to a run the tools never returned is a fabrication — the output is refused, not
  repaired into plausibility.
- A claim at `probable_trigger` or above needs a citation carrying a **field and an expected
  value**, because "see RUN-17" establishes only that RUN-17 exists.
- `confirmed_root_cause` is unreachable by design: it requires approved direct evidence from
  inside the application, which a client-boundary tool cannot have.

Claims use a level ladder, and the level is a promise about the evidence behind it:

`observed` → `correlated` → `probable_trigger` → `high_confidence_trigger` → `confirmed_trigger` →
`root_cause_hypothesis` → `confirmed_root_cause`

An interpretation must also be able to say _"the reporter never told me this."_ A selector may use
the `described` strategy to carry the reporter's own words, and a `goto` may have a null URL paired
with the `unknownRef` naming the gap. Without this, a flow had to invent a selector or a URL just
to be schema-valid.

The two are **not** treated alike, and that distinction was got wrong once and corrected:

- A **null URL** is still unexecutable. There is no reading of "no URL" that names a page, and
  defaulting to the target root would run something nobody chose. `EXEC_VALUE_UNRESOLVED`.
- A **described selector** is now resolved, by role and accessible name. It was unexecutable by
  design, on the reasoning that treating a phrase as a selector would sometimes work and that was
  the danger. The reasoning was wrong about where the risk sits: what made the refusal feel safe
  was not that it avoided a wrong click but that it avoided all clicks, and an investigator that
  stops at every control it was not handed a CSS selector for cannot investigate anything a
  reporter described in words — which is every real bug report. What is kept is the part that
  mattered: an unmatched phrase fails as `AUTOMATION_FAILED` under rule 3, never as a product
  defect, and the suite generator emits the same locator the run used rather than refusing.

## Tech stack, and why

| Choice                        | Why                                                                                | ADR        |
| ----------------------------- | ---------------------------------------------------------------------------------- | ---------- |
| TypeScript, npm workspaces    | One toolchain; workspaces after pnpm/Turborepo proved unnecessary overhead         | 0019, 0023 |
| **Playwright** (Chromium)     | The only thing that touches a browser                                              | 0001       |
| **`node:sqlite`** WAL         | No native module, no node-gyp, no prebuild matrix, no Windows install pain         | 0021, 0002 |
| Content-hashed artifact store | Integrity is verifiable rather than assumed                                        | 0004       |
| **Ajv** strict, 28 schemas    | Every persisted and AI-produced document is validated at its boundary              | 0015       |
| **Vitest**, four projects     | `unit`, `docs`, `e2e`, `reliability` — one runner, separated by cost               | 0024       |
| **DeepSeek** via an adapter   | Provider shapes never leak past `ai-gateway`; capabilities are probed, not assumed | 0009       |
| Flows as filesystem artifacts | Prompts are versioned files hashed into every call, never string literals          | 0010       |

No database server, no message broker, no container, no cloud dependency. A workspace is a
directory; the queue is a SQLite table.

## Vocabulary

The words below appear in output and in every document here. They are not interchangeable, and
most of the design exists to keep them apart.

| Term                   | Means                                                                                                 |
| ---------------------- | ----------------------------------------------------------------------------------------------------- |
| **Investigation**      | One reported issue, start to finish. `INV-001`. Owns everything below it                              |
| **Flow**               | The structured reading of a human's report: steps, actions, and what the report did not say           |
| **Experiment**         | One hypothesis made executable: an ordered action list, assertions, and a repetition count. `EXP-001` |
| **Repetition**         | One requested execution of an experiment. Keyed by index, so re-requesting it does not re-execute it  |
| **Run**                | One actual browser execution. `RUN-001`. A repetition may have several if infrastructure failed       |
| **Job**                | The queue row that schedules a repetition. Has a `JobState`, separate from the run's outcome          |
| **Proposal**           | The document a human decides on at a gate. Canonical bytes, SHA-256 checksummed                       |
| **Effective proposal** | The proposal plus the human's edits. **This is what executes**                                        |
| **Gate**               | A point where a human must decide. Three of them, all file-based and checksum-bound                   |
| **Artifact**           | Any durable byte: evidence, manifest, proposal, approval. Content-hashed, immutable                   |
| **Manifest**           | The per-run record: inputs, outcome, rule id, capture status, artifact digests. Sealed and immutable  |
| **Lineage**            | The append-only hash-chained graph of what produced or authorised what                                |
| **Finding**            | A claim about the evidence, carrying a level and validated citations                                  |
| **Falsifier**          | What would disprove a hypothesis. Every proposed experiment must state one                            |

### The enums you will see in output

| Set                   | Values                                                                                                                                              |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RunOutcome`          | `VALID_COMPLETED` · `PRODUCT_FAILED` · `AUTOMATION_FAILED` · `INFRASTRUCTURE_FAILED` · `INTERRUPTED` · `INCONCLUSIVE`                               |
| `JobState`            | `PENDING` · `CLAIMED` · `RUNNING` · `TERMINAL`                                                                                                      |
| `JobTerminalReason`   | `COMPLETED` · `INTERRUPTED` · `WORKER_ERROR`                                                                                                        |
| Capture status        | `complete` · `partial` · `missing` · `redacted` · `unsupported` · `corrupted` · `disabled`                                                          |
| Gates                 | `experiment_selection` · `target_failure` · `final_reproduction`                                                                                    |
| Target classification | `fixture` · `test` · `staging` — there is deliberately **no `production`**                                                                          |
| Finding level         | `observed` · `correlated` · `probable_trigger` · `high_confidence_trigger` · `confirmed_trigger` · `root_cause_hypothesis` · `confirmed_root_cause` |
| Side-effect class     | `read` · `local-write` · `remote-write` · `destructive`                                                                                             |

## Command reference

Every command in the frozen contract is registered. The ones not yet implemented exit 1 naming
their milestone rather than silently doing nothing.

| Command                   | Does                                                                       | AI?    |
| ------------------------- | -------------------------------------------------------------------------- | ------ |
| `init`                    | Create a workspace: database, `config.yaml`, redaction policy, directories | no     |
| `intake`                  | Open an investigation from a report file                                   | `--ai` |
| `plan`                    | Render the gate-1 proposal a human decides on                              | `--ai` |
| `approve <gate>`          | Record a checksum-bound human approval. `--scaffold` writes a blank one    | no     |
| `run`                     | Execute approved experiments. Makes **no** provider calls, ever            | no     |
| `analyze`                 | Report what separates failing runs from passing ones                       | `--ai` |
| `suite generate`          | Emit a standalone Playwright spec for approved experiments                 | no     |
| `status`                  | Gate states, run outcomes, queue and lineage health                        | no     |
| `show <what>`             | Print a rendered proposal, or an artifact's contents                       | no     |
| `lineage <nodeId>`        | Ancestors and descendants of a node, with the actor on every hop           | no     |
| `doctor`                  | Workspace, config, queue, integrity and safety state. `--verify-lineage`   | no     |
| `retention apply`         | Tombstone artifacts past their retention age. Dry run without `--confirm`  | no     |
| `classify`                | Cluster runs, render gate 2                                                | **M4** |
| `frequency run`           | Execute N times and compute failure-rate statistics                        | **M5** |
| `minimize` / `revalidate` | Reduce a reproduction; re-execute it and its control                       | **M6** |
| `report` / `export`       | Jira-ready report; package reproducer and artifacts                        | **M7** |

Global flags: `--workspace <dir>`, `--investigation <id>`, `--json`, `--verbose`, `--seed <int>`,
`--no-color`, `--allow-unsafe-debug`.

`--json` puts machine-readable output on stdout and human text on stderr, so it composes.

There is deliberately no `--yes`, `--force-approve`, or `--auto`.

## Repository layout

```
apps/cli/               The `investigate` binary. Parses, dispatches, formats. No business logic
apps/web/               Local chat UI. Spawns the CLI; imports no workspace package
packages/               One package per responsibility — see the layering table above
ai/flows/<flow-id>/     Versioned prompt artifacts: flow.yaml, system.md, examples.jsonl
schemas/                28 versioned JSON schemas. The wire contract for every document
eval/                   Replay datasets and the deterministic scorer that gates model behaviour
tests/
  docs/                 Governing principle, schemas, import boundaries, flow examples
  e2e/                  The CLI, against the built binary
  reliability/          Browser-backed behavioural gates, including the 100-run gate
docs/
  adrs/                 26 architecture decision records
  architecture/         Component, evidence, queue, approval, evidence-reference models
  milestones/           Authoritative scope per milestone
  security/             Security model and redaction policy
  operations/           Runbook and Windows runner provisioning
  prompt-a.txt          The frozen originating brief, with a SHA-256 checksum
scripts/                demo.mjs, reproduce.mjs, verify.ps1, and build tooling
policies/default.yaml   The default redaction policy
```

## Workspace layout

A workspace is a plain directory. There is no server, and nothing lives outside it.

```
<workspace>/.investigator/
  config.yaml                        Everything configurable. Created by `init`
  investigator.db                    SQLite (WAL): investigations, jobs, runs, lineage, approvals,
                                     artifact refs, AI call ledger
  policies/default.yaml              The redaction policy, seeded on init
  prompts/                           Operator prompt overrides
  investigations/INV-001/
    manifests/                       Rendered proposals (.json, .json.sha256, .md) and run manifests
    approvals/                       The approval files a human edits and signs
    artifacts/<kind>/<shard>/        Content-addressed evidence, sharded by hash prefix
    normalized/                      Normalized evidence
    reports/                         M7 output
    reproducer/                      M6/M7 output
```

Artifacts are addressed by SHA-256 and sharded two characters deep, so identical bytes are stored
once and every reference is verifiable.

### One folder per chat session

A session driven from the page does not write into the root workspace above. It gets its own
folder, and that folder **is** a workspace:

```
<workspace>/sessions/2026-09-12T17-06-07Z-586218/
  .investigator/
    config.yaml                      Copied from the parent on creation, so targets carry over
    investigator.db                  This session's investigations, jobs, runs, lineage
    .credentials.json                Test-account values the operator supplied, this session only
    investigations/INV-001/          Manifests, approvals, artifacts, normalized evidence, video
  reports/report.md                  The operator's own words, as the CLI reads them
  reports/versions/<stamp>-<name>    Every version they submitted, kept
  session.jsonl                      What happened, appended as it happened
```

Every `investigate` command the page runs is given `--workspace <that folder>`, so the output
lands there because the CLI was told to put it there — nothing is moved or copied afterwards,
which is what makes "everything this session produced is in one folder" true rather than
maintained. The folder name leads with the timestamp, so `sessions/` sorts chronologically.

Two consequences, stated because they are trade-offs and not free:

- **Sessions do not share a database.** `investigate status` inside one session cannot see
  another's investigations. The folder, not the database, is now the unit you keep or delete.
- **Deleting a session folder deletes its evidence.** There is no second copy.

A request arriving without a live session is **refused**, not redirected to the root. An earlier
version fell back, and a report written after a 60-second idle gap silently landed in the shared
root along with the investigation it opened. Nothing failed and nothing said so. Refusal is the
honest answer: the page re-acquires a session and resends.

## Configuration reference

`config.yaml` has six blocks. Anything may use `env:NAME` to read from the environment; an unset
variable is an error naming the variable, never a silent default.

| Block       | Controls                                                                                                                                                                                             |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `llm`       | Provider, base URL, **`apiKeyEnv`** (a variable NAME, never a value), the three model aliases, capability cache TTL, and per-investigation cost and per-call token budgets                           |
| `storage`   | Metadata/artifact/queue backends, and which redaction policy file to use                                                                                                                             |
| `execution` | Browser and channel, worker and parallelism limits, timeouts and leases, the deterministic `seed`, infra retry ceiling, `video`, `trace`, the `capture` block, emulation profiles, and **`targets`** |
| `approvals` | Which gates are required, the approval directory, and expiry                                                                                                                                         |
| `safety`    | **`allowedOrigins`**, `productionGuard`, `blockDestructiveActions` (off by default), `destructivePatterns`, `maxRepetitionsPerRun` (100), and per-investigation run and wall-clock ceilings          |
| `logging`   | Level                                                                                                                                                                                                |

The three you will actually edit:

```yaml
execution:
  video: "on" # quote it — bare `on` is boolean true in YAML
  targets:
    my-target:
      baseUrl: https://staging.example.com
      classification: test
      resetStrategy: per-run-tenant
      correlationHeaderAllowed: false

safety:
  allowedOrigins:
    - https://staging.example.com
  blockDestructiveActions: true # opt IN to the per-action justification; off by default
  maxRepetitionsPerRun: 100 # most a single run request may enqueue
  maxRunsPerInvestigation: 10000 # total across every batch in one investigation

llm:
  apiKeyEnv: MY_EXISTING_VARIABLE # name the variable; never paste the key
```

Emulation profiles ship built in, including `desktop-chrome-1440`, `pixel-7-chrome-mobile` (a
concrete pinned Android user agent, not a small viewport) and `low-end-android-throttled`. Set one
per experiment with `emulationProfile`.

## Extending it

**Add an AI flow.** Create `ai/flows/<id>/` with `flow.yaml`, `system.md` and `examples.jsonl`.
Register the id and any new tool names in `schemas/flow-artifact.v1.json` — both are closed enums,
so an unregistered flow fails to load rather than running unnoticed. Give it an output schema in
`schemas/`. `tests/docs/flow-examples.spec.ts` will then assert your examples actually satisfy
that schema, which is the failure mode to expect.

**Add a tool.** Implement it in `packages/tools/src/` taking a _reader function_, never a store —
that is what keeps the package unable to reach a browser or a provider, and what lets the contract
test run every tool with the network stubbed to throw. Supply the reader in
`apps/cli/src/tool-registry.ts`. It must satisfy the eight contract invariants in
`packages/tools/src/tools.spec.ts`.

**Add a fixture.** Add the application to `packages/test-fixtures/src/fixture-server.ts` and the
experiment to `experiments/`. Keep it **seeded, never random**: a fixture that fails randomly
cannot be used to test a system whose purpose is reproducibility.

**Add a schema.** Drop it in `schemas/`. It is auto-registered by filename and must compile under
Ajv strict (`strictTypes`, `strictRequired`) — `tests/docs` fails otherwise. Add any new vocabulary
to `packages/core/src/types.ts` as well; a test asserts the code enums and the JSON schemas agree
bidirectionally, so neither can drift.

**Add an error code.** Add it to `ERROR_CODES` and `SPEC` in `packages/core/src/errors.ts`, and
document it in `docs/architecture/error-taxonomy.md`. A test asserts the two agree.

## The AI path in practice

Three versioned flows live under `ai/flows/`, each a directory — `flow.yaml`, `system.md`,
`examples.jsonl` — hashed together into a `flowHash` recorded on every call, so the exact prompt
bytes behind any output are recoverable later.

| Command        | Flow                  | What it produces                                                     |
| -------------- | --------------------- | -------------------------------------------------------------------- |
| `intake --ai`  | `intake_to_flow`      | Steps, unknowns, and the point in the flow the **report** implicates |
| `plan --ai`    | `propose_experiments` | Ranked experiments, each with what would disprove it                 |
| `analyze --ai` | `analyze_failures`    | Findings with checked citations, and reproduction steps              |

Each has a six-dimension budget — turns, tool calls, tokens, cost, wall clock, repairs — checked
**before** dispatch, so a ceiling is never discovered by exceeding it. Budget exhaustion returns a
typed partial or inconclusive result, never a silently truncated answer.

### What is verified, and what is not

`intake --ai` has run against live DeepSeek end to end, in both directions.

Given a report naming no URL and no selector, it named the failure point with a supporting quote,
emitted `url: null` with an `unknownRef`, used a `described` selector, and recorded four unknowns
— refusing to invent any of it.

Given a report that DID name things, it used every one of them. From "I sign in at
`https://www.99acres.com/login` by typing my phone number into the phone field and pressing
Continue, then go to `/profile/editProfile` and click Delete Account", against a workspace whose
target is `https://www.99acres.com` with `ACCOUNT_PHONE` declared, it produced:

| The reporter said                      | The flow emitted                                             |
| -------------------------------------- | ------------------------------------------------------------ |
| a full URL on the target               | `goto /login`, `goto /profile/editProfile` — target-relative |
| "my phone number"                      | `{ "kind": "secretRef", "envVar": "ACCOUNT_PHONE" }`         |
| "pressing Continue"                    | `{ "strategy": "text", "value": "Continue" }` — executable   |
| "click Delete Account"                 | `{ "strategy": "text", "value": "Delete Account" }`          |
| "the phone field"                      | `described` + an unknown — a description, not a label        |
| nothing about the confirmation wording | a `screenshot`, not an invented `textEquals`                 |

The last two rows are the point as much as the first four. A control the reporter **quoted the
label of** is data they supplied, and turning it into a non-executable `described` threw it away.
A control they merely **described** is still a gap, and guessing there produces a click that lands
somewhere they never pointed — reported afterwards as a defect in the product.

`plan --ai` and `analyze --ai` have **not** been run against a live provider. They share the same
runner, examples and validation, but that is inference rather than evidence, and their token
budgets may need the same raise `intake_to_flow` required once few-shot examples were included.

The replay eval harness (`eval/`) runs from recorded outputs and needs no credential, which is the
only way a gate on model behaviour can honestly block CI.

## What the fixtures demonstrate

| File in `packages/test-fixtures/experiments/` | Outcome                                                             |
| --------------------------------------------- | ------------------------------------------------------------------- |
| `passing.json`                                | `VALID_COMPLETED` (rule 5)                                          |
| `product-failing-deterministic.json`          | `PRODUCT_FAILED` (rule 4) on every repetition                       |
| `product-failing-intermittent.json`           | `PRODUCT_FAILED`, pinned to a failing seed                          |
| `automation-failing.json`                     | `AUTOMATION_FAILED` (rule 3), never misreported as a product defect |

The intermittent fixture is **seeded, not random**. Whether a run fails is a pure function of the
seed, so the same seed produces the same verdict on any machine — which is what makes an
intermittent issue reproducible instead of merely frequent. Failing seeds below 40 are 7, 8, 9,
19, 23, 35 and 39.

## Verify

```bash
npm run build && npm run lint && npm run format:check && npm run typecheck
npm run test:docs        # governing principle, schemas, import boundaries, flow examples
npm test                 # unit
npm run test:e2e         # the CLI, against the built binary
npm run test:reliability # browser-backed behavioural gates
npm run gate:twice       # the M1 reliability gate, twice sequentially (~13 min)
```

On Windows, one command runs the same sequence:

```powershell
pwsh -File scripts/verify.ps1 -Gate
```

Current counts: **382** unit and docs tests, **64** e2e, **48** reliability. The 100-run gate
completes 100/100 `VALID_COMPLETED` with zero retries and zero infrastructure failures in roughly
130 seconds.

Run the reliability project on an otherwise idle machine. It asserts a wall-clock budget, and
running other suites alongside it fails that assertion on contention rather than on correctness.

No CI pipeline is configured in this repository. `.gitlab-ci.yml` and the non-authoritative
`.github/workflows/gate.yml` mirror have been removed; every number above was produced locally via
`scripts/verify.ps1` and the `npm run` scripts it wraps. `docs/operations/windows-runner.md`
documents the Windows-runner setup that pipeline once required, kept as reference should a CI
pipeline be reintroduced.

CI/CD is also disabled at the GitLab project level (`builds_access_level: disabled`, with Auto
DevOps off), so restoring a `.gitlab-ci.yml` alone will not make pipelines run — that project
setting has to be turned back on as well. Pipeline history from before the retirement is retained
server-side and is not visible while CI/CD is disabled; deleting it requires project Owner rights.

## Key guarantees, and where to check them

| Guarantee                                                                         | Enforced by                                                                                                                                                              |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| DeepSeek is never reachable from execution, evidence, or fixtures                 | `tests/docs/import-boundary.spec.ts` walks the resolved module graph                                                                                                     |
| Nothing reaches a browser without a recorded human decision                       | `tests/e2e/m2-gates.test.ts`; `run` exits 2 and enqueues zero jobs                                                                                                       |
| The chat UI cannot bypass a gate or run an arbitrary command                      | `tests/e2e/web-actions.test.ts` drives every action against the built binary; `apps/web/src/actions.spec.ts` covers the allowlist                                        |
| Sensitive evidence is redacted before it is persisted                             | `tests/reliability/redaction_before_persistence.spec.ts`; a store call without a `RedactionStamp` raises `REDACTION_NOT_APPLIED`                                         |
| Normalization is a pure function; a session rebuilds byte-identically offline     | `tests/reliability/offline_session_reconstruction.spec.ts`, with network and browser unavailable                                                                         |
| A product failure is never hidden by a retry                                      | `tests/reliability/no_retry_hides_product_failure.spec.ts`                                                                                                               |
| A broken script is never reported as a product defect                             | Rule 3 before rule 4 in `packages/evidence/src/outcome.ts`; `tests/e2e/described-selector.test.ts`                                                                       |
| Queue state and run outcome are separate concepts                                 | `JobState` / `JobTerminalReason` / `RunOutcome` in `packages/core/src/types.ts`, plus SQLite CHECK constraints                                                           |
| The 100-run fixture completes with zero retries and zero infrastructure failures  | `tests/reliability/same_test_100_runs.spec.ts`                                                                                                                           |
| Every artifact is content-hashed and verifiable                                   | `tests/reliability/artifact_integrity_hashes.spec.ts`                                                                                                                    |
| Mobile runs are Chromium **emulation**, recorded as read back from the browser    | `tests/reliability/mobile_emulation.spec.ts`                                                                                                                             |
| The API key never reaches a log, artifact, or error                               | `packages/core/src/secret.spec.ts`, plus a canary assertion in the CLI e2e suite                                                                                         |
| An AI finding cannot cite evidence it was never shown                             | `apps/cli/src/commands/analyze.ts` validates every reference against only the runs the tools returned                                                                    |
| What differs between failing and passing runs is computed, not inferred           | `contrastRuns` is pure; `packages/tools/src/analysis-tools.spec.ts` covers what it refuses to claim as well as what it finds                                             |
| A persisted video is never presented as redacted                                  | stamped `video-raw-unredactable`; `packages/evidence/src/capture-status.spec.ts` asserts the wording a reader actually sees                                              |
| A URL the reporter never gave is never defaulted to the target root               | `EXEC_VALUE_UNRESOLVED`, at both execution and export; a described SELECTOR is resolved by role and name instead — `packages/execution/src/described-resolution.spec.ts` |
| Relaxing the origin allowlist to subdomains did not open it to other sites        | `packages/execution/src/described-resolution.spec.ts` covers suffix-smuggling, protocol downgrade and port changes                                                       |
| Each investigation keeps its own provenance chain                                 | `packages/lineage/src/lineage.spec.ts`; the lineage primary key is scoped per investigation                                                                              |
| A flow's few-shot examples satisfy the schema its output is validated against     | `tests/docs/flow-examples.spec.ts`, over every shipped flow                                                                                                              |
| A supplied credential is usable but never lands in a prompt, an artifact, or argv | `packages/storage/src/credential-store.spec.ts`; `packages/evidence/src/masked-values.spec.ts` masks registered values in every scope                                    |
| The shape outline a model is shown describes the schema it is judged against      | `packages/ai-flows/src/shape.spec.ts` asserts the actual generated outline, including `oneOf` variants and closed enums                                                  |
| A closed vocabulary the CLI sends matches the enum the validator enforces         | `tests/docs/vocabulary-drift.spec.ts` compares `ACTION_TYPES` and `ASSERTION_KINDS` against the schemas                                                                  |
| A session writes only inside its own folder, or the request is refused            | `apps/web/src/session-workspace.spec.ts`; a lapsed session returns `SESSION_EXPIRED` rather than falling back to the root                                                |

## Exit codes

Scriptable, and distinct on purpose — a refusal is not a crash.

| Code | Meaning                | Code | Meaning              |
| ---- | ---------------------- | ---- | -------------------- |
| 0    | OK                     | 6    | Provider unavailable |
| 1    | Usage                  | 7    | Execution failed     |
| 2    | Gate required          | 8    | Evidence incomplete  |
| 3    | Gate checksum mismatch | 9    | Integrity failed     |
| 4    | AI output invalid      | 10   | Inconclusive         |
| 5    | Budget exceeded        |      |                      |

A run that observes a product defect exits **0**. Finding the bug is the job.

## Scope boundary

Chrome desktop and Chrome mobile-**emulated** web, reproducible at least occasionally, observable
from the browser and client boundary, in authorized test environments.

ReproAgent does not claim to reproduce real-device Android Chrome behaviour, and does not claim to
capture all browser-visible data. What it captures is "the configured, technically accessible,
authorized, and successfully collected client-observable evidence" — and where a category is
missing, partial, redacted, unsupported or corrupted, it says so explicitly rather than implying
completeness.

Not a generic test generator. Not a log viewer. Not a session recorder. Not a replacement for QA,
developers, or observability tooling.

## Documentation

| Path                                | Contents                                                                                                                                 |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `DEMO.md`                           | Running the demo for an audience: what each chapter proves, and the questions people ask                                                 |
| `docs/prompt-a.txt`                 | The frozen originating brief, byte-for-byte, with a SHA-256 checksum                                                                     |
| `docs/m0-decisions.md`              | Human decisions, adapter choices, and what supersedes the brief                                                                          |
| `docs/FREEZE-M0.md`                 | M0 sign-off and the amendment log                                                                                                        |
| `docs/adrs/`                        | 26 architecture decision records                                                                                                         |
| `docs/architecture/`                | Component, evidence, queue, approval and evidence-reference models                                                                       |
| `docs/milestones/`                  | Authoritative scope per milestone                                                                                                        |
| `docs/security/`                    | The security model and the redaction policy                                                                                              |
| `docs/operations/runbook.md`        | Operating, troubleshooting and incident procedures                                                                                       |
| `docs/operations/windows-runner.md` | Provisioning a Windows GitLab runner (reference only; no pipeline is currently configured)                                               |
| `ai/flows/`                         | Versioned prompt artifacts, hashed into every AI call's `flowHash`                                                                       |
| `eval/`                             | Replay datasets and the scorer that gates model behaviour in CI                                                                          |
| `schemas/`                          | 28 versioned JSON schemas                                                                                                                |
| `CLAUDE.md`                         | Repo-wide rules for AI coding agents. **Not committed** — `.gitignore` excludes it by project convention, so a clone will not contain it |

## Security posture

The API key is read from the **environment only**, through a name allowlist, and is wrapped in a
`Secret` that refuses to serialise itself. It is never logged, persisted, written to an artifact,
included in an error message, or echoed by any command. `doctor` reports the variable **name** and
whether it is set, never its value. `llm.apiKeyEnv` in `config.yaml` chooses which variable holds
it, so an existing credential can be named rather than copied.

A gitignored `.env` may supply the non-secret settings. It never overrides a variable already set
in the real environment, so a stale file cannot shadow a deliberate export — the one dotenv
failure mode that would matter here, because the shadowed value would be a credential.

Raw sensitive evidence exists only in bounded process memory during collection and transformation.
It is redacted before durable persistence, provider transmission, normalized indexing, diagnostic
logging, report generation, and any export. The agent disables its own crash-dump and
heap-snapshot paths. OS-level paging is documented as residual risk in
`docs/security/security-model.md`.

Approvals are file-based and SHA-256-bound to the exact proposal bytes. There is no `--yes`, no
`--force-approve`, and no `--auto` flag — a test asserts their absence.

The chat UI (`apps/web`) is a privileged local surface, because it starts processes. It binds
loopback only, requires a token on every API call, refuses cross-origin requests, and accepts an
action id with typed parameters rather than a command line. The token is persisted under
`<workspace>/.web/`, not minted per start: supervised restarts are routine here, and a token that
could not survive one invalidated whatever page was open mid-report. It never reads the API key —
the CLI child process reads it from its own environment, exactly as it does at a terminal. Bug
reports it writes go under the workspace, which is gitignored, because a report routinely carries
test-account credentials.

Those credentials now have a channel of their own rather than living in the report prose. A value
the operator supplies is written by the server straight into the session's credential store, never
onto a command line where any process on the machine could read it. Only the **name** is sent to a
model, only the name is written to the session log, and every stored value is registered with the
redactor before a batch starts so it is masked out of artifacts by identity. The store holds
throwaway test accounts on the machine already driving the browser those values are typed into; it
is not a vault, and `DEEPSEEK_API_KEY` neither lives there nor can.

**One artifact is deliberately not redacted: video.** A recording is raw pixels, and no text rule
can mask a credential that was visible on screen. It is written only when `execution.video` is
explicitly set to `on`, and is stamped `video-raw-unredactable` rather than inheriting a stamp
that would imply the bytes had been cleaned. The capture status says so in words a reader will
understand, because that warning is the only thing standing between a convenience and a leak.

## License

`UNLICENSED` / private. Internal Info Edge project; not published to a registry and not licensed
for redistribution.
