# Acceptance Tests Index

Status: M0 frozen candidate

## Governing principle

Playwright produces evidence. Deterministic software normalizes and measures evidence. DeepSeek interprets and prioritizes evidence. Humans authorize consequential transitions.

## Structure

| Document | Covers |
| --- | --- |
| `M0-doc-checks.md` | Documentation and schema invariants enforced in CI from M1 onward |
| `M1-reliability-gate.md` | The ten executable reliability tests, their fixtures, and pass criteria |
| Milestone docs `docs/milestones/M<n>.md` | Per-milestone acceptance test tables (M1-AT-*, M2-AT-*, …) |

Acceptance tests per milestone live in the milestone document rather than being duplicated here,
so that a milestone is readable as one self-contained contract. This index exists to say where
everything is and to hold the cross-milestone rules below.

## Cross-milestone rules

1. **Gates accumulate.** Every gate, once added, runs in CI forever. A milestone is not done unless
   every prior gate still passes in the same CI run.
2. **Gates are executable.** A pass criterion that cannot be decided by a test is not a gate; it
   is a design note and belongs in an architecture document.
3. **Gates are never relaxed to unblock work.** A gate shown to be wrong is fixed, and the fix is
   recorded as an ADR. A budget shown to be unachievable on the actual runner is renegotiated in
   writing in `docs/FREEZE-M0.md`.
4. **Hard-fail rows are not thresholds.** The rows marked hard in `docs/evaluation/eval-gates.md`
   are the mechanised form of the non-negotiable principles. A build violating one is broken.
5. **Negative tests are first-class.** Every validation rule, every gate check, and every safety
   guard has at least one test that proves it *rejects* the bad case, not merely that it accepts
   the good one.
6. **Determinism is asserted, not assumed.** Any component claimed deterministic has a test that
   runs it twice and compares bytes.
7. **Cross-platform.** Anything touching paths, file locking, process termination, or locale is
   asserted on both Windows and Linux.

## Test taxonomy and where each kind lives

| Kind | Runner | Location |
| --- | --- | --- |
| Unit | Vitest | `packages/*/src/**/*.spec.ts` |
| Integration (store, queue, config, redaction) | Vitest | `packages/*/test/**/*.test.ts` |
| Reliability gate (drives browsers) | Playwright test runner | `/tests/reliability/*.spec.ts` |
| CLI end-to-end | Vitest, spawning the built CLI | `/tests/e2e/*.test.ts` |
| Eval (replay) | eval harness | `/eval/harness`, cases in `/eval/datasets` and `/ai/flows/*/eval` |
| Eval (live) | eval harness, on demand | same |
| Doc/schema invariants | Node script | `/tests/docs/*.test.ts` |

## Naming

`M<n>-AT-<k>` for milestone acceptance tests. Reliability specs are named by behaviour, not number.
Eval cases are `<flow>-<nnn>-<slug>` with `polarity` in the case file.
