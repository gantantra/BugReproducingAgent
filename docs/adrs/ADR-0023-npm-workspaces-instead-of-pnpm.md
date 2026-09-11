---
id: ADR-0023
title: npm workspaces instead of pnpm and Turborepo
status: accepted
date: 2026-09-11
touches: [build]
decision: Use npm workspaces with a hand-written task pipeline in root scripts, taking the fallback ADR-0019 already recorded for open question Q1, because corepack cannot be enabled on the target machine without administrator rights and corepack could not reach the registry to run pnpm directly.
consequences: The scaffold works today with the toolchain actually present, at the cost of Turborepo task caching, and with the import-boundary enforcement moved entirely onto the TypeScript project references and the import-graph test.
---

# ADR-0023 — npm workspaces instead of pnpm and Turborepo

Supersedes the package-manager portion of ADR-0019. The layering, package split, project
references, and import-graph enforcement in ADR-0019 all stand unchanged.

## Context

ADR-0019 specified pnpm workspaces plus Turborepo and recorded npm workspaces as the fallback for
open question Q1. Two things were then observed on the target machine:

1. `corepack enable pnpm` fails with `EPERM: operation not permitted, open
   'C:\Program Files\nodejs\pnpm'`. Corepack writes its shims into the Node installation
   directory, which needs administrator rights this session does not have.
2. `corepack pnpm --version`, which would run pnpm without installing shims, did not return within
   five minutes and was cancelled. Corepack resolves the package manager from the registry on
   first use; that fetch is evidently slow or blocked on this network.

`npm --version` returns 11.14.1 immediately.

Blocking the entire milestone on a package manager would be the wrong trade, and the fallback was
already sanctioned.

## Decision

- npm workspaces, declared in the root `package.json` `workspaces` array.
- No Turborepo. Root scripts drive the pipeline with `npm run <task> --workspaces
  --if-present`, and TypeScript project references give incremental compilation.
- `packageManager` is **not** pinned, because pinning it would make every npm command attempt a
  corepack download that does not work here.
- The workspace layout, package names, and dependency graph are identical to what ADR-0019
  specified, so migrating to pnpm later is: add `pnpm-workspace.yaml`, delete `node_modules` and
  `package-lock.json`, run `pnpm install`. No source change.

## What is lost, and what covers it

| Lost with Turborepo | Compensation |
| --- | --- |
| Task result caching | TypeScript `composite` project references give incremental builds. Vitest caches its own transform output. The reliability gate deliberately ran with caching disabled in CI anyway |
| Pipeline dependency declaration | Root scripts order the tasks explicitly. The ordering is short enough to read |
| Cache keys including schema and flow hashes | Not needed while there is no cache. When pnpm and Turborepo return, this returns with them |

The critical property from ADR-0019 — that `execution`, `evidence`, and `test-fixtures` cannot
reach `ai-gateway`, `ai-flows`, or a provider SDK — does not depend on the package manager. It is
enforced by TypeScript project references, an ESLint boundary rule, and the import-graph test,
all of which work identically under npm.

## How to get pnpm, if wanted later

Either of these, run once by the user:

- In an **administrator** terminal: `corepack enable pnpm`
- Without admin, into a writable directory already on `PATH`:
  `corepack enable pnpm --install-directory <dir>`

Then `pnpm install` in the repository root. This ADR would be superseded at that point.

## Consequences

Positive: the scaffold installs and builds with the toolchain present today; zero admin
requirements; no dependency on registry reachability for the package manager itself; the migration
path stays open and cheap.

Negative: no task caching, so full-repository test runs are slower than they would be under
Turborepo. On a project of this size that is seconds, not minutes. Also a documented deviation from
the frozen stack in the brief, which is why it is recorded here and in the FREEZE-M0 amendment log
rather than made silently.
