---
adr: 0027
title: An interactive authoring loop, separate from the measurement loop
status: accepted
date: 2026-09-13
touches: [ai-flows, execution, apps/cli, apps/web]
supersedes: none
---

# ADR-0027 — An interactive authoring loop, separate from the measurement loop

## Governing principle

Playwright produces evidence. Deterministic software normalizes and measures evidence. DeepSeek interprets and prioritizes evidence. Humans authorize consequential transitions.

The second sentence of the non-negotiable principles previously read "DeepSeek is never in the
execution loop." It now reads "never in the **measurement** loop." This ADR is the record of why,
and of the boundary that makes the change safe rather than convenient.

## Context

`intake_to_flow` interprets a bug report into a Flow **without ever seeing the application**. The
model is given the reporter's words, the target's constraints and the action vocabulary, and it
writes the whole sequence blind. That sequence then either runs or it does not.

In practice it does not, and the reasons are all the same reason: the page is the only place the
missing information exists.

- A reporter says "click Delete Account". Whether that is a `button`, a `link`, or a div with a
  click handler is on the page.
- A reporter says "the phone field". Which of four inputs it is, is on the page.
- A login redirects to an interstitial nobody mentioned. It is on the page.
- A control only appears after a modal is dismissed. On the page.

Every one of those surfaces as `AUTOMATION_FAILED` after a full batch has been approved and run.
The operator then edits the proposal, re-approves, and runs again — a cycle whose length is the
whole point of the complaint that started this work. The agent was asking a model to imagine an
application and then punishing the imagination for being wrong.

## Decision

Add a second, explicitly different kind of browser session.

**Authoring** — non-deterministic, interactive, and produces no evidence. The model drives a live
browser one action at a time: it observes the page, proposes the next action from the closed
vocabulary, the harness executes it, and the model observes the result. When it cannot decide — an
ambiguous control, an unexpected page, a login it has no credential for — it **stops and asks the
operator**, who answers in the chat and the loop resumes. The session ends when the reported
behaviour has been reached.

**Measurement** — deterministic, unattended, and unchanged. The approved script runs N times with
no model anywhere near it, producing the evidence, the outcomes and the frequency.

Between the two sits a human, at a gate, looking at a video of the one successful authoring run.

### What each side is allowed to decide

This is the ratio the change is for, stated so it can be checked rather than felt:

| Decided by the model                      | Decided by the harness                          |
| ----------------------------------------- | ----------------------------------------------- |
| Which action to try next                   | Which actions exist at all (closed vocabulary)   |
| How to phrase a selector for what it sees  | How a selector resolves, and to what             |
| When it is stuck and must ask              | What is captured, and how it is redacted         |
| When the reported behaviour was reached    | Whether the result is a defect (outcome rules)   |
| —                                          | What runs N times, and what that measured        |

The model's flexibility is bounded by a vocabulary it cannot extend and a capture path it cannot
influence. Its output is a proposal, not a verdict.

### Why the principle survives

"Never in the execution loop" protected one thing: a measured run must not be influenced by a
model, because a statistic contaminated by a model's judgement is not a measurement of the
application. That property is untouched. Authoring measures nothing — it produces no `RunOutcome`,
no frequency, no finding, and nothing it does is admissible as evidence. Its only output is a
candidate script a human must approve before any measurement happens.

The wording changes because the wording was a proxy for the property, and the proxy had started to
forbid something the property does not.

## Consequences

- The Playwright **CLI** is used for what it is good at and not for what it is not. `playwright
  test --repeat-each=N` with video on is the portable N-run artefact, runnable by anyone with
  Playwright and no ReproAgent at all. `playwright codegen` records a human and cannot be driven
  by a model mid-run, so authoring uses the Playwright **library**, already a dependency.
- An authoring session is a privileged thing: it takes real actions on a real target with the
  operator watching. It is not unattended, and it is not repeatable — the deterministic re-run is.
- A session that ends without reaching the reported behaviour produces nothing. A partial script
  is worse than no script, because it looks like one.
- Every authored step is an `ActionSpec` by construction, so the emitted suite and the
  deterministic re-run come free rather than needing a translation step that can fail after the
  operator has already spent the session.

## Alternatives considered

**Keep the principle absolute; the operator drives.** A `codegen`-style session where the human
clicks through the bug and the model only converts the recording afterwards. Honest and simple,
and it needs no contract change. Rejected because it moves the whole burden to the operator for
every case, which is the cost the product exists to remove — though it remains the correct
fallback for a target the model cannot navigate.

**Drive the browser through `@playwright/mcp`.** Richer control and snapshot tooling out of the
box. Rejected as the primary surface because the model could then take steps the deterministic
runner cannot express, so a successful authoring session might not convert into a re-runnable
experiment — which is the entire deliverable.

**Translate MCP steps into the vocabulary after the fact.** The most capable option, and the
failure mode is the worst one available: the translation fails after the operator has finished the
session, and the work is lost at the moment it looked complete.
