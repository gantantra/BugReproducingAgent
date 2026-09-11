import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";

/**
 * The authority for ADR-0006 and ADR-0019.
 *
 * The ESLint boundary rule gives fast feedback, but lint can be disabled inline and a `any` cast
 * defeats type checking. This walks the actual source graph and fails the build, which is why it
 * is the authority rather than the convenience.
 */

const ROOT = process.cwd();
const AI_PACKAGES = ["@investigator/ai-gateway", "@investigator/ai-flows"];
const PROVIDER_SDKS = [
  "openai",
  "@anthropic-ai/",
  "@google/generative-ai",
  "cohere-ai",
  "ollama",
  "langchain",
  "@mistralai/",
];

function sourceFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist") continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p));
    else if (entry.endsWith(".ts")) out.push(p);
  }
  return out;
}

/** Every module specifier in a file: static imports, type imports, re-exports, dynamic imports. */
function importsOf(file: string): string[] {
  const text = readFileSync(file, "utf8");
  const specs: string[] = [];
  const patterns = [
    /(?:^|\n)\s*import\s+[^;]*?from\s+["']([^"']+)["']/g,
    /(?:^|\n)\s*import\s+["']([^"']+)["']/g,
    /(?:^|\n)\s*export\s+[^;]*?from\s+["']([^"']+)["']/g,
    /\bimport\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const re of patterns) {
    for (const m of text.matchAll(re)) if (m[1]) specs.push(m[1]);
  }
  return specs;
}

/** Resolve the workspace package a relative or scoped specifier lands in. */
function workspaceDepsOf(pkgDir: string): Set<string> {
  const deps = new Set<string>();
  for (const file of sourceFiles(join(ROOT, pkgDir, "src"))) {
    for (const spec of importsOf(file)) {
      if (spec.startsWith("@investigator/")) deps.add(spec);
    }
  }
  return deps;
}

function transitiveWorkspaceDeps(pkgDir: string, seen = new Set<string>()): Set<string> {
  for (const dep of workspaceDepsOf(pkgDir)) {
    if (seen.has(dep)) continue;
    seen.add(dep);
    const short = dep.replace("@investigator/", "");
    const childDir = short === "cli" ? "apps/cli" : `packages/${short}`;
    if (existsSync(join(ROOT, childDir, "src"))) transitiveWorkspaceDeps(childDir, seen);
  }
  return seen;
}

const DETERMINISTIC_PACKAGES = [
  "packages/execution",
  "packages/evidence",
  "packages/test-fixtures",
];

describe("import boundary (ADR-0006)", () => {
  it.each(DETERMINISTIC_PACKAGES)(
    "%s does not reach AI code, transitively",
    (pkgDir) => {
      const reachable = transitiveWorkspaceDeps(pkgDir);
      for (const ai of AI_PACKAGES) {
        expect(
          [...reachable],
          `${pkgDir} transitively imports ${ai}. DeepSeek is never in the execution loop.`
        ).not.toContain(ai);
      }
    }
  );

  it.each(DETERMINISTIC_PACKAGES)("%s imports no provider SDK", (pkgDir) => {
    for (const file of sourceFiles(join(ROOT, pkgDir, "src"))) {
      for (const spec of importsOf(file)) {
        for (const sdk of PROVIDER_SDKS) {
          expect(
            spec.startsWith(sdk),
            `${file} imports provider SDK ${spec}`
          ).toBe(false);
        }
      }
    }
  });

  it.each(DETERMINISTIC_PACKAGES)("%s has no relative escape into AI source", (pkgDir) => {
    for (const file of sourceFiles(join(ROOT, pkgDir, "src"))) {
      for (const spec of importsOf(file)) {
        expect(
          /ai-gateway|ai-flows/.test(spec) && spec.startsWith("."),
          `${file} relatively imports ${spec}`
        ).toBe(false);
      }
    }
  });

  it("packages/tools does not reach the executor or drive a browser (ADR-0011)", () => {
    const reachable = transitiveWorkspaceDeps("packages/tools");
    expect([...reachable]).not.toContain("@investigator/execution");
    for (const file of sourceFiles(join(ROOT, "packages/tools/src"))) {
      for (const spec of importsOf(file)) {
        expect(spec).not.toBe("playwright");
      }
    }
  });

  it("nothing depends on apps/cli", () => {
    for (const pkgDir of readdirSync(join(ROOT, "packages"))) {
      const deps = workspaceDepsOf(`packages/${pkgDir}`);
      expect([...deps], `packages/${pkgDir} imports the CLI`).not.toContain("@investigator/cli");
    }
  });

  it("the declared graph in scripts/workspace-graph.json matches the real imports", () => {
    const graph = JSON.parse(
      readFileSync(join(ROOT, "scripts", "workspace-graph.json"), "utf8")
    ) as Record<string, { deps: string[] }>;

    for (const [dir, spec] of Object.entries(graph)) {
      const declared = new Set(spec.deps.map((d) => `@investigator/${d}`));
      for (const actual of workspaceDepsOf(dir)) {
        expect(
          declared.has(actual),
          `${dir} imports ${actual} but does not declare it in the workspace graph`
        ).toBe(true);
      }
    }
  });

  it("only the execution package declares the DOM lib, and only for in-page callbacks", () => {
    const cfg = JSON.parse(
      readFileSync(join(ROOT, "packages/execution/tsconfig.json"), "utf8")
    ) as { compilerOptions: { lib?: string[] } };
    expect(cfg.compilerOptions.lib).toContain("DOM");

    for (const pkgDir of readdirSync(join(ROOT, "packages"))) {
      if (pkgDir === "execution") continue;
      const p = join(ROOT, "packages", pkgDir, "tsconfig.json");
      if (!existsSync(p)) continue;
      const other = JSON.parse(readFileSync(p, "utf8")) as { compilerOptions: { lib?: string[] } };
      expect(other.compilerOptions.lib ?? []).not.toContain("DOM");
    }
  });
});

describe("determinism boundary (ADR-0007)", () => {
  const paths = ["packages/execution/src", "packages/evidence/src"];

  it.each(paths)("%s uses no ambient randomness", (dir) => {
    for (const file of sourceFiles(join(ROOT, dir))) {
      const text = readFileSync(file, "utf8");
      const stripped = text.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
      expect(stripped.includes("Math.random("), `${file} uses Math.random`).toBe(false);
    }
  });

  it.each(paths)("%s uses no ambient clock outside declared exceptions", (dir) => {
    for (const file of sourceFiles(join(ROOT, dir))) {
      const text = readFileSync(file, "utf8");
      const stripped = text.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
      // `new Date(x)` for parsing a recorded ISO string is fine; `Date.now()` and `new Date()`
      // are ambient time and are banned.
      expect(stripped.includes("Date.now("), `${file} uses Date.now`).toBe(false);
      expect(/new Date\(\s*\)/.test(stripped), `${file} uses new Date()`).toBe(false);
    }
  });
});
