---
id: ADR-0031
title: One Confirm click freezes a checksummed experiment; variant and control run interleaved; only signature-matched failures count
status: accepted
date: 2026-09-21
touches: [cli, web, execution, evidence, ai]
decision: `investigate confirm` builds the experiment config the condition card shows, freezes it as canonical bytes bound to the SHA-256 the Confirm click carries, runs variant and control in a seeded interleaving through `rerun`, counts only failures matching a target signature derived deterministically from the earlier batch, and decides with internal statistical defaults frozen into the config.
consequences: The journey stays Analyse -> See condition -> Confirm -> View result with no extra approval step; the model names a factor and never chooses what counts; the approval gates and their single writer are untouched.
---

# ADR-0031 — The confirmation loop

## Governing principle

Playwright produces evidence. Deterministic software normalizes and measures evidence. DeepSeek interprets and prioritizes evidence. Humans authorize consequential transitions.

## Context

An analysis can say a condition correlates with the failures. Only an experiment can say it triggers them: the same script, run with and without one factor changed. This reinstates, in a narrow form, the signature, rate and validation work of M4–M6, without clustering or minimization.

## Decision

### What the model does, and what it does not

`analyze_failures` 1.1.0 may propose up to three `proposedConfirmations`. Each is:
- one condition sentence
- one factor, either `network` (`slow-3g` or `fast-3g`) or `cpu` (rate 2, 4 or 6)
- a rationale
- a falsifier

It never writes steps, and it does not choose which failures count.

### The target signature is derived, not proposed

`deriveTargetSignature` (packages/evidence) takes the console and exception fingerprints present in every run of the source batch that failed at the final check, and in no passing run. A run matches only if it failed at the check and carries them all. Any other failure at the check is counted apart, as "other failure", and never enters the rate. Runs that never reached the check are excluded, as `rerun` already did.

### One click, frozen bytes

Without `--checksum`, `confirm` only returns the config and its checksum; the page shows this as the condition card. With `--checksum`, which is the Confirm click, it rebuilds the config and refuses with `GATE_CHECKSUM_MISMATCH` (exit 3) before any browser opens if a single byte differs. It then stores the config as a `confirmation-config` artifact. The config is:
- the source batch and the analysis it came from
- the condition, falsifier and rationale
- the factor, and the control (no change)
- the runs per arm
- the suite checksum
- the target signature
- the seed
- the statistical settings

This is not one of the three approval gates, and it does not go through `approve.ts`. Like `rerun`, it runs the operator's own script outside the measured path, and the frozen, checksum-bound config is the record of the decision. That keeps m0-decisions' three gates and `approval-authority.spec.ts`'s single writer exactly as they were.

### Interleaved, and applied per run

`buildConfirmationSchedule` builds n blocks from the seeded `Rng`. Each block holds one variant and one control, in an order the seed decides. Any drift over the batch therefore falls on both arms. The capture fixture reads the frozen schedule and applies the variant's factor through the DevTools protocol before the script's first step. It records the arm and whether the factor took. A variant run whose factor did not take is not counted as a variant.

### Internal statistics

Each arm gets a Wilson interval, and the two arms are compared with a two-sided Fisher exact test. The defaults are:
- 95% intervals
- α 0.05
- at least 10 runs reaching the check per arm

The default run count is 12 per arm, above that minimum on purpose: one browser that fails to start must not make a confirmation impossible.

`high_confidence_trigger` requires all of:
- both arms at or above the minimum
- a higher rate with the change
- intervals that do not overlap
- p < α

Otherwise the result is "not confirmed", with the reason in plain words. None of this appears in the UI. The result shows counts, the verdict and, when confirmed, the rationale as the likely mechanism. `confirmed_root_cause` stays unreachable.

## Consequences

- New artifact kinds `confirmation-config` and `confirmation-result`. The result hangs off its runs in lineage (`derived_finding`, deterministic actor).
- Deferred: the optional "lock in as final reproduction" through `revalidate` and the `final_reproduction` gate.
- Tests:
  - `packages/evidence/src/statistics.spec.ts` checks against published values.
  - `signature.spec.ts`.
  - `apps/cli/src/commands/confirm.spec.ts` covers canonical bytes, tamper detection, schedule determinism and counting.
  - `tests/e2e/confirm-loop.test.ts` uses a real browser against a fixture that fails only on a slow network. It checks the verdict, the stored bytes against the checksum, and the interleaving.
