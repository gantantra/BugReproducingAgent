import { existsSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fail } from "@investigator/core";

/**
 * Workspace layout and discovery.
 *
 * ```
 * .investigator/
 *   investigator.db
 *   config.yaml
 *   prompts/
 *   investigations/
 *     INV-001/
 *       manifests/  normalized/  artifacts/  reports/  reproducer/  approvals/
 * ```
 */

export const WORKSPACE_DIR = ".investigator";

export interface Workspace {
  /** Absolute path to the `.investigator` directory. */
  root: string;
  dbPath: string;
  configPath: string;
  promptsDir: string;
  investigationsDir: string;
  policiesDir: string;
}

export function workspacePaths(root: string): Workspace {
  const abs = resolve(root);
  return {
    root: abs,
    dbPath: join(abs, "investigator.db"),
    configPath: join(abs, "config.yaml"),
    promptsDir: join(abs, "prompts"),
    investigationsDir: join(abs, "investigations"),
    policiesDir: join(abs, "policies"),
  };
}

/** Walk upward from `startDir` looking for an existing `.investigator` directory. */
export function findWorkspace(startDir: string = process.cwd()): Workspace | null {
  let dir = resolve(startDir);
  for (let i = 0; i < 24; i++) {
    const candidate = join(dir, WORKSPACE_DIR);
    if (existsSync(join(candidate, "investigator.db")) || existsSync(join(candidate, "config.yaml"))) {
      return workspacePaths(candidate);
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export function requireWorkspace(startDir: string = process.cwd()): Workspace {
  const ws = findWorkspace(startDir);
  if (!ws) {
    fail("WORKSPACE_NOT_FOUND", `No ${WORKSPACE_DIR} directory found. Run: investigate init`, {
      context: { startDir: resolve(startDir) },
    });
  }
  return ws;
}

/** Restrictive where the platform supports it. Windows inherits ACLs; see the security model. */
function harden(path: string, mode: number): void {
  if (process.platform === "win32") return;
  try {
    chmodSync(path, mode);
  } catch {
    // Best effort. A permissions failure must not stop an investigation.
  }
}

export interface InitResult {
  workspace: Workspace;
  created: boolean;
  configWritten: boolean;
}

export const DEFAULT_CONFIG_YAML = `# Investigator workspace configuration.
#
# Playwright produces evidence. Deterministic software normalizes and measures evidence.
# DeepSeek interprets and prioritizes evidence. Humans authorize consequential transitions.
#
# Any string may use env:NAME to read from the environment. Resolution is strict: an unset
# variable is an error naming the variable, never printing a value.

llm:
  provider: deepseek
  baseUrl: env:DEEPSEEK_BASE_URL
  # A variable NAME, not an env: reference. The key never enters the resolved config object.
  apiKeyEnv: DEEPSEEK_API_KEY
  aliases:
    FAST_MODEL:
      modelId: env:DEEPSEEK_FAST_MODEL
      inferenceMode: non-thinking
    REASONING_MODEL:
      modelId: env:DEEPSEEK_REASONING_MODEL
      inferenceMode: thinking
    FALLBACK_MODEL:
      modelId: env:DEEPSEEK_FALLBACK_MODEL
      inferenceMode: non-thinking
  capabilitiesCacheTtlSeconds: 3600
  budgets:
    perInvestigationUsd: 5
    perCallTokens: 32000

storage:
  metadata: sqlite
  artifacts: local
  queue: local
  redactionPolicy: policies/default.yaml

execution:
  browser: chromium
  workers: 1
  maxParallelRuns: 1
  # M1 default. redacted-pipeline arrives in M8; raw-opt-in is fixture-only (ADR-0022).
  capture:
    tracePolicy: withhold
  targets: {}

approvals:
  required: [experiment_selection, target_failure, final_reproduction]

safety:
  allowedOrigins: []
  productionGuard: true
  blockDestructiveActions: true

logging:
  level: info
`;

/**
 * Create the workspace skeleton. Idempotent: re-running validates and reports, and never
 * overwrites an existing `config.yaml`.
 */
export function initWorkspace(root: string): InitResult {
  const ws = workspacePaths(root);
  const existed = existsSync(ws.root);

  mkdirSync(ws.root, { recursive: true });
  harden(ws.root, 0o700);
  for (const dir of [ws.promptsDir, ws.investigationsDir, ws.policiesDir]) {
    mkdirSync(dir, { recursive: true });
    harden(dir, 0o700);
  }

  let configWritten = false;
  if (!existsSync(ws.configPath)) {
    writeFileSync(ws.configPath, DEFAULT_CONFIG_YAML, "utf8");
    harden(ws.configPath, 0o600);
    configWritten = true;
  }

  return { workspace: ws, created: !existed, configWritten };
}

export interface InvestigationDirs {
  root: string;
  manifests: string;
  normalized: string;
  artifacts: string;
  reports: string;
  reproducer: string;
  approvals: string;
}

export function investigationDirs(ws: Workspace, investigationId: string): InvestigationDirs {
  const root = join(ws.investigationsDir, investigationId);
  return {
    root,
    manifests: join(root, "manifests"),
    normalized: join(root, "normalized"),
    artifacts: join(root, "artifacts"),
    reports: join(root, "reports"),
    reproducer: join(root, "reproducer"),
    approvals: join(root, "approvals"),
  };
}

export function ensureInvestigationDirs(ws: Workspace, investigationId: string): InvestigationDirs {
  const dirs = investigationDirs(ws, investigationId);
  for (const d of Object.values(dirs)) {
    mkdirSync(d, { recursive: true });
    harden(d, 0o700);
  }
  return dirs;
}
