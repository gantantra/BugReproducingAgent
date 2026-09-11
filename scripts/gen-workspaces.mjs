// Generates each workspace package.json and tsconfig.json from one declaration of the
// dependency graph, so the graph exists in exactly one place. Re-runnable and idempotent.
//
// The graph here is the enforcement surface for ADR-0006 and ADR-0019: `execution`,
// `evidence`, and `test-fixtures` must not reference `ai-gateway`, `ai-flows`, or a provider
// SDK. TypeScript project references make a violation a compile error, and
// tests/docs/import-boundary.spec.ts checks the resolved module graph as well.
import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** dir -> { deps: workspace package short names, external: npm deps } */
const GRAPH = {
  "packages/core": { deps: [], external: { ajv: "^8.17.1", "ajv-formats": "^3.0.1", yaml: "^2.8.1" } },
  "packages/storage": { deps: ["core"], external: {} },
  "packages/evidence": { deps: ["core", "storage"], external: { yaml: "^2.8.1" } },
  // `lib: DOM` because this package contains in-page page.evaluate callbacks that really do
  // execute in a browser. It does NOT make the Node code DOM-aware by accident: those
  // callbacks are the only place browser globals appear.
  "packages/execution": {
    deps: ["core", "storage", "evidence"],
    external: { playwright: "^1.56.0" },
    lib: ["ES2023", "DOM"],
  },
  "packages/lineage": { deps: ["core", "storage"], external: {} },
  "packages/approvals": { deps: ["core", "storage"], external: { yaml: "^2.8.1" } },
  "packages/ai-gateway": { deps: ["core"], external: {} },
  "packages/tools": { deps: ["core", "storage", "evidence"], external: {} },
  "packages/ai-flows": { deps: ["core", "ai-gateway", "tools"], external: {} },
  "packages/reporting": { deps: ["core", "storage", "evidence", "lineage"], external: {} },
  "packages/test-fixtures": { deps: ["core"], external: {} },
  "apps/cli": {
    deps: [
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
    ],
    external: { commander: "^14.0.1" },
    bin: true,
  },
};

const SCOPE = "@investigator";
const dirOf = (short) => (short === "cli" ? "apps/cli" : `packages/${short}`);

for (const [dir, spec] of Object.entries(GRAPH)) {
  const short = dir.split("/").pop();
  const name = `${SCOPE}/${short}`;

  const dependencies = { ...spec.external };
  // npm workspaces links local packages with a plain "*" range. The `workspace:` protocol is
  // pnpm/yarn syntax and npm rejects it with EUNSUPPORTEDPROTOCOL (ADR-0023).
  for (const d of spec.deps) dependencies[`${SCOPE}/${d}`] = "*";

  const pkg = {
    name,
    version: "0.1.0",
    private: true,
    type: "commonjs",
    main: "./dist/index.js",
    types: "./dist/index.d.ts",
    exports: { ".": { types: "./dist/index.d.ts", default: "./dist/index.js" } },
    ...(spec.bin ? { bin: { investigate: "./dist/bin.js" } } : {}),
    scripts: { clean: "node -e \"require('node:fs').rmSync('dist',{recursive:true,force:true})\"" },
    ...(Object.keys(dependencies).length ? { dependencies } : {}),
  };

  const tsconfig = {
    extends: "../../tsconfig.base.json",
    compilerOptions: {
      rootDir: "src",
      outDir: "dist",
      tsBuildInfoFile: "dist/.tsbuildinfo",
      ...(spec.lib ? { lib: spec.lib } : {}),
    },
    include: ["src/**/*.ts"],
    exclude: ["src/**/*.spec.ts", "node_modules", "dist"],
    ...(spec.deps.length
      ? { references: spec.deps.map((d) => ({ path: `../../${dirOf(d)}` })) }
      : {}),
  };

  mkdirSync(join(root, dir, "src"), { recursive: true });
  writeFileSync(join(root, dir, "package.json"), JSON.stringify(pkg, null, 2) + "\n");
  writeFileSync(join(root, dir, "tsconfig.json"), JSON.stringify(tsconfig, null, 2) + "\n");
  console.log(
    `${name.padEnd(30)} deps=[${spec.deps.join(",") || "-"}]  external=[${Object.keys(spec.external).join(",") || "-"}]`
  );
}

// Emit the graph as JSON so the import-boundary test asserts against the same source of truth.
writeFileSync(
  join(root, "scripts", "workspace-graph.json"),
  JSON.stringify(
    Object.fromEntries(Object.entries(GRAPH).map(([d, s]) => [d, { deps: s.deps, external: Object.keys(s.external) }])),
    null,
    2
  ) + "\n"
);
console.log("\nwrote scripts/workspace-graph.json");
