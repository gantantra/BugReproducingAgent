import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Optional `deepseek.json` loading, for operators who keep their DeepSeek connection in a file.
 *
 * Playwright produces evidence. Deterministic software normalizes and measures evidence. DeepSeek interprets and prioritizes evidence. Humans authorize consequential transitions.
 *
 * This is the `.env` loader's sibling and follows the same three rules, for the same reasons: the
 * real environment always wins, `REPROAGENT_NO_ENV_FILE` disables it, and nothing here ever
 * writes a file or returns a value to a caller. The key still reaches the provider only through
 * `EnvSecretStore`, wrapped in a `Secret`, and is still never logged, persisted, or written to an
 * artifact.
 *
 * ## Why only half the file is read
 *
 * The DeepSeek console hands out a JSON blob with two different shapes in it:
 *
 * ```
 * standard_openai_compatible:      DEEPSEEK_API_KEY, DEEPSEEK_BASE_URL
 * claude_code_anthropic_compatible: ANTHROPIC_AUTH_TOKEN, ANTHROPIC_BASE_URL, ANTHROPIC_MODEL
 * ```
 *
 * The first is what `DeepSeekProvider` speaks — it calls `${baseUrl}/chat/completions`.
 *
 * The second exists to point *Claude Code itself* at DeepSeek, and applying it here would be
 * actively harmful. This product now runs the operator's own `claude` CLI to author
 * reproductions, and those three variables are precisely what breaks it: `claude` would go to
 * DeepSeek's Anthropic-compatible endpoint asking for a DeepSeek model, instead of using the
 * login the operator already has. That failure arrives as `api_error` with an empty result, which
 * reads like a broken CLI rather than a hijacked one — it cost real time to diagnose once.
 *
 * So the `ANTHROPIC_*` half is ignored, deliberately and permanently. Two providers, two
 * credentials, and the file is only allowed to supply one of them.
 */

export interface LoadDeepSeekResult {
  /** Absolute path loaded, or null when there was nothing to load. */
  path: string | null;
  /** Variable NAMES applied to `process.env`. Never values. */
  applied: string[];
  /** Names present in the file but left alone because the real environment already had them. */
  skipped: string[];
  /** Names deliberately not applied because they would redirect the Claude CLI. */
  refused: string[];
}

const EMPTY: LoadDeepSeekResult = { path: null, applied: [], skipped: [], refused: [] };

/** Names this loader may apply. Anything else in the file is ignored. */
const APPLICABLE = new Set(["DEEPSEEK_API_KEY", "DEEPSEEK_BASE_URL"]);

/**
 * Names that must never be applied from a file, because they redirect the Claude CLI away from
 * the operator's own login. Reported rather than silently dropped, so `doctor` can explain why a
 * variable in the file did not take effect.
 */
const REFUSED = new Set([
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_MODEL",
]);

/** Flatten one level of nesting, so both the top level and the named blocks are seen. */
function collectPairs(doc: unknown): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  if (!doc || typeof doc !== "object") return out;
  for (const [key, value] of Object.entries(doc as Record<string, unknown>)) {
    if (typeof value === "string") {
      out.push([key, value]);
    } else if (value && typeof value === "object" && !Array.isArray(value)) {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (typeof v === "string") out.push([k, v]);
      }
    }
  }
  return out;
}

/** Where to look, in order. An explicit path wins; otherwise the working directory, then home. */
export function deepSeekCredentialCandidates(explicit?: string): string[] {
  if (explicit) return [explicit];
  return [join(process.cwd(), "deepseek.json"), join(homedir(), "deepseek.json")];
}

/**
 * Load a `deepseek.json` into `process.env` without overwriting anything already set.
 *
 * Returns NAMES only. No caller ever receives a value from here.
 */
export function loadDeepSeekCredentials(
  explicitPath?: string,
  env: NodeJS.ProcessEnv = process.env
): LoadDeepSeekResult {
  if (env["REPROAGENT_NO_ENV_FILE"]) return EMPTY;

  const path = deepSeekCredentialCandidates(explicitPath).find((p) => existsSync(p));
  if (!path) return EMPTY;

  let doc: unknown;
  try {
    doc = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    // An unreadable or malformed file is not a reason to stop deterministic work. The AI path
    // already fails with a typed error naming the variables it could not resolve.
    return EMPTY;
  }

  const applied: string[] = [];
  const skipped: string[] = [];
  const refused: string[] = [];

  for (const [name, value] of collectPairs(doc)) {
    if (REFUSED.has(name)) {
      if (!refused.includes(name)) refused.push(name);
      continue;
    }
    if (!APPLICABLE.has(name) || value.length === 0) continue;
    if (typeof env[name] === "string" && env[name] !== "") {
      if (!skipped.includes(name)) skipped.push(name);
      continue;
    }
    env[name] = value;
    if (!applied.includes(name)) applied.push(name);
  }

  return { path, applied, skipped, refused };
}
