import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Secret, fail } from "@investigator/core";
import type { SecretStore } from "./interfaces.js";

/**
 * Test-account credentials the OPERATOR supplied, for flows that cannot proceed without signing
 * in.
 *
 * Why this exists at all. The reporter of an intermittent bug almost always has to be logged in
 * for the bug to happen, so "use the account I gave you" is not an edge case, it is the normal
 * case. Before this store there was no channel for that value: typing it into the bug report put
 * it in `report.body`, where the redaction policy masks it (correctly — a report is a durable
 * artifact), so the credential was destroyed on the way in and the flow was left recording
 * "authentication needed" as a permanent unknown. The data was supplied and then thrown away.
 *
 * What this store is NOT. It is not a general secret manager, not a vault, and not a place for
 * anything that matters. It holds throwaway test-account values on the QA machine that is
 * already driving the browser those values are typed into. `DEEPSEEK_API_KEY` does not live here
 * and cannot: that stays environment-only (frozen decision 6), and `EnvSecretStore` remains the
 * only reader of it.
 *
 * The boundaries that still hold, because they are what make supplying a credential safe:
 *
 *  - **The model never sees a value.** Only NAMES reach a provider, as
 *    `constraints.declaredCredentialEnvVarNames`. A flow references `secretRef: { envVar }`; the
 *    value is resolved at run time, inside the executor, long after any model call.
 *  - **No value reaches an artifact.** Values are registered with the redactor before a batch
 *    starts, so an OTP that lands in a DOM snapshot or a console line is masked like any other
 *    secret.
 *  - **No value reaches argv.** The web UI writes here through the local server directly, never
 *    by spawning a command with the value on a command line, where every process on the machine
 *    could read it.
 *  - **`toString()` is not a leak path.** `reveal()` returns a `Secret`, which refuses to
 *    serialise itself, exactly as the environment path does.
 *
 * Resolution order is file, then environment. The file is what the operator typed most recently;
 * an environment variable they exported months ago should not silently win over it. A QA server
 * that injects credentials through the environment still works — it just has no file.
 */

/** Env-var shaped, so a `secretRef` looks the same wherever the value comes from. */
const CREDENTIAL_NAME = /^[A-Z][A-Z0-9_]*$/;

/** Kept at the workspace root, beside `config.yaml`. `*-workspace/` is gitignored wholesale. */
export const CREDENTIALS_FILENAME = ".credentials.json";

export interface CredentialEntry {
  name: string;
  description?: string;
}

interface CredentialFile {
  schemaVersion: 1 | 2;
  /** name -> value. Values are plain: this is a local convenience, not a vault. */
  credentials: Record<string, string>;
  /** name -> description. Describes what the key is for, for model prompting. */
  descriptions?: Record<string, string>;
}

export class CredentialStore implements SecretStore {
  private readonly path: string;
  private readonly env: NodeJS.ProcessEnv;

  constructor(workspaceRoot: string, env: NodeJS.ProcessEnv = process.env) {
    this.path = join(workspaceRoot, CREDENTIALS_FILENAME);
    this.env = env;
  }

  private static assertName(name: string): void {
    if (!CREDENTIAL_NAME.test(name)) {
      // Names the name, which is safe. Never echoes a value, which is not.
      fail("INPUT_INVALID", "A credential name must be UPPER_SNAKE_CASE, like ACCOUNT_PHONE", {
        context: { name },
      });
    }
  }

  private read(): CredentialFile {
    if (!existsSync(this.path)) return { schemaVersion: 2, credentials: {}, descriptions: {} };
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.path, "utf8"));
    } catch (e) {
      return fail("INPUT_INVALID", "The workspace credential file is not valid JSON", {
        context: { path: this.path },
        cause: e,
      });
    }
    const creds = (parsed as CredentialFile | null)?.credentials;
    if (!creds || typeof creds !== "object") return { schemaVersion: 2, credentials: {}, descriptions: {} };
    const outCreds: Record<string, string> = {};
    for (const [k, v] of Object.entries(creds)) {
      if (CREDENTIAL_NAME.test(k) && typeof v === "string" && v.length > 0) outCreds[k] = v;
    }
    const descs = (parsed as CredentialFile | null)?.descriptions;
    const outDescs: Record<string, string> = {};
    if (descs && typeof descs === "object") {
      for (const [k, v] of Object.entries(descs)) {
        if (CREDENTIAL_NAME.test(k) && typeof v === "string" && v.length > 0) outDescs[k] = v;
      }
    }
    return { schemaVersion: 2, credentials: outCreds, descriptions: outDescs };
  }

  private write(file: CredentialFile): void {
    mkdirSync(dirname(this.path), { recursive: true });
    // Write-then-rename: a crash mid-write leaves the previous file, not a truncated one.
    const tmp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(tmp, this.path);
  }

  /** The declared names, sorted. This is the only thing that may be shown or sent to a model. */
  names(): string[] {
    return Object.keys(this.read().credentials).sort();
  }

  /** The declared entries with names and optional descriptions. */
  entries(): CredentialEntry[] {
    const file = this.read();
    return Object.keys(file.credentials)
      .sort()
      .map((name) => ({
        name,
        ...(file.descriptions?.[name] ? { description: file.descriptions[name] } : {}),
      }));
  }

  /** The declared descriptions map. */
  descriptions(): Record<string, string> {
    return { ...(this.read().descriptions ?? {}) };
  }

  set(name: string, value: string, description?: string): void {
    CredentialStore.assertName(name);
    if (typeof value !== "string" || value.length === 0) {
      fail("INPUT_INVALID", "A credential value must be a non-empty string", { context: { name } });
    }
    const file = this.read();
    file.credentials[name] = value;
    if (description && typeof description === "string" && description.trim().length > 0) {
      file.descriptions = file.descriptions || {};
      file.descriptions[name] = description.trim();
    }
    this.write(file);
  }

  delete(name: string): boolean {
    CredentialStore.assertName(name);
    const file = this.read();
    if (!(name in file.credentials)) return false;
    delete file.credentials[name];
    if (file.descriptions && name in file.descriptions) {
      delete file.descriptions[name];
    }
    this.write(file);
    return true;
  }

  /**
   * Synchronous plain read, for the action interpreter.
   *
   * The interpreter resolves a value mid-action, inside Playwright's call sequence, where there
   * is no await to spend. Returns `undefined` rather than throwing so the caller can produce
   * `EXEC_ACTION_FAILED` naming the variable — which is the error an operator can act on.
   */
  revealSync(name: string): string | undefined {
    if (!CREDENTIAL_NAME.test(name)) return undefined;
    const fromFile = this.read().credentials[name];
    if (fromFile !== undefined) return fromFile;
    const fromEnv = this.env[name];
    return typeof fromEnv === "string" && fromEnv.length > 0 ? fromEnv : undefined;
  }

  /**
   * Every value currently held, for registering with the redactor before a batch runs.
   *
   * This is the one method that returns values in bulk, and it has exactly one caller. Its
   * purpose is to KEEP these values out of artifacts, not to disclose them.
   */
  allValues(): string[] {
    return Object.values(this.read().credentials).filter((v) => v.length > 0);
  }

  async has(name: string): Promise<boolean> {
    return this.revealSync(name) !== undefined;
  }

  async reveal(name: string): Promise<Secret> {
    CredentialStore.assertName(name);
    const v = this.revealSync(name);
    if (v === undefined) {
      fail("CONFIG_ENV_UNRESOLVED", `Credential ${name} is not set for this workspace`, {
        context: { variable: name },
      });
    }
    return new Secret(name, v);
  }
}
