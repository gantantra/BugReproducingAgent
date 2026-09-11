---
id: ADR-0024
title: Vitest is the single test runner; the Playwright test runner is reserved for emitted reproducers
status: accepted
date: 2026-09-11
touches: [build, execution]
decision: Run every test in this repository under Vitest, including the reliability gate specs, which drive Chromium through the playwright library by invoking our own executor rather than through the Playwright test runner. Reserve the Playwright test runner for the standalone reproducer packages emitted in M7.
consequences: One runner, one config, and reliability tests that exercise the real executor path, at the cost of not using Playwright fixtures, its trace viewer integration, or its built-in retry and sharding.
---

# ADR-0024 — Vitest as the single test runner

Refines ADR-0019, which said Vitest for unit and integration tests and the Playwright test runner
for reliability specs that drive browsers.

## Governing principle

Playwright produces evidence. Deterministic software normalizes and measures evidence. DeepSeek interprets and prioritizes evidence. Humans authorize consequential transitions.

## Context

The reliability gate does not test a web page. It tests **our executor**: that it writes one sealed
manifest per run, classifies outcomes by the right rule, correlates network events to action
windows, redacts before persistence, and reaps an interrupted worker into a typed outcome.

Those specs call `runJob()` and then assert over the database and the artifact store. The browser
is driven by our own code, through the `playwright` library, exactly as it is in production. The
Playwright test runner adds nothing to that: its value is fixtures, `page` injection, auto-tracing,
and parallel sharding for tests that themselves script a browser.

Using two runners would mean two configs, two reporters, two ways to express a temp workspace, and
a second place for the import-boundary rules to be enforced.

## Decision

- Vitest runs everything: unit specs colocated as `*.spec.ts`, integration tests under
  `packages/*/test/`, CLI end-to-end tests under `tests/e2e/`, and the ten reliability specs under
  `tests/reliability/`.
- Reliability specs import our executor and the `playwright` library directly. They never import
  `@playwright/test`.
- Reliability specs run in a separate Vitest project with a longer timeout, single-threaded, so
  browser launches do not contend and so the interruption spec can kill a process without racing a
  sibling test.
- The Playwright **test runner** remains a dependency of the emitted reproducer package only. A
  reproducer must be runnable by a developer with `npx playwright test` and no knowledge of this
  repository, which is an M7 concern.
- The "run each spec twice in one CI job" requirement from the reliability strategy is met with
  Vitest `--retry=0` plus an explicit repeat wrapper, not with Playwright `--repeat-each`.

## Consequences

Positive: one runner and one config; the gate exercises the production executor path rather than a
parallel test-only path; temp-workspace setup and teardown are expressed once; the import boundary
has one enforcement surface.

Negative: no Playwright fixtures, no automatic trace attachment on failure, and no built-in
sharding for the gate. Sharding is irrelevant at M1 because the gate is deliberately sequential:
the performance test measures 100 **sequential** runs, and `execution.workers` is asserted to be 1.
Trace attachment is unnecessary because our own collector already captures and hashes artifacts,
and failures are diagnosed from the manifest and the evidence index rather than from a runner
report.
