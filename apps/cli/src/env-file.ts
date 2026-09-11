import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Optional `.env` loading for the CLI process.
 *
 * Playwright produces evidence. Deterministic software normalizes and measures evidence. DeepSeek interprets and prioritizes evidence. Humans authorize consequential transitions.
 *
 * This does NOT change where secrets come from. `EnvSecretStore` still reads `process.env` through
 * a name allowlist, and `DEEPSEEK_API_KEY` is still never logged, persisted, or written to an
 * artifact. All this does is let an operator put the variables in a gitignored file instead of
 * re-exporting them in every shell — which on Windows is otherwise required for each new terminal.
 *
 * Three rules, each of them load-bearing:
 *
 *  - The real environment ALWAYS wins. A variable already set is never overwritten, so a stale
 *    file can never silently shadow a deliberate export. That is the classic dotenv footgun and
 *    it is the one that would matter most here, where the shadowed value is a credential.
 *  - `REPROAGENT_NO_ENV_FILE` disables it entirely. The e2e suite and the demo clear every
 *    `DEEPSEEK_*` variable to prove the deterministic path needs no credential; without an opt-out
 *    a developer's local `.env` would quietly restore them and that proof would become a lie.
 *  - Nothing here writes a file. The agent never persists a key; the operator chose to.
 */

export interface LoadEnvFileResult {
  /** Absolute path loaded, or null when there was nothing to load. */
  path: string | null;
  /** Variable NAMES applied to `process.env`. Never values. */
  applied: string[];
  /** Variable NAMES present in the file but left alone because the real environment had them. */
  skipped: string[];
}

const EMPTY: LoadEnvFileResult = { path: null, applied: [], skipped: [] };

/**
 * Parse `.env` content into name/value pairs.
 *
 * Deliberately boring: no interpolation, no command substitution, no multi-line values. A
 * credential file that can execute expressions is a credential file that can surprise you.
 */
export function parseEnvFile(text: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;

    const withoutExport = line.startsWith("export ") ? line.slice("export ".length).trim() : line;
    const eq = withoutExport.indexOf("=");
    if (eq <= 0) continue;

    const name = withoutExport.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue;

    let value = withoutExport.slice(eq + 1).trim();
    const quoted =
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")));
    if (quoted) {
      value = value.slice(1, -1);
    } else {
      // An unquoted trailing comment is a comment. A quoted one is part of the value.
      const hash = value.indexOf(" #");
      if (hash >= 0) value = value.slice(0, hash).trimEnd();
    }

    out.push([name, value]);
  }

  return out;
}

/**
 * Load `<dir>/.env` into `process.env` if it exists, without overwriting anything already set.
 *
 * Returns the NAMES applied and skipped so a caller can report configuration state. No caller
 * ever receives a value from here.
 */
export function loadEnvFile(dir: string = process.cwd(), env: NodeJS.ProcessEnv = process.env) {
  if (env["REPROAGENT_NO_ENV_FILE"]) return EMPTY;

  const path = join(dir, ".env");
  if (!existsSync(path)) return EMPTY;

  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    // An unreadable .env is not a reason to stop deterministic work, and the AI path already
    // fails with a typed error naming the missing variables.
    return EMPTY;
  }

  const applied: string[] = [];
  const skipped: string[] = [];
  for (const [name, value] of parseEnvFile(text)) {
    if (typeof env[name] === "string" && env[name] !== "") {
      skipped.push(name);
      continue;
    }
    env[name] = value;
    applied.push(name);
  }

  return { path, applied, skipped };
}
