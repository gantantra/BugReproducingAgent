import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

// Workspace packages resolve to source, not dist, so tests do not require a build first.
// The build is still verified separately by `npm run build` in the gate.
const alias = Object.fromEntries(
  [
    "core",
    "storage",
    "evidence",
    "execution",
    "lineage",
    "approvals",
    "ai-gateway",
    "tools",
    "ai-flows",
    "reporting",
    "test-fixtures",
  ].map((p) => [`@investigator/${p}`, resolve(__dirname, `packages/${p}/src/index.ts`)])
);

export default defineConfig({
  resolve: { alias },
  test: {
    projects: [
      {
        resolve: { alias },
        test: {
          name: "unit",
          // `apps/*` is included deliberately: CLAUDE.md requires colocated unit tests, and
          // without this glob a spec beside a CLI source file would be silently never run.
          include: [
            "packages/*/src/**/*.spec.ts",
            "packages/*/test/**/*.test.ts",
            "apps/*/src/**/*.spec.ts",
          ],
          environment: "node",
          testTimeout: 20_000,
          hookTimeout: 20_000,
        },
      },
      {
        resolve: { alias },
        test: {
          name: "docs",
          include: ["tests/docs/**/*.spec.ts"],
          environment: "node",
          testTimeout: 60_000,
        },
      },
      {
        resolve: { alias },
        test: {
          name: "e2e",
          include: ["tests/e2e/**/*.test.ts"],
          environment: "node",
          testTimeout: 120_000,
          hookTimeout: 120_000,
          pool: "forks",
          poolOptions: { forks: { singleFork: true } },
        },
      },
      {
        resolve: { alias },
        test: {
          // ADR-0024: the reliability gate runs under Vitest, driving our own executor.
          // Single-threaded and sequential: the performance spec measures 100 SEQUENTIAL
          // runs, and the interruption spec kills a process, which must not race a sibling.
          name: "reliability",
          include: ["tests/reliability/**/*.spec.ts"],
          environment: "node",
          testTimeout: 900_000,
          hookTimeout: 120_000,
          pool: "forks",
          poolOptions: { forks: { singleFork: true } },
          fileParallelism: false,
          retry: 0,
        },
      },
    ],
  },
});
