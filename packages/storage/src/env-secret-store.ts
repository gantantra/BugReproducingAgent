import { Secret, fail } from "@investigator/core";
import type { SecretStore } from "./interfaces.js";

/**
 * Environment-only SecretStore (frozen decision 6).
 *
 * `DEEPSEEK_API_KEY` is read from the environment, wrapped in a `Secret` that refuses to
 * serialise itself, and never persisted, logged, or written to an artifact. `has()` exists so
 * callers can report configuration state without touching a value.
 */
export class EnvSecretStore implements SecretStore {
  private readonly env: NodeJS.ProcessEnv;
  /** Optional allowlist. Prevents a bug from turning this into a general env-var reader. */
  private readonly allowed?: ReadonlySet<string>;

  constructor(env: NodeJS.ProcessEnv = process.env, allowedNames?: readonly string[]) {
    this.env = env;
    if (allowedNames) this.allowed = new Set(allowedNames);
  }

  private assertAllowed(name: string): void {
    if (!/^[A-Z][A-Z0-9_]*$/.test(name)) {
      fail("INPUT_INVALID", "Secret name is not a valid environment variable name", {
        context: { name },
      });
    }
    if (this.allowed && !this.allowed.has(name)) {
      fail("INPUT_INVALID", "Secret name is not in the configured allowlist", {
        context: { name },
      });
    }
  }

  async has(name: string): Promise<boolean> {
    this.assertAllowed(name);
    const v = this.env[name];
    return typeof v === "string" && v.length > 0;
  }

  async reveal(name: string): Promise<Secret> {
    this.assertAllowed(name);
    const v = this.env[name];
    if (typeof v !== "string" || v.length === 0) {
      // Names the variable, never a value.
      fail("CONFIG_ENV_UNRESOLVED", `Secret ${name} is not set in the environment`, {
        context: { variable: name },
      });
    }
    return new Secret(name, v);
  }
}
