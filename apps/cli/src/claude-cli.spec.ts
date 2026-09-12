import { describe, it, expect } from "vitest";
import {
  AUTHORING_EFFORT,
  AUTHORING_MODEL,
  HIJACKING_ENV_VARS,
  claudeCliArgs,
  claudeCliEnv,
  playwrightMcpConfig,
} from "./claude-cli.js";

/**
 * Spawning the operator's own Claude CLI (ADR-0027).
 *
 * The behaviour worth protecting here is the environment stripping. On this machine
 * `ANTHROPIC_AUTH_TOKEN` holds the DeepSeek key and `ANTHROPIC_MODEL` names a DeepSeek model,
 * both correct for the DeepSeek path and both fatal for this one — and the failure arrives as
 * `api_error` with an empty result, which reads like a broken CLI rather than a hijacked one.
 */

describe("the environment handed to the CLI", () => {
  it("removes every variable that would redirect it", () => {
    const env = claudeCliEnv({
      ANTHROPIC_AUTH_TOKEN: "sk-a-deepseek-key",
      ANTHROPIC_MODEL: "deepseek-v4-flash",
      ANTHROPIC_BASE_URL: "https://api.anthropic.com",
      PATH: "/usr/bin",
    });
    expect(env["ANTHROPIC_AUTH_TOKEN"]).toBeUndefined();
    expect(env["ANTHROPIC_MODEL"]).toBeUndefined();
    expect(env["ANTHROPIC_BASE_URL"]).toBeUndefined();
  });

  it("deletes rather than blanks them", () => {
    // "" is read as a deliberate override by some tools and as unset by others, and the
    // difference is not worth depending on.
    const env = claudeCliEnv({ ANTHROPIC_API_KEY: "x" });
    expect("ANTHROPIC_API_KEY" in env).toBe(false);
  });

  it("keeps everything else, because the CLI needs a real environment", () => {
    const env = claudeCliEnv({ PATH: "/usr/bin", HOME: "/home/q", DEEPSEEK_BASE_URL: "https://d" });
    expect(env["PATH"]).toBe("/usr/bin");
    expect(env["HOME"]).toBe("/home/q");
    // Not an ANTHROPIC_* variable and harmless to the Claude CLI: the DeepSeek path still needs it.
    expect(env["DEEPSEEK_BASE_URL"]).toBe("https://d");
  });

  it("does not mutate the environment it was given", () => {
    const source = { ANTHROPIC_MODEL: "deepseek-v4-flash" };
    claudeCliEnv(source);
    expect(source.ANTHROPIC_MODEL).toBe("deepseek-v4-flash");
  });

  it("covers the Bedrock and Vertex switches too", () => {
    // Either one sends the CLI to a different provider entirely.
    expect(HIJACKING_ENV_VARS).toContain("CLAUDE_CODE_USE_BEDROCK");
    expect(HIJACKING_ENV_VARS).toContain("CLAUDE_CODE_USE_VERTEX");
  });
});

describe("the command line", () => {
  it("always pins the model and effort explicitly", () => {
    // Inheriting these is how a session silently runs on a different model than the one the
    // behaviour was tuned for. ANTHROPIC_MODEL in this environment is the proof it happens.
    const args = claudeCliArgs({ prompt: "do the thing" });
    expect(args).toContain("--model");
    expect(args[args.indexOf("--model") + 1]).toBe(AUTHORING_MODEL);
    expect(args[args.indexOf("--effort") + 1]).toBe(AUTHORING_EFFORT);
    expect(AUTHORING_MODEL).toBe("claude-sonnet-5");
    expect(AUTHORING_EFFORT).toBe("medium");
  });

  it("puts the prompt last, so no flag can swallow it", () => {
    const args = claudeCliArgs({ prompt: "the prompt", maxTurns: 12 });
    expect(args[args.length - 1]).toBe("the prompt");
  });

  it("asks for streaming output with the verbose flag the CLI requires alongside it", () => {
    const args = claudeCliArgs({ prompt: "p", outputFormat: "stream-json" });
    expect(args).toContain("--verbose");
  });

  it("omits verbose for a single final answer", () => {
    const args = claudeCliArgs({ prompt: "p", outputFormat: "json" });
    expect(args).not.toContain("--verbose");
    expect(args[args.indexOf("--output-format") + 1]).toBe("json");
  });

  it("passes the MCP config and the tool allowlist when given", () => {
    const args = claudeCliArgs({
      prompt: "p",
      mcpConfigPath: "/ws/mcp.json",
      allowedTools: ["mcp__playwright__browser_navigate", "mcp__playwright__browser_click"],
    });
    expect(args[args.indexOf("--mcp-config") + 1]).toBe("/ws/mcp.json");
    expect(args).toContain("mcp__playwright__browser_click");
  });

  it("omits optional flags that were not supplied", () => {
    const args = claudeCliArgs({ prompt: "p" });
    for (const flag of ["--mcp-config", "--allowed-tools", "--resume", "--max-turns"]) {
      expect(args, flag).not.toContain(flag);
    }
  });
});

describe("the Playwright MCP server config", () => {
  const cfg = (o = {}) =>
    playwrightMcpConfig({ outputDir: "/ws/author", ...o }) as {
      mcpServers: { playwright: { command: string; args: string[] } };
    };

  it("asks for typescript codegen, which is the reusable script", () => {
    // The whole reason for using this server rather than driving Playwright directly: the script
    // is a by-product of the successful run, not a reconstruction of it afterwards.
    const args = cfg().mcpServers.playwright.args;
    expect(args[args.indexOf("--codegen") + 1]).toBe("typescript");
  });

  it("isolates the profile, so a session never touches the operator's real cookies", () => {
    expect(cfg().mcpServers.playwright.args).toContain("--isolated");
  });

  it("passes credentials by file, never on the command line", () => {
    // A value in argv is readable by every process on the machine.
    const args = cfg({ secretsPath: "/ws/.secrets.env" }).mcpServers.playwright.args;
    expect(args[args.indexOf("--secrets") + 1]).toBe("/ws/.secrets.env");
    expect(args.join(" ")).not.toMatch(/=.*[0-9]{6}/);
  });

  it("joins allowed origins with a semicolon, as the server expects", () => {
    const args = cfg({ allowedOrigins: ["https://a.example", "https://b.example"] }).mcpServers
      .playwright.args;
    expect(args[args.indexOf("--allowed-origins") + 1]).toBe("https://a.example;https://b.example");
  });

  it("runs headless by default and shows the browser only when asked", () => {
    expect(cfg().mcpServers.playwright.args).toContain("--headless");
    expect(cfg({ headless: false }).mcpServers.playwright.args).not.toContain("--headless");
  });
});
