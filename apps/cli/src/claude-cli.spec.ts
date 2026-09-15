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
  it("preserves DeepSeek proxy configuration while stripping unwanted model and cloud overrides", () => {
    const env = claudeCliEnv({
      ANTHROPIC_AUTH_TOKEN: "sk-a-deepseek-key",
      ANTHROPIC_MODEL: "deepseek-v4-flash",
      ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "claude-sonnet-4-5",
      CLAUDE_CODE_USE_BEDROCK: "1",
      PATH: "/usr/bin",
    });
    expect(env["ANTHROPIC_AUTH_TOKEN"]).toBe("sk-a-deepseek-key");
    expect(env["ANTHROPIC_MODEL"]).toBe("deepseek-v4-flash");
    expect(env["ANTHROPIC_BASE_URL"]).toBe("https://api.deepseek.com/anthropic");
    expect(env["ANTHROPIC_DEFAULT_SONNET_MODEL"]).toBeUndefined();
    expect(env["CLAUDE_CODE_USE_BEDROCK"]).toBeUndefined();
  });

  it("deletes rather than blanks them", () => {
    // "" is read as a deliberate override by some tools and as unset by others, and the
    // difference is not worth depending on.
    const env = claudeCliEnv({ CLAUDE_CODE_USE_BEDROCK: "1" });
    expect("CLAUDE_CODE_USE_BEDROCK" in env).toBe(false);
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

  it("redirects anthropic.com base URL to DeepSeek proxy when authoring with DeepSeek", () => {
    const env = claudeCliEnv({
      ANTHROPIC_MODEL: "deepseek-v4-flash",
      ANTHROPIC_BASE_URL: "https://api.anthropic.com",
    });
    expect(env["ANTHROPIC_BASE_URL"]).toBe("https://api.deepseek.com/anthropic");
  });

  it("defaults base URL to DeepSeek proxy when unset with DeepSeek model", () => {
    const env = claudeCliEnv({
      ANTHROPIC_MODEL: "deepseek-v4-flash",
    });
    expect(env["ANTHROPIC_BASE_URL"]).toBe("https://api.deepseek.com/anthropic");
  });
});

