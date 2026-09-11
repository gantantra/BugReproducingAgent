import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadEnvFile, parseEnvFile } from "./env-file.js";

/**
 * `.env` loading for the CLI process.
 *
 * Playwright produces evidence. Deterministic software normalizes and measures evidence. DeepSeek interprets and prioritizes evidence. Humans authorize consequential transitions.
 *
 * The two tests that matter are precedence and the opt-out. Everything else is parsing.
 */

describe("parseEnvFile", () => {
  it("reads plain assignments and ignores blanks and comments", () => {
    expect(
      parseEnvFile(
        ["# a comment", "", "DEEPSEEK_BASE_URL=https://api.example.invalid/v1", ""].join("\n")
      )
    ).toEqual([["DEEPSEEK_BASE_URL", "https://api.example.invalid/v1"]]);
  });

  it("accepts an `export` prefix, because that is what people paste", () => {
    expect(parseEnvFile("export DEEPSEEK_FAST_MODEL=m-fast")).toEqual([
      ["DEEPSEEK_FAST_MODEL", "m-fast"],
    ]);
  });

  it("strips matching quotes and keeps a quoted hash", () => {
    expect(parseEnvFile(`A="v#1"\nB='v2'`)).toEqual([
      ["A", "v#1"],
      ["B", "v2"],
    ]);
  });

  it("drops an unquoted trailing comment", () => {
    expect(parseEnvFile("A=value # trailing")).toEqual([["A", "value"]]);
  });

  it("performs no interpolation", () => {
    // A credential file that can expand expressions is a credential file that can surprise you.
    expect(parseEnvFile("A=$OTHER/x")).toEqual([["A", "$OTHER/x"]]);
  });

  it("skips malformed lines rather than guessing", () => {
    expect(parseEnvFile("no-equals-here\n=novalue\n1BAD=x")).toEqual([]);
  });
});

describe("loadEnvFile", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "reproagent-env-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const write = (body: string): void => writeFileSync(join(dir, ".env"), body, "utf8");

  it("returns nothing when there is no file", () => {
    expect(loadEnvFile(dir, {}).path).toBeNull();
  });

  it("applies a variable that is not already set", () => {
    write("DEEPSEEK_FAST_MODEL=m-fast");
    const env: NodeJS.ProcessEnv = {};
    const result = loadEnvFile(dir, env);
    expect(result.applied).toEqual(["DEEPSEEK_FAST_MODEL"]);
    expect(env["DEEPSEEK_FAST_MODEL"]).toBe("m-fast");
  });

  it("never overwrites the real environment", () => {
    // The classic dotenv footgun, and here the shadowed value would be a credential: a stale file
    // silently beating a deliberate export is the one failure mode worth a dedicated test.
    write("DEEPSEEK_API_KEY=from-file");
    const env: NodeJS.ProcessEnv = { DEEPSEEK_API_KEY: "from-real-environment" };
    const result = loadEnvFile(dir, env);
    expect(env["DEEPSEEK_API_KEY"]).toBe("from-real-environment");
    expect(result.applied).toEqual([]);
    expect(result.skipped).toEqual(["DEEPSEEK_API_KEY"]);
  });

  it("is disabled entirely by REPROAGENT_NO_ENV_FILE", () => {
    // The e2e suite and the demo clear every DEEPSEEK_* variable to prove the deterministic path
    // needs no credential. Without this opt-out a local .env would restore them and that proof
    // would quietly become false.
    write("DEEPSEEK_API_KEY=from-file");
    const env: NodeJS.ProcessEnv = { REPROAGENT_NO_ENV_FILE: "1" };
    expect(loadEnvFile(dir, env).path).toBeNull();
    expect(env["DEEPSEEK_API_KEY"]).toBeUndefined();
  });

  it("reports names only, so a caller cannot log a value it was handed", () => {
    write("DEEPSEEK_API_KEY=sk-must-not-appear\nDEEPSEEK_FAST_MODEL=m-fast");
    const result = loadEnvFile(dir, {});
    expect(JSON.stringify(result)).not.toContain("sk-must-not-appear");
    expect(result.applied).toContain("DEEPSEEK_API_KEY");
  });
});
