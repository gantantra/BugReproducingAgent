import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadDeepSeekCredentials } from "./deepseek-credentials.js";

/**
 * Loading a DeepSeek connection from a file.
 *
 * The behaviour worth defending is what this REFUSES to load. The JSON the DeepSeek console hands
 * out contains an `ANTHROPIC_*` block whose purpose is to point Claude Code at DeepSeek — and this
 * product now runs the operator's own `claude` CLI to author reproductions. Applying that block
 * would send `claude` to DeepSeek's endpoint asking for a DeepSeek model instead of using the
 * login the operator already has, and the failure arrives as `api_error` with an empty result.
 */

let dir: string;

/** The exact two-shape document the DeepSeek console produces. */
const CONSOLE_JSON = {
  api_key: "sk-real-key",
  standard_openai_compatible: {
    DEEPSEEK_API_KEY: "sk-real-key",
    DEEPSEEK_BASE_URL: "https://api.deepseek.com",
  },
  claude_code_anthropic_compatible: {
    ANTHROPIC_AUTH_TOKEN: "sk-real-key",
    ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic",
    ANTHROPIC_MODEL: "deepseek-v4-flash",
  },
  ANTHROPIC_AUTH_TOKEN: "sk-real-key",
  ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic",
  ANTHROPIC_MODEL: "deepseek-v4-flash",
};

function write(doc: unknown): string {
  const path = join(dir, "deepseek.json");
  writeFileSync(path, JSON.stringify(doc, null, 2));
  return path;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ds-creds-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("what it applies", () => {
  it("supplies the OpenAI-compatible key and base, which is what the provider speaks", () => {
    const env: NodeJS.ProcessEnv = {};
    const r = loadDeepSeekCredentials(write(CONSOLE_JSON), env);
    expect(env["DEEPSEEK_API_KEY"]).toBe("sk-real-key");
    expect(env["DEEPSEEK_BASE_URL"]).toBe("https://api.deepseek.com");
    expect(r.applied.sort()).toEqual(["DEEPSEEK_API_KEY", "DEEPSEEK_BASE_URL"]);
  });

  it("reports names, never values", () => {
    const r = loadDeepSeekCredentials(write(CONSOLE_JSON), {});
    expect(JSON.stringify(r)).not.toContain("sk-real-key");
  });
});

describe("what it refuses", () => {
  it("never applies the ANTHROPIC_* block, at either nesting level", () => {
    // This is the whole point. Applying these is what breaks the operator's `claude` login.
    const env: NodeJS.ProcessEnv = {};
    const r = loadDeepSeekCredentials(write(CONSOLE_JSON), env);
    expect(env["ANTHROPIC_AUTH_TOKEN"]).toBeUndefined();
    expect(env["ANTHROPIC_BASE_URL"]).toBeUndefined();
    expect(env["ANTHROPIC_MODEL"]).toBeUndefined();
    expect(r.refused).toContain("ANTHROPIC_AUTH_TOKEN");
  });

  it("reports the refusal rather than dropping it silently", () => {
    // `doctor` has to be able to explain why a variable in the file did not take effect.
    const r = loadDeepSeekCredentials(write(CONSOLE_JSON), {});
    expect(r.refused.length).toBeGreaterThan(0);
    expect(r.applied).not.toContain("ANTHROPIC_AUTH_TOKEN");
  });

  it("ignores keys it does not recognise", () => {
    const env: NodeJS.ProcessEnv = {};
    loadDeepSeekCredentials(write({ SOMETHING_ELSE: "x", api_key: "y" }), env);
    expect(env["SOMETHING_ELSE"]).toBeUndefined();
    expect(env["api_key"]).toBeUndefined();
  });
});

describe("the rules it shares with the .env loader", () => {
  it("never overwrites a variable the real environment already set", () => {
    // A stale file must not shadow a deliberate export — the classic dotenv footgun, and here
    // the shadowed value would be a credential.
    const env: NodeJS.ProcessEnv = { DEEPSEEK_API_KEY: "sk-from-the-shell" };
    const r = loadDeepSeekCredentials(write(CONSOLE_JSON), env);
    expect(env["DEEPSEEK_API_KEY"]).toBe("sk-from-the-shell");
    expect(r.skipped).toContain("DEEPSEEK_API_KEY");
  });

  it("is disabled entirely by REPROAGENT_NO_ENV_FILE", () => {
    // The e2e suite clears every DEEPSEEK_* variable to prove the deterministic path needs no
    // credential. Without an opt-out this file would quietly restore them and that proof would
    // become a lie.
    const env: NodeJS.ProcessEnv = { REPROAGENT_NO_ENV_FILE: "1" };
    const r = loadDeepSeekCredentials(write(CONSOLE_JSON), env);
    expect(env["DEEPSEEK_API_KEY"]).toBeUndefined();
    expect(r.path).toBeNull();
  });

  it("is a no-op when there is no file", () => {
    const r = loadDeepSeekCredentials(join(dir, "absent.json"), {});
    expect(r).toEqual({ path: null, applied: [], skipped: [], refused: [] });
  });

  it("does not stop the deterministic path when the file is malformed", () => {
    // Deterministic work needs no credential at all; a broken file must not block a run.
    const path = join(dir, "deepseek.json");
    writeFileSync(path, "{ not json");
    const env: NodeJS.ProcessEnv = {};
    expect(() => loadDeepSeekCredentials(path, env)).not.toThrow();
    expect(env["DEEPSEEK_API_KEY"]).toBeUndefined();
  });

  it("treats an empty value as absent", () => {
    const env: NodeJS.ProcessEnv = {};
    loadDeepSeekCredentials(write({ standard_openai_compatible: { DEEPSEEK_API_KEY: "" } }), env);
    expect(env["DEEPSEEK_API_KEY"]).toBeUndefined();
  });
});
