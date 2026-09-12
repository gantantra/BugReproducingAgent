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
 * **The prompt is NOT here.** It goes on stdin, and that is a security property rather than a
 * style choice: the prompt embeds a bug report written by someone else, and a report is exactly
 * the kind of untrusted text that should never become a command-line argument. This spawned a
 * Windows `.cmd` through a shell at first, which concatenates arguments rather than escaping
 * them — a report containing `& del ...` would have run it. Passing the prompt on stdin removes
 * the surface entirely, whatever the platform does with argv.
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

  // No positional prompt. It arrives on stdin -- see the note above.
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

  /* `--allowed-origins` is deliberately NOT passed, and `allowedOrigins` is kept on the options
   * only so callers need not know that.
   *
   * It reads like a safety measure and is not one — the server's own help says it "does not serve
   * as a security boundary" and "does not affect redirects". What it does do is break real sites.
   * Passed the one origin an operator named, a session reached www.<site> and then every request
   * to static.<site> — the entire JS and CSS bundle — failed with ERR_BLOCKED_BY_CLIENT, so the
   * page never rendered and the session stopped to ask about proxy settings. Every real site
   * serves assets from somewhere else: a CDN subdomain, a font host, an image domain.
   *
   * What actually bounds a session is the brief telling it to stay on the target, and the
   * measured re-run enforcing `safety.allowedOrigins` properly — with subdomain matching, which
   * this flag has no notion of. A guard rail that blocks the target's own stylesheet is not
   * protecting anything; it is stopping the operator's site from loading. */
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

  for (const dir of onPath) {
    // The real executable first, wherever it is reachable from this PATH entry.
    //
    // npm puts a `claude.cmd` shim on PATH and the actual binary under its own node_modules. The
    // shim is a batch file, and spawning a batch file requires a shell, which concatenates
    // arguments instead of escaping them. Preferring the binary means no shell is involved at
    // all -- belt to the stdin braces, since neither alone should be what protects this.
    const real = join(dir, "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe");
    if (existsSync(real)) return real;
  }

  const names = process.platform === "win32" ? ["claude.exe", "claude.cmd", "claude"] : ["claude"];
  for (const dir of onPath) {
    for (const name of names) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * The browser tools an authoring session may use, and — more importantly — the ones it may not.
 *
 * Playwright MCP exposes 66 tools. Handing over all of them would not just be loose, it would
 * defeat the deliverable, because several of them let a session make the bug *appear* rather than
 * reproduce it. The emitted script is re-run unattended to measure how often a real application
 * really fails; a script that fakes the failure measures nothing.
 *
 * Refused, each for a specific reason rather than caution:
 *
 *  - `browser_evaluate`, `browser_run_code_unsafe` — arbitrary JavaScript in the page. A session
 *    with these can satisfy any assertion without the application doing anything, and the emitted
 *    script would be `page.evaluate(...)` rather than a user's actions.
 *  - `browser_route`, `browser_unroute`, `browser_network_state_set` — network interception. This
 *    is the dangerous one for this product: a session could stub the failing response and
 *    "reproduce" a bug the server never produced.
 *  - `browser_cookie_set`, `browser_localstorage_set`, `browser_sessionstorage_set`,
 *    `browser_set_storage_state` — injecting state skips the flow that reaches it, and the flow is
 *    what the reporter described.
 *  - `browser_mouse_*_xy` — raw coordinates. They work once and break on a different window size,
 *    which is exactly what a script re-run weeks later will meet.
 *
 * Everything a person can do with a keyboard, a mouse and their eyes is allowed.
 */
export const ALLOWED_PLAYWRIGHT_TOOLS: readonly string[] = [
  // Going places
  "browser_navigate",
  "browser_navigate_back",
  "browser_tabs",
  "browser_resize",
  // Looking
  "browser_snapshot",
  "browser_take_screenshot",
  "browser_console_messages",
  "browser_network_requests",
  "browser_generate_locator",
  // Acting, as a person would
  "browser_click",
  "browser_type",
  "browser_fill_form",
  "browser_press_key",
  "browser_select_option",
  "browser_hover",
  "browser_drag",
  "browser_drop",
  "browser_file_upload",
  "browser_handle_dialog",
  "browser_wait_for",
  // Checking what happened
  "browser_verify_element_visible",
  "browser_verify_text_visible",
  "browser_verify_value",
  "browser_verify_list_visible",
  // Recording the run the operator approves by watching
  "browser_start_video",
  "browser_stop_video",
  "browser_video_chapter",
].map((t) => `mcp__playwright__${t}`);
