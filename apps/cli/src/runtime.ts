import { existsSync, readFileSync, copyFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { hostname } from "node:os";
import {
  EXIT,
  Logger,
  SeededRng,
  detectUnsafeDiagnostics,
  fail,
  loadConfigFile,
  systemClock,
  toInvestigatorError,
  workerId as makeWorkerId,
  type ResolvedConfig,
} from "@investigator/core";
import {
  CredentialStore,
  EnvSecretStore,
  LocalArtifactStore,
  SqliteMetadataStore,
  SqliteWorkQueue,
  requireWorkspace,
  type Workspace,
} from "@investigator/storage";
import { Redactor } from "@investigator/evidence";

/**
 * Shared CLI runtime. Opens the workspace, loads and validates config, wires the four storage
 * adapters and the redactor, and runs the startup safety checks.
 */

export interface GlobalOptions {
  workspace?: string;
  investigation?: string;
  json?: boolean;
  verbose?: boolean;
  seed?: number;
  allowUnsafeDebug?: boolean;
}

export interface Runtime {
  workspace: Workspace;
  config: ResolvedConfig;
  metadata: SqliteMetadataStore;
  artifacts: LocalArtifactStore;
  queue: SqliteWorkQueue;
  secrets: EnvSecretStore;
  /** Test-account credentials the operator supplied, for flows that must sign in. */
  credentials: CredentialStore;
  redactor: Redactor;
  logger: Logger;
  workerId: string;
  unsafeDebug: boolean;
  close: () => Promise<void>;
}

/** Resolve the redaction policy path, preferring the workspace copy over the repo default. */
function resolvePolicyPath(ws: Workspace, configured: string): string {
  const candidates = [
    resolve(ws.root, configured),
    resolve(ws.root, "..", configured),
    resolve(process.cwd(), configured),
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  fail("REDACTION_POLICY_MISSING", "Configured redaction policy file not found", {
    context: { configured, searched: candidates.join(" | ") },
  });
}

export async function openRuntime(opts: GlobalOptions): Promise<Runtime> {
  const ws = opts.workspace ? requireWorkspaceAt(opts.workspace) : requireWorkspace(process.cwd());

  const logger = new Logger({
    level: opts.verbose ? "debug" : "info",
    json: opts.json === true,
  });

  // Startup safety: Node can be told to persist unredacted in-process state, which would defeat
  // the redaction boundary. We cannot unset these for the current process, so we detect and
  // report — and refuse outright for Playwright protocol logging (ADR-0008).
  const diagnostics = detectUnsafeDiagnostics();
  let unsafeDebug = false;
  if (diagnostics.unsafe) {
    const isPwDebug = diagnostics.findings.some((f) => f.includes("Playwright protocol logging"));
    if (isPwDebug && opts.allowUnsafeDebug !== true) {
      fail(
        "CONFIG_INVALID",
        "Refusing to run with Playwright protocol logging enabled: it emits unredacted network and DOM content. Unset DEBUG, or pass --allow-unsafe-debug to proceed with the session marked unsafe.",
        { context: { findings: diagnostics.findings.join(" | ") } }
      );
    }
    unsafeDebug = true;
    for (const f of diagnostics.findings) logger.warn("unsafe diagnostics enabled", { finding: f });
  }

  const overrides: Record<string, unknown> = {};
  if (opts.seed !== undefined) overrides["execution.seed"] = opts.seed;

  const config = loadConfigFile(ws.configPath, { overrides });

  const metadata = new SqliteMetadataStore({
    path: ws.dbPath,
    busyTimeoutMs: config.storage.sqlite.busyTimeoutMs,
    synchronous: config.storage.sqlite.synchronous,
  });
  await metadata.migrate();

  const artifacts = new LocalArtifactStore({
    root: ws.investigationsDir,
    metadata,
    clock: systemClock,
  });
  const queue = new SqliteWorkQueue({ store: metadata, clock: systemClock });
  const secrets = new EnvSecretStore(process.env, [config.llm.apiKeyEnv]);
  const credentials = new CredentialStore(ws.root, process.env);
  const redactor = Redactor.fromFile(resolvePolicyPath(ws, config.storage.redactionPolicy));

  const rng = new SeededRng(config.execution.seed);
  const wid = makeWorkerId(hostname(), process.pid, () => rng.nextHex(6));

  return {
    workspace: ws,
    config,
    metadata,
    artifacts,
    queue,
    secrets,
    credentials,
    redactor,
    logger,
    workerId: wid,
    unsafeDebug,
    close: async () => {
      await metadata.close();
    },
  };
}

function requireWorkspaceAt(dir: string): Workspace {
  const abs = resolve(dir);
  const direct = join(abs, ".investigator");
  if (existsSync(join(direct, "config.yaml"))) {
    return {
      root: direct,
      dbPath: join(direct, "investigator.db"),
      configPath: join(direct, "config.yaml"),
      promptsDir: join(direct, "prompts"),
      investigationsDir: join(direct, "investigations"),
      policiesDir: join(direct, "policies"),
    };
  }
  if (existsSync(join(abs, "config.yaml"))) {
    return {
      root: abs,
      dbPath: join(abs, "investigator.db"),
      configPath: join(abs, "config.yaml"),
      promptsDir: join(abs, "prompts"),
      investigationsDir: join(abs, "investigations"),
      policiesDir: join(abs, "policies"),
    };
  }
  return requireWorkspace(abs);
}

/** Copy the repository default policy into a fresh workspace so `init` produces a usable one. */
export function seedDefaultPolicy(ws: Workspace): boolean {
  const dest = join(ws.policiesDir, "default.yaml");
  if (existsSync(dest)) return false;
  const candidates = [
    resolve(process.cwd(), "policies", "default.yaml"),
    resolve(__dirname, "..", "..", "..", "policies", "default.yaml"),
    resolve(__dirname, "..", "..", "..", "..", "policies", "default.yaml"),
  ];
  for (const c of candidates) {
    if (existsSync(c)) {
      mkdirSync(ws.policiesDir, { recursive: true });
      copyFileSync(c, dest);
      return true;
    }
  }
  return false;
}

export function readJsonFile<T>(path: string): T {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch (e) {
    return fail("INPUT_INVALID", "Cannot read or parse input file", {
      context: { path },
      cause: e,
    });
  }
}

/** Uniform error reporting. Exit codes are part of the CLI contract. */
export function reportAndExit(e: unknown, logger: Logger, json: boolean): never {
  const err = toInvestigatorError(e);
  if (json) {
    process.stdout.write(JSON.stringify({ ok: false, ...err.toJSON() }) + "\n");
  } else {
    logger.failure(err);
  }
  process.exit(err.exitCode);
}

export function emit(value: unknown, json: boolean, human: () => string): void {
  if (json) process.stdout.write(JSON.stringify(value) + "\n");
  else process.stdout.write(human() + "\n");
}

export const EXIT_CODES = EXIT;
