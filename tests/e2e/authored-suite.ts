import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A workspace with an investigation and an authored-shape suite in it, for the rerun and confirm
 * gates. The suite's Playwright is linked to the repository's own copy rather than installed from
 * the registry, so these tests need no network; everything else is what the CLI really does.
 */

export const CLI = join(process.cwd(), "apps", "cli", "dist", "bin.js");
export const ENV: NodeJS.ProcessEnv = { ...process.env, REPROAGENT_NO_ENV_FILE: "1" };
const execAsync = promisify(execFile);

export async function cli(args: string[]): Promise<{ status: number; stdout: string }> {
  try {
    const { stdout } = await execAsync(process.execPath, [CLI, ...args], {
      env: ENV,
      maxBuffer: 16 * 1024 * 1024,
    });
    return { status: 0, stdout };
  } catch (e) {
    const err = e as { code?: number; stdout?: string; stderr?: string };
    return { status: err.code ?? -1, stdout: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

function linkPlaywright(nodeModules: string): void {
  const repoModules = join(process.cwd(), "node_modules");
  mkdirSync(join(nodeModules, "@playwright", "test"), { recursive: true });
  for (const pkg of ["playwright", "playwright-core"]) {
    symlinkSync(join(repoModules, pkg), join(nodeModules, pkg), "junction");
  }
  // What the published @playwright/test package is: a re-export of playwright/test, and its CLI.
  const version = (
    JSON.parse(readFileSync(join(repoModules, "playwright", "package.json"), "utf8")) as {
      version: string;
    }
  ).version;
  const pw = join(nodeModules, "@playwright", "test");
  writeFileSync(
    join(pw, "package.json"),
    JSON.stringify({ name: "@playwright/test", version, main: "index.js" })
  );
  writeFileSync(join(pw, "index.js"), "module.exports = require('playwright/test');\n");
  writeFileSync(
    join(pw, "cli.js"),
    "const { program } = require('playwright/lib/program');\nprogram.parse(process.argv);\n"
  );
}

export function filesUnder(root: string): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  for (const f of readdirSync(root)) {
    const p = join(root, f);
    if (statSync(p).isDirectory()) out.push(...filesUnder(p));
    else out.push(p);
  }
  return out;
}

/** A fresh workspace with INV-001 and a suite that filters the fixture's search results. */
export function authoredSuiteWorkspace(searchUrl: string): { ws: string; suiteDir: string } {
  const ws = mkdtempSync(join(tmpdir(), "investigator-suite-"));
  execFileSync(process.execPath, [CLI, "init", "--workspace", ws], { env: ENV, stdio: "pipe" });
  writeFileSync(
    join(ws, "report.md"),
    "# Filter empties\n\nClicking Verified sometimes shows nothing.\n"
  );
  execFileSync(
    process.execPath,
    [
      CLI,
      "intake",
      "--from",
      join(ws, "report.md"),
      "--title",
      "Filter empties",
      "--workspace",
      ws,
      "--json",
    ],
    { env: ENV, stdio: "pipe" }
  );

  const suiteDir = join(ws, ".investigator", "investigations", "INV-001", "authoring", "suite");
  mkdirSync(join(suiteDir, "tests"), { recursive: true });
  writeFileSync(
    join(suiteDir, "package.json"),
    JSON.stringify({ name: "repro-inv-001", private: true })
  );
  writeFileSync(
    join(suiteDir, "playwright.config.ts"),
    [
      `import { defineConfig } from "@playwright/test";`,
      `export default defineConfig({`,
      `  retries: 0,`,
      `  workers: 1,`,
      `  outputDir: "./artifacts",`,
      `  use: { video: "on", trace: "retain-on-failure", actionTimeout: 3_000 },`,
      `});`,
      ``,
    ].join("\n")
  );
  writeFileSync(
    join(suiteDir, "tests", "repro.spec.ts"),
    [
      `import { test } from "@playwright/test";`,
      ``,
      `test("filter", async ({ page }) => {`,
      `  await page.goto(${JSON.stringify(searchUrl)});`,
      `  await page.getByTestId("filter-verified").click();`,
      `  await page.getByTestId("result-card").first().waitFor({ timeout: 3_000 });`,
      `});`,
      ``,
    ].join("\n")
  );
  linkPlaywright(join(suiteDir, "node_modules"));
  return { ws, suiteDir };
}
