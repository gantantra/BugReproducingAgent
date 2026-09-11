---
id: ADR-0019
title: TypeScript monorepo with pnpm workspaces, Turborepo, and a build-enforced import boundary
status: accepted
date: 2026-09-10
touches: [build]
decision: Use a pnpm + Turborepo TypeScript monorepo with one package per architectural layer, a custom ESLint import-boundary rule, and an import-graph test that fails the build when a forbidden edge appears.
consequences: Layering violations are caught mechanically rather than in review, at the cost of monorepo tooling setup and a pnpm prerequisite that is not yet installed on the target machine.
---

# ADR-0019 — TypeScript monorepo, pnpm, Turborepo

## Context

The architecture depends on a dependency direction that must not be violated:

```
core <- storage <- execution <- evidence <- lineage <- ai-gateway <- tools <- ai-flows <- reporting
                                    ^                                            |
                                    +---------------- approvals -----------------+
apps/cli depends on everything. Nothing depends on apps/cli.
```

The single most important edge — that `execution`, `evidence`, and `test-fixtures` never reach
`ai-gateway`, `ai-flows`, or a provider SDK — is what makes ADR-0006 real rather than aspirational.
A convention enforced by code review is not enough for a property this load-bearing.

## Decision

- pnpm workspaces plus Turborepo, as specified in the stack.
- One package per architectural layer: `core`, `storage`, `execution`, `evidence`, `lineage`,
  `approvals`, `ai-gateway`, `ai-flows`, `tools`, `reporting`, `test-fixtures`, plus `apps/cli` and
  the optional later `apps/ui`.
- Package boundaries are the enforcement mechanism. Layers are not merely directories, because a
  directory boundary is trivial to cross with a relative import.
- TypeScript project references with `composite: true` so a forbidden import fails at type-check,
  not only at lint.
- A custom ESLint rule (`no-restricted-imports` configured per package) gives fast developer
  feedback.
- An **import-graph test** walks the resolved module graph from each package entry point and fails
  the build on any forbidden edge. The test is the authority, because lint can be disabled inline
  and type-check can be bypassed with `any`.
- Turborepo cache keys include schema hashes and flow hashes, so a schema or prompt change
  invalidates dependent tasks. The reliability gate runs with the cache disabled in CI, since a
  cached green gate proves nothing about the current tree.
- Vitest for unit and integration tests, colocated as `*.spec.ts`; the Playwright test runner for
  the reliability specs that drive browsers.
- Prettier for formatting, with a single shared config.
- `.gitignore` excludes `.investigator/`, `node_modules/`, `dist/`, and `CLAUDE.md`.

## Prerequisite, unresolved

`pnpm` is **not installed** on the target machine (`node -v` reports v24.15.0; `pnpm -v` returns
nothing). Recommended resolution is `corepack enable pnpm` with the version pinned in the root
`package.json` `packageManager` field, which is reproducible and needs no global install. Raised as
open question Q1. If pnpm is unacceptable, npm workspaces plus a simpler task runner is a viable
substitute at the cost of Turborepo caching; that substitution would need this ADR superseded.

## Alternatives considered

| Alternative | Why rejected |
| --- | --- |
| Single package with directories | The critical import boundary becomes a relative-path convention |
| npm workspaces without Turborepo | Workable, loses task caching and pipeline definition; kept as the fallback for Q1 |
| Nx | More capability than needed; heavier configuration surface |
| Separate repositories per layer | Enormous coordination cost for a single-user tool |
| Lint-only boundary enforcement | Inline disables and `any` casts defeat it; the boundary is too important |

## Consequences

Positive: layering violations fail the build; incremental builds and cached tasks keep the loop
fast; each package has an explicit public surface; the boundary that protects the governing
principle is mechanically enforced three ways.

Negative: monorepo tooling setup cost, a package-manager prerequisite that is currently missing,
and the discipline of declaring cross-package dependencies explicitly.
