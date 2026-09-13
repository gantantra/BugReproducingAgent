---
id: ADR-0028
title: An authored session becomes a measurable experiment by translation, not by execution
status: accepted
date: 2026-09-13
touches: [ai, execution, approvals, cli]
decision: Translate the Playwright statements an authoring session records into the closed action.v1 vocabulary, verify each by rendering it back and comparing, and emit a gate-1 proposal that `plan --from` already accepts — rather than executing the emitted suite or building a second evidence pipeline around it.
consequences: The authored flow reaches the deterministic runner, full evidence capture, lineage and analysis with no new gate and no new command; statements the vocabulary cannot express are refused by name instead of approximated; `common.v1.json#/$defs/selector` gains `filterHasText` and `filterHasNotText`.
---

# ADR-0028 — Authored sessions become measurable experiments

## Governing principle

Playwright produces evidence. Deterministic software normalizes and measures evidence. DeepSeek interprets and prioritizes evidence. Humans authorize consequential transitions.

## Context

ADR-0027 split authoring from measurement. It left the two halves parallel rather than sequential.

An authoring session emitted a standalone Playwright suite. The operator ran it with
`npx playwright test --repeat-each=N` in its own folder, where it recorded a video and a trace and
nothing else. Meanwhile `investigate run` executed the effective proposal from the
`experiment_selection` gate, captured console, exceptions, network metadata, actions, navigation,
video and trace, normalized and redacted all of it, and `analyze` contrasted the result.

Nothing carried the authored flow across. `author` wrote no proposal, so the flow a human had
watched reach the reported behaviour could never become the flow that was measured. The most
valuable artifact the product produces was the one artifact the analysis could not read.

## Decision

The authoring session emits a **gate-1 proposal** alongside the suite, both rendered from the same
recorded statements. `plan --from` renders it into the checksum-bound triple, `approve` binds a
human decision to those bytes, `run` executes it.

Three things follow from that, and each was forced by evidence rather than chosen for neatness.

### The statements are parsed, not executed

`AuthoredStep.code` is a Playwright statement as a string. Running it is not available: ADR-0006
forbids shell execution or `evaluate` derived from model output, because a statement that can run
arbitrary source can satisfy any assertion without the application doing anything.

So each statement is reduced to declared vocabulary. It is scanned with a string-literal-aware
tokenizer rather than matched with a regex — a selector legitimately contains braces, quotes and
commas — and rather than with the TypeScript compiler API, which is a devDependency and a large
runtime dependency for a grammar this narrow.

Anything unrecognised is **refused by name**. Not approximated, and not skipped: a proposal missing
one step from the middle is not a shorter version of the flow, it is a different flow, and it would
still run and still report a pass rate.

### The translation verifies itself by round-tripping

Every action is rendered back into a Playwright statement by a separate function and compared with
the one it came from. A mismatch refuses the whole translation.

This is the load-bearing guarantee. A mistranslated selector does not fail loudly — it silently
measures a different flow than the one the human approved by watching it work. That is the most
expensive wrong answer this product can produce, because it looks like a result.

### The selector vocabulary was extended, deliberately

Statements from real captured sessions include:

```
await page.locator('div').filter({ hasText: 'CONTACT US Toll Free | 9:30' }).nth(5).click();
```

No strategy in `common.v1.json#/$defs/selector` could express `.filter({ hasText })`, so the real
corpus was not translatable. Steering the authoring brief toward cleaner selectors is not an
option: the model picks the element from a snapshot ref, and Playwright MCP decides how to render
the locator.

`filterHasText` and `filterHasNotText` were added, applied before `nth` because that is
Playwright's order and the two are not commutative. ADR-0006 already prescribes the process for
widening the vocabulary — a schema change, a code change, and a human gate — and this followed it.
`filter({ has: ... })` takes a nested locator, which the vocabulary cannot carry, and is refused.

## What this does not change

- DeepSeek is still unreachable from execution, evidence and fixtures.
- The authoring model still touches no measured run, and produces no evidence, outcome or statistic.
- No new gate and no new approval type. `repetitions` is a field in the proposal, so "N runs as
  approved" is the operator editing that number before approving, bound by the same checksum.
- The standalone suite is still emitted. It is the developer handoff, and it remains a by-product
  of the session rather than a reconstruction.

## Consequences

A value typed into a field that matches a supplied credential becomes a `secretRef` naming the
variable, and the statement kept beside the action is redacted — the proposal is written to disk,
content-hashed and read back at a gate, so a secret in it would be a secret at rest.

The gate-1 markdown now renders every discriminating part of a selector and the statement each
action was translated from. It previously rendered `strategy=value`, which described the click
above as `css=div` — thirty matches narrowed to one by a filter the reviewer never saw. Approving
that is not consent, and gate 1 exists to be a judgement rather than a rubber stamp.

The translator covers the forms observed in real sessions. Others will appear; they surface as an
explicit refusal naming the statement, which is the intended failure mode, not as silent
corruption. Round-tripping proves the statement matches — it does not prove the deterministic
executor and Playwright behave identically for the same action. The measured run is the authority;
the suite is the handoff.