describe("the command line", () => {
  it("never puts the prompt in argv", () => {
    // The prompt embeds a bug report written by someone else. It goes on stdin, so no platform's
    // argv handling -- and no shell -- ever sees it. A report containing `& del ...` was a real
    // command-injection path while this spawned a Windows .cmd through a shell.
    // Asserted exactly, so appending a prompt again fails here rather than in production. Every
    // element is a flag or a value this module chose; there is no slot for a caller's free text.
    expect(claudeCliArgs({ maxTurns: 3, mcpConfigPath: "/ws/mcp.json" })).toEqual([
      "--print",
      "--model",
      AUTHORING_MODEL,
      "--effort",
      "medium",
      "--output-format",
      "stream-json",
      "--verbose",
      "--mcp-config",
      "/ws/mcp.json",
      "--max-turns",
      "3",
    ]);
  });

  it("always pins the model and effort explicitly", () => {
    // Inheriting these is how a session silently runs on a different model than the one the
    // behaviour was tuned for. ANTHROPIC_MODEL in this environment is the proof it happens.
    const args = claudeCliArgs({});
    expect(args).toContain("--model");
    expect(args[args.indexOf("--model") + 1]).toBe(AUTHORING_MODEL);
    expect(args[args.indexOf("--effort") + 1]).toBe(AUTHORING_EFFORT);
    expect(AUTHORING_MODEL).toBe(process.env.ANTHROPIC_MODEL || "deepseek-v4-flash");
    expect(AUTHORING_EFFORT).toBe("medium");
  });

  it("asks for streaming output with the verbose flag the CLI requires alongside it", () => {
    const args = claudeCliArgs({ outputFormat: "stream-json" });
    expect(args).toContain("--verbose");
  });

  it("omits verbose for a single final answer", () => {
    const args = claudeCliArgs({ outputFormat: "json" });
    expect(args).not.toContain("--verbose");
    expect(args[args.indexOf("--output-format") + 1]).toBe("json");
  });

  it("passes the MCP config and the tool allowlist when given", () => {
    const args = claudeCliArgs({
      mcpConfigPath: "/ws/mcp.json",
      allowedTools: ["mcp__playwright__browser_navigate", "mcp__playwright__browser_click"],
    });
    expect(args[args.indexOf("--mcp-config") + 1]).toBe("/ws/mcp.json");
    expect(args).toContain("mcp__playwright__browser_click");
  });

  it("passes strict-mcp-config and tools options when given", () => {
    const args = claudeCliArgs({
      strictMcpConfig: true,
      tools: "",
    });
    expect(args).toContain("--strict-mcp-config");
    expect(args[args.indexOf("--tools") + 1]).toBe("");
  });
  it("omits optional flags that were not supplied", () => {
    const args = claudeCliArgs({});
    for (const flag of ["--mcp-config", "--allowed-tools", "--resume", "--max-turns", "--strict-mcp-config", "--tools"]) {
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

  it("uses persistent user data dir when provided instead of isolated", () => {
    const args = cfg({ userDataDir: "/ws/browser-profile" }).mcpServers.playwright.args;
    expect(args).not.toContain("--isolated");
    expect(args[args.indexOf("--user-data-dir") + 1]).toBe("/ws/browser-profile");
  });

  it("passes credentials by file, never on the command line", () => {
    // A value in argv is readable by every process on the machine.
    const args = cfg({ secretsPath: "/ws/.secrets.env" }).mcpServers.playwright.args;
    expect(args[args.indexOf("--secrets") + 1]).toBe("/ws/.secrets.env");
    expect(args.join(" ")).not.toMatch(/=.*[0-9]{6}/);
  });

  it("does not restrict origins in the browser, because that broke real sites", () => {
    // Passed the one origin an operator named, a session reached www.<site> and then every
    // request to static.<site> — the whole JS and CSS bundle — failed with ERR_BLOCKED_BY_CLIENT.
    // The server's own help says the flag "does not serve as a security boundary" and "does not
    // affect redirects", so it was blocking the target's own stylesheet and protecting nothing.
    const args = cfg({ allowedOrigins: ["https://a.example", "https://b.example"] }).mcpServers
      .playwright.args;
    expect(args).not.toContain("--allowed-origins");
    expect(args.join(" ")).not.toContain("b.example");
  });

  it("launches the browser from the platform's config file only when given one", () => {
    const args = cfg({ browserConfigPath: "/ws/author/browser-config.json" }).mcpServers.playwright.args;
    expect(args[args.indexOf("--config") + 1]).toBe("/ws/author/browser-config.json");
    expect(cfg().mcpServers.playwright.args).not.toContain("--config");
  });

  it("loads the live-view hook into every tab only when given one", () => {
    const args = cfg({ initPage: "/ws/author/live-view.cjs" }).mcpServers.playwright.args;
    expect(args[args.indexOf("--init-page") + 1]).toBe("/ws/author/live-view.cjs");
    expect(cfg().mcpServers.playwright.args).not.toContain("--init-page");
  });

  it("runs headless by default and shows the browser only when asked", () => {
    expect(cfg().mcpServers.playwright.args).toContain("--headless");
    expect(cfg({ headless: false }).mcpServers.playwright.args).not.toContain("--headless");
  });
});

describe("the planning phase has no browser, structurally", () => {
  it("omits the MCP server and the tool allowlist entirely, and disables built-in tools", () => {
    // The enforcement, in one assertion. The planning turn is not asked to refrain from browsing
    // -- it is spawned with no browser to reach for. Instruction alone has already failed here
    // once: brief 1.5.0 told every session to end with a check and one did not, so a rule that
    // matters is structural or it is not a rule.
    const args = claudeCliArgs({
      appendSystemPrompt: "brief",
      strictMcpConfig: true,
      tools: "",
      maxTurns: 2,
      outputFormat: "json",
    });

    expect(args).not.toContain("--mcp-config");
    expect(args).not.toContain("--allowed-tools");
    expect(args).toContain("--strict-mcp-config");
    expect(args[args.indexOf("--tools") + 1]).toBe("");
    expect(args.join(" ")).not.toContain("playwright");
  });

  it("still runs as the operator's deepseek medium login", () => {
    const args = claudeCliArgs({ appendSystemPrompt: "brief", outputFormat: "json" });
    expect(args.join(" ")).toContain(`--model ${AUTHORING_MODEL}`);
    expect(args.join(" ")).toContain("--effort medium");
  });
});
