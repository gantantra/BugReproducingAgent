import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";

/**
 * Spawning the Claude CLI that the operator is already logged into (ADR-0027).
 *
 * Two models do two different jobs in this product, and they are not interchangeable:
 *
 *  - **Claude, `claude-sonnet-5` at `medium` effort**, drives the authoring session — talking to
 *    the operator about the report, and driving Playwright MCP until one run reproduces the bug.
 *    It uses the operator's own logged-in session, so there is no second credential to configure.
 *  - **DeepSeek** analyses the failed runs AFTER an approved batch has produced a report. That is
 *    a measurement question over evidence that already exists, which is what it is for.
 *
 * ## The environment sabotages this, and silently
 *
 * This workspace points `llm.apiKeyEnv` at `ANTHROPIC_AUTH_TOKEN` and keeps the DeepSeek key
 * there, because that is where the key already lived. `ANTHROPIC_MODEL` is likewise set to a
 * DeepSeek model id. Both are correct for the DeepSeek path and both are poison for this one: an
 * inherited environment sends the Claude CLI to Anthropic's endpoint carrying a DeepSeek key and
 * asking for a DeepSeek model.
 *
 * The failure is not a clear "wrong credential" — it comes back as
 * `terminal_reason: "api_error"` with an empty result, which reads like the CLI is broken or the
 * operator is not logged in. Verified on this machine: with the three variables removed the same
 * command returns normally and reports `claude-sonnet-5` in `modelUsage`.
 *
 * So the variables are stripped rather than overridden. Stripping makes the CLI fall back to the
 * operator's own credentials, which is exactly the ask — "whoever is logged into the env".
 */

/**
 * Variables that must not reach the spawned CLI.
 *
 * Each one individually redirects it somewhere it should not go. They are removed, never set to
 * an empty string: some tools treat "" as a deliberate override and others as unset, and the
 * difference is not worth depending on.
 */
export const HIJACKING_ENV_VARS: readonly string[] = [
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_SMALL_FAST_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
];

/** The model and effort this product uses for authoring. Not configurable by accident. */
export const AUTHORING_MODEL = "claude-sonnet-5";
export const AUTHORING_EFFORT = "medium";

/**
 * The environment for a spawned `claude`, with everything that would redirect it removed.
 *
 * Takes and returns a plain object so it can be tested without touching `process.env`.
 */
export function claudeCliEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...source };
  for (const name of HIJACKING_ENV_VARS) delete env[name];
  return env;
}

export interface ClaudeCliArgsOptions {
  /** The task, as the operator's own words plus whatever context the harness adds. */
  prompt: string;
  /** Absolute path to an MCP server config, normally the Playwright MCP one. */
  mcpConfigPath?: string;
  /** Exact tool names the session may use. Omitted means the CLI's own defaults apply. */
  allowedTools?: readonly string[];
  /** Appended to the CLI's system prompt: the authoring instructions. */
  appendSystemPrompt?: string;
  /** Hard ceiling on agent turns, so a confused session ends rather than circling. */
  maxTurns?: number;
  /** `stream-json` to follow the session live; `json` for a single final answer. */
  outputFormat?: "json" | "stream-json";
  /** Resume a session by id, for answering a question mid-authoring. */
  resume?: string;
}

/**
 * Build the argv for one `claude` invocation.
 *
 * Separate from spawning so the exact command can be asserted in a test. The model and effort are
 * always passed explicitly: inheriting them is how this ends up on a different model than the one
 * the behaviour was tuned for, and `ANTHROPIC_MODEL` in this very environment is the proof that
 * inheriting is not hypothetical.
 */
export function claudeCliArgs(opts: ClaudeCliArgsOptions): string[] {
  const args = [
    "--print",
    "--model",
    AUTHORING_MODEL,
    "--effort",
    AUTHORING_EFFORT,
    "--output-format",
    opts.outputFormat ?? "stream-json",
  ];

  // stream-json output is only meaningful as it arrives; without this the CLI refuses the combination.
  if ((opts.outputFormat ?? "stream-json") === "stream-json") args.push("--verbose");
  if (opts.resume) args.push("--resume", opts.resume);
  if (opts.mcpConfigPath) args.push("--mcp-config", opts.mcpConfigPath);
  if (opts.allowedTools?.length) args.push("--allowed-tools", ...opts.allowedTools);
  if (opts.appendSystemPrompt) args.push("--append-system-prompt", opts.appendSystemPrompt);
  if (opts.maxTurns !== undefined) args.push("--max-turns", String(opts.maxTurns));

  args.push(opts.prompt);
  return args;
}

/**
 * The Playwright MCP server config the authoring session is given.
 *
 * `--codegen typescript` is the point of using this server rather than driving Playwright
 * directly: it emits the script as it goes, so the reusable artefact is a by-product of the
 * successful run rather than something reconstructed from it afterwards.
 *
 * `--isolated` keeps the profile in memory, so an authoring session never inherits or leaves
 * behind the operator's real cookies. `--secrets` is how a credential reaches the page without
 * ever entering a prompt: the file holds `NAME=value` and the model only ever names it.
 */
export function playwrightMcpConfig(opts: {
  outputDir: string;
  secretsPath?: string;
  allowedOrigins?: readonly string[];
  headless?: boolean;
}): unknown {
  const args = [
    "-y",
    "@playwright/mcp@0.0.80",
    "--isolated",
    "--codegen",
    "typescript",
    "--save-session",
    "--output-dir",
    opts.outputDir,
  ];
  if (opts.headless !== false) args.push("--headless");
  if (opts.secretsPath) args.push("--secrets", opts.secretsPath);
  // Not a security boundary — the server's own help says so, and redirects bypass it. It is a
  // guard rail that keeps an exploring session on the target the operator named.
  if (opts.allowedOrigins?.length) {
    args.push("--allowed-origins", opts.allowedOrigins.join(";"));
  }
  return { mcpServers: { playwright: { command: "npx", args } } };
}

/**
 * Locate the `claude` binary, or report that it is absent.
 *
 * Returns null rather than throwing: "the CLI is not installed" is a configuration answer the
 * operator can act on, and `doctor` should be able to report it without failing.
 */
export function findClaudeCli(env: NodeJS.ProcessEnv = process.env): string | null {
  const onPath = (env["PATH"] ?? "").split(delimiter).filter(Boolean);
  const names = process.platform === "win32" ? ["claude.cmd", "claude.exe", "claude"] : ["claude"];
  for (const dir of onPath) {
    for (const name of names) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}
