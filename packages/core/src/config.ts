import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { fail, InvestigatorError } from "./errors.js";
import { schemaRegistry } from "./schema.js";
import type { SchemaRegistry } from "./schema.js";
import type {
  ConfigSource,
  ConfigSourceEntry,
  ResetStrategy,
  TargetClassification,
  Gate,
} from "./types.js";

/**
 * Config loader.
 *
 * Three properties the rest of the system depends on:
 *  1. Strict. An unknown key is a USAGE error, not a warning — a typo in a safety field must not
 *     silently disable the safety field (ADR-0015).
 *  2. `env:NAME` resolution is strict and reports the variable NAME, never a value.
 *  3. Cross-field assertions JSON Schema cannot express run after schema validation, each with
 *     its own named failure (ADR-0020).
 */

export interface AliasConfig {
  modelId: string;
  inferenceMode: "thinking" | "non-thinking" | "unspecified";
  maxOutputTokensOverride?: number;
  temperatureDefault?: number;
}

export interface TargetConfig {
  baseUrl: string;
  classification: TargetClassification;
  resetStrategy: ResetStrategy;
  resetScriptPath?: string;
  tenantPool?: string[];
  auth?: {
    strategy: "none" | "storageState" | "scriptedLogin";
    credentialEnvVars?: string[];
    storageStatePath?: string;
  };
  correlationHeaderAllowed: boolean;
}

export interface EmulationProfile {
  viewport: { width: number; height: number };
  screen?: { width: number; height: number };
  deviceScaleFactor: number;
  isMobile: boolean;
  hasTouch: boolean;
  maxTouchPoints?: number;
  userAgent?: string;
  locale: string;
  timezoneId: string;
  colorScheme: "light" | "dark" | "no-preference";
  reducedMotion?: "reduce" | "no-preference";
  forcedColors?: "active" | "none";
  network?: {
    profile: string;
    downloadKbps: number;
    uploadKbps: number;
    latencyMs: number;
    offline: boolean;
  } | null;
  cpu?: { throttlingRate: number } | null;
}

export interface ResolvedConfig {
  llm: {
    provider: "deepseek";
    baseUrl: string;
    allowInsecureBaseUrl: boolean;
    /** A variable NAME. Never resolved into the config object (ADR-0009). */
    apiKeyEnv: string;
    aliases: Record<"FAST_MODEL" | "REASONING_MODEL" | "FALLBACK_MODEL", AliasConfig>;
    capabilitiesCacheTtlSeconds: number;
    budgets: { perInvestigationUsd: number; perCallTokens: number };
    prices?: Record<
      string,
      { inputUsdPerMillionTokens: number; outputUsdPerMillionTokens: number }
    >;
    retry: {
      rateLimitAttempts: number;
      timeoutAttempts: number;
      unavailableAttempts: number;
      backoffBaseMs: number;
      backoffCapMs: number;
      breakerOpenMs: number;
      breakerMaxOpenMs: number;
    };
  };
  storage: {
    metadata: "sqlite";
    artifacts: "local";
    queue: "local";
    redactionPolicy: string;
    sqlite: { busyTimeoutMs: number; journalMode: "wal"; synchronous: "FULL" | "NORMAL" };
    retention: { artifactDays: number; keepReproducers: boolean };
  };
  execution: {
    browser: "chromium";
    channel: string | null;
    workers: number;
    maxParallelRuns: number;
    perWorkerConcurrency: number;
    defaultTimeoutMs: number;
    runWallClockBudgetMs: number;
    leaseMs: number;
    heartbeatMs: number;
    seed: number;
    maxInfraRetriesPerRepetition: number;
    video: "off" | "on" | "on-failure";
    trace: "off" | "on" | "on-failure" | "retain-on-failure";
    capture: {
      responseBodyMaxBytes: number;
      responseBodyContentTypes: string[];
      domSnapshotOn: Array<"action" | "navigation" | "failure">;
      domSnapshotMaxBytes: number;
      screenshotOn: Array<"action" | "navigation" | "failure">;
      webSocketFrames: boolean;
      tracePolicy: "redacted-pipeline" | "withhold" | "raw-opt-in";
      correlationHeader: boolean;
    };
    targets: Record<string, TargetConfig>;
    emulation: { defaultProfile: string; profiles: Record<string, EmulationProfile> };
  };
  approvals: { required: Gate[]; approvalDir: string; expiryHours: number };
  safety: {
    allowedOrigins: string[];
    productionOriginPatterns: string[];
    productionGuard: boolean;
    blockDestructiveActions: boolean;
    destructivePatterns: string[];
    maxRepetitionsPerRun: number;
    maxRunsPerInvestigation: number;
    maxWallClockMsPerInvestigation: number;
    minRunsForRate: number;
    unreachabilityBreakerConsecutive: number;
  };
  minimization: { maxRounds: number; repeatPerCandidate: number; retentionFractionTarget: number };
  logging: {
    level: "error" | "warn" | "info" | "debug";
    redactLogs: true;
    disableCrashDumps: true;
  };
  /** Per-leaf effective value and where it came from. Recorded in every run manifest. */
  sources: Record<string, ConfigSourceEntry>;
}

export const DEFAULT_EMULATION_PROFILES: Record<string, EmulationProfile> = {
  "desktop-chrome-1440": {
    viewport: { width: 1440, height: 900 },
    screen: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    isMobile: false,
    hasTouch: false,
    maxTouchPoints: 0,
    locale: "en-IN",
    timezoneId: "Asia/Kolkata",
    colorScheme: "light",
    reducedMotion: "no-preference",
    forcedColors: "none",
    network: null,
    cpu: null,
  },
  "pixel-7-chrome-mobile": {
    viewport: { width: 412, height: 915 },
    screen: { width: 412, height: 915 },
    deviceScaleFactor: 2.625,
    isMobile: true,
    hasTouch: true,
    maxTouchPoints: 5,
    // A CONCRETE Android user agent, materialised (ADR-0014), never templated.
    //
    // Without this the profile inherited Chromium's default UA, which on a Windows host is a
    // desktop Windows string: a "Chrome mobile" run would then advertise desktop to any
    // UA-sniffing application and be served the desktop experience, making the emulation
    // misleading for exactly the class of issue this product investigates.
    //
    // The version is pinned deliberately. ADR-0014 requires a profile to mean the same thing in a
    // future investigation as it did in a past one, so it must not track the installed browser.
    // The manifest records `emulation.browser.browserVersion` separately, so a divergence between
    // the advertised and the actual engine version is always auditable.
    userAgent:
      "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.6099.210 Mobile Safari/537.36",
    locale: "en-IN",
    timezoneId: "Asia/Kolkata",
    colorScheme: "light",
    reducedMotion: "no-preference",
    forcedColors: "none",
    network: null,
    cpu: null,
  },
  "low-end-android-throttled": {
    viewport: { width: 412, height: 915 },
    screen: { width: 412, height: 915 },
    deviceScaleFactor: 2.625,
    isMobile: true,
    hasTouch: true,
    maxTouchPoints: 5,
    locale: "en-IN",
    timezoneId: "Asia/Kolkata",
    colorScheme: "light",
    reducedMotion: "no-preference",
    forcedColors: "none",
    network: {
      profile: "fast-3g",
      downloadKbps: 1600,
      uploadKbps: 750,
      latencyMs: 150,
      offline: false,
    },
    cpu: { throttlingRate: 4 },
  },
};

const DEFAULTS = {
  llm: {
    capabilitiesCacheTtlSeconds: 3600,
    retry: {
      rateLimitAttempts: 4,
      timeoutAttempts: 2,
      unavailableAttempts: 3,
      backoffBaseMs: 1000,
      backoffCapMs: 30000,
      breakerOpenMs: 60000,
      breakerMaxOpenMs: 600000,
    },
  },
  storage: {
    sqlite: { busyTimeoutMs: 5000, journalMode: "wal" as const, synchronous: "FULL" as const },
    retention: { artifactDays: 30, keepReproducers: true },
  },
  execution: {
    channel: null,
    workers: 1,
    maxParallelRuns: 1,
    perWorkerConcurrency: 1,
    defaultTimeoutMs: 30000,
    runWallClockBudgetMs: 180000,
    leaseMs: 60000,
    heartbeatMs: 10000,
    seed: 1,
    maxInfraRetriesPerRepetition: 2,
    video: "on-failure" as const,
    trace: "on" as const,
    capture: {
      responseBodyMaxBytes: 262144,
      responseBodyContentTypes: ["application/json", "text/plain", "text/html"],
      domSnapshotOn: ["action", "navigation", "failure"] as Array<
        "action" | "navigation" | "failure"
      >,
      domSnapshotMaxBytes: 2097152,
      screenshotOn: ["action", "failure"] as Array<"action" | "navigation" | "failure">,
      webSocketFrames: false,
      tracePolicy: "withhold" as const,
      correlationHeader: false,
    },
  },
  approvals: { approvalDir: "approvals", expiryHours: 168 },
  safety: {
    allowedOrigins: [] as string[],
    productionOriginPatterns: [] as string[],
    productionGuard: true,
    // Off by default: the product is deployed to in-house QA servers whose whole job is running a
    // flow hundreds of times against disposable accounts. Turn it on for an environment where an
    // unintended write would matter; the three approval gates are unaffected either way.
    blockDestructiveActions: false,
    destructivePatterns: [
      "(?i)\\bdelete\\b",
      "(?i)\\bremove\\b",
      "(?i)\\bdeactivate\\b",
      "(?i)\\bpurge\\b",
      "(?i)\\brefund\\b",
      "(?i)\\bpay\\b",
      "(?i)\\btransfer\\b",
      "(?i)\\bcancel\\s+(subscription|order|account)\\b",
    ],
    // Sized for a QA batch rather than a demo. 500 refused an enqueue with EXEC_INVESTIGATION_LIMIT
    // at exactly the scale an intermittent bug needs, and two hours stopped a long run mid-flight.
    // These remain caps, not targets: they exist to catch a mistyped --repeat, not to ration runs.
    // What ONE request may set going. The aggregate cap below is deliberately much larger: a QA
    // batch is many bounded runs, not one unbounded one, and a mistyped repeat count should cost
    // a hundred runs at worst rather than the whole ceiling.
    maxRepetitionsPerRun: 100,
    maxRunsPerInvestigation: 10000,
    maxWallClockMsPerInvestigation: 86400000,
    minRunsForRate: 10,
    unreachabilityBreakerConsecutive: 5,
  },
  minimization: { maxRounds: 3, repeatPerCandidate: 40, retentionFractionTarget: 0.8 },
  logging: { level: "info" as const },
};

export interface LoadConfigOptions {
  /** Overrides from CLI flags. Highest precedence. */
  overrides?: Record<string, unknown>;
  env?: NodeJS.ProcessEnv;
  registry?: SchemaRegistry;
}

const ENV_PREFIX = "env:";

/**
 * True when a value is still an unresolved `env:NAME` reference.
 *
 * Deliberately NOT a type predicate: narrowing an already-`string` field to `string` makes the
 * negative branch `never`, which then rejects every legitimate use of the resolved value.
 */
export function isEnvRef(value: unknown): boolean {
  return typeof value === "string" && value.startsWith(ENV_PREFIX);
}

/**
 * Config paths whose `env:` references are resolved on demand rather than at load.
 *
 * Only the AI subtree qualifies: it is the only configuration a deterministic command never
 * reads. Deferring anything the executor needs would move a load-time failure to the middle of a
 * run, which is strictly worse.
 */
function isDeferredEnvPath(path: string): boolean {
  return path === "llm" || path.startsWith("llm.");
}

/**
 * Resolve `env:NAME` strictly. The variable NAME is safe to print; the value never is, so an
 * unresolved reference names the variable and stops.
 */
function resolveEnvRefs(
  node: unknown,
  env: NodeJS.ProcessEnv,
  path: string,
  sources: Record<string, ConfigSourceEntry>,
  defer: (path: string) => boolean = () => false
): unknown {
  if (typeof node === "string") {
    if (node.startsWith(ENV_PREFIX)) {
      // Deferred subtrees keep their `env:NAME` marker. Resolution happens when the dependent
      // operation runs, so a deterministic command never fails on a variable it does not use.
      if (defer(path)) return node;
      const name = node.slice(ENV_PREFIX.length);
      const value = env[name];
      if (value === undefined || value === "") {
        fail(
          "CONFIG_ENV_UNRESOLVED",
          `Environment variable ${name} is not set (referenced at ${path})`,
          {
            context: { variable: name, path },
          }
        );
      }
      sources[path] = { value, source: "env" };
      return value;
    }
    return node;
  }
  if (Array.isArray(node)) {
    return node.map((v, i) => resolveEnvRefs(v, env, `${path}[${i}]`, sources, defer));
  }
  if (node && typeof node === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      out[k] = resolveEnvRefs(v, env, path ? `${path}.${k}` : k, sources, defer);
    }
    return out;
  }
  return node;
}

function setByPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split(".");
  let node = target;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i] as string;
    const existing = node[key];
    if (!existing || typeof existing !== "object" || Array.isArray(existing)) {
      node[key] = {};
    }
    node = node[key] as Record<string, unknown>;
  }
  node[parts[parts.length - 1] as string] = value;
}

function deepMergeDefaults(
  target: Record<string, unknown>,
  defaults: Record<string, unknown>,
  path: string,
  sources: Record<string, ConfigSourceEntry>
): void {
  for (const [key, dflt] of Object.entries(defaults)) {
    const here = path ? `${path}.${key}` : key;
    const current = target[key];
    if (dflt !== null && typeof dflt === "object" && !Array.isArray(dflt)) {
      if (current === undefined) target[key] = {};
      deepMergeDefaults(
        target[key] as Record<string, unknown>,
        dflt as Record<string, unknown>,
        here,
        sources
      );
    } else if (current === undefined) {
      target[key] = dflt;
      if (!sources[here]) {
        sources[here] = {
          value: (Array.isArray(dflt) ? null : (dflt as never)) ?? null,
          source: "built-in-default",
        };
      }
    }
  }
}

function recordLeafSources(
  node: unknown,
  path: string,
  source: ConfigSource,
  sources: Record<string, ConfigSourceEntry>
): void {
  if (node === null || typeof node !== "object") {
    if (path && !sources[path]) {
      const primitive =
        node === null || ["string", "number", "boolean"].includes(typeof node)
          ? (node as never)
          : null;
      sources[path] = { value: primitive, source };
    }
    return;
  }
  if (Array.isArray(node)) {
    if (path && !sources[path]) sources[path] = { value: null, source };
    return;
  }
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    recordLeafSources(v, path ? `${path}.${k}` : k, source, sources);
  }
}

/** Cross-field assertions. Each has a distinct message so a failure names the actual problem. */
export function assertConfigInvariants(cfg: ResolvedConfig): void {
  const fails: string[] = [];

  if (cfg.execution.heartbeatMs >= cfg.execution.leaseMs / 3) {
    fails.push(
      `execution.heartbeatMs (${cfg.execution.heartbeatMs}) must be < execution.leaseMs / 3 (${cfg.execution.leaseMs / 3}) so a single missed heartbeat cannot cause a spurious reap`
    );
  }

  const capacity = cfg.execution.workers * cfg.execution.perWorkerConcurrency;
  if (cfg.execution.maxParallelRuns > capacity) {
    fails.push(
      `execution.maxParallelRuns (${cfg.execution.maxParallelRuns}) exceeds workers * perWorkerConcurrency (${capacity})`
    );
  }

  if (cfg.logging.redactLogs !== true) {
    fails.push("logging.redactLogs cannot be disabled");
  }
  if (cfg.logging.disableCrashDumps !== true) {
    fails.push("logging.disableCrashDumps cannot be disabled");
  }
  if (cfg.storage.sqlite.journalMode !== "wal") {
    fails.push("storage.sqlite.journalMode must be wal (ADR-0002)");
  }

  // Every target origin must be explicitly allowlisted. This is the guard that makes
  // EXEC_ORIGIN_NOT_ALLOWED meaningful rather than vacuous.
  const allowed = new Set(cfg.safety.allowedOrigins.map(normalizeOrigin));
  for (const [name, target] of Object.entries(cfg.execution.targets)) {
    let origin: string;
    try {
      origin = new URL(target.baseUrl).origin;
    } catch {
      fails.push(`execution.targets.${name}.baseUrl is not a valid URL`);
      continue;
    }
    if (!allowed.has(normalizeOrigin(origin))) {
      fails.push(
        `execution.targets.${name} origin ${origin} is not in safety.allowedOrigins. Add it explicitly.`
      );
    }
    if (cfg.safety.productionGuard) {
      for (const pattern of cfg.safety.productionOriginPatterns) {
        if (safeRegex(pattern)?.test(origin)) {
          fails.push(
            `execution.targets.${name} origin ${origin} matches safety.productionOriginPatterns (${pattern}) and is rejected by the production guard`
          );
        }
      }
    }
    // A sequence containing remote-write or destructive actions needs a real reset strategy.
    // Checked statically again at enqueue against the actual actions.
    if (target.classification !== "fixture" && target.resetStrategy === "none") {
      fails.push(
        `execution.targets.${name} is classified ${target.classification} but declares resetStrategy none. Only fixture targets may do that.`
      );
    }
  }

  if (cfg.execution.capture.tracePolicy === "redacted-pipeline") {
    fails.push(
      "execution.capture.tracePolicy redacted-pipeline is designed but not implemented until M8 (ADR-0022). Use withhold, or raw-opt-in on fixture targets."
    );
  }
  if (cfg.execution.capture.tracePolicy === "raw-opt-in") {
    const nonFixture = Object.entries(cfg.execution.targets)
      .filter(([, t]) => t.classification !== "fixture")
      .map(([n]) => n);
    if (nonFixture.length) {
      fails.push(
        `execution.capture.tracePolicy raw-opt-in is permitted only when every target is classified fixture. Offending targets: ${nonFixture.join(", ")} (ADR-0022)`
      );
    }
  }

  const requiredGates: Gate[] = ["experiment_selection", "target_failure", "final_reproduction"];
  for (const g of requiredGates) {
    if (!cfg.approvals.required.includes(g)) {
      fails.push(`approvals.required must contain ${g}. All three gates are mandatory (ADR-0013).`);
    }
  }

  if (cfg.execution.emulation.defaultProfile) {
    if (!cfg.execution.emulation.profiles[cfg.execution.emulation.defaultProfile]) {
      fails.push(
        `execution.emulation.defaultProfile ${cfg.execution.emulation.defaultProfile} is not defined in execution.emulation.profiles`
      );
    }
  }

  // An unresolved `env:` marker cannot be checked for a scheme yet. The same invariant is
  // enforced in `resolveLlmSettings`, which is the only place the real value appears.
  if (
    !cfg.llm.allowInsecureBaseUrl &&
    cfg.llm.baseUrl &&
    !isEnvRef(cfg.llm.baseUrl) &&
    !cfg.llm.baseUrl.startsWith("https:")
  ) {
    fails.push("llm.baseUrl must use https unless llm.allowInsecureBaseUrl is true");
  }

  if (fails.length) {
    throw new InvestigatorError(
      "CONFIG_INVALID",
      `Configuration invariants violated: ${fails[0]}`,
      {
        context: { violationCount: fails.length, violations: fails.join(" | ") },
      }
    );
  }
}

function normalizeOrigin(o: string): string {
  return o.replace(/\/+$/, "").toLowerCase();
}

function safeRegex(pattern: string): RegExp | null {
  try {
    const ci = pattern.startsWith("(?i)");
    return new RegExp(ci ? pattern.slice(4) : pattern, ci ? "i" : "");
  } catch {
    return null;
  }
}

export function loadConfigFromString(
  yamlText: string,
  opts: LoadConfigOptions = {}
): ResolvedConfig {
  const env = opts.env ?? process.env;
  const registry = opts.registry ?? schemaRegistry();

  let raw: unknown;
  try {
    raw = parseYaml(yamlText);
  } catch (e) {
    throw new InvestigatorError("CONFIG_INVALID", "config.yaml is not valid YAML", { cause: e });
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    fail("CONFIG_INVALID", "config.yaml must contain a mapping at the top level");
  }

  const sources: Record<string, ConfigSourceEntry> = {};
  recordLeafSources(raw, "", "config-file", sources);

  // Precedence: CLI flag > env > config file > built-in default. Applied per leaf.
  // The `llm` subtree is resolved LAZILY (decision 6). M1 and every deterministic command --
  // init, run, classify, doctor -- makes no provider call, so requiring DEEPSEEK_* to be set
  // before a browser run is a false dependency: it made `investigate run` fail with
  // CONFIG_ENV_UNRESOLVED on a fresh workspace. Call `resolveLlmSettings` at the point an
  // AI-dependent operation actually needs a value.
  const withEnv = resolveEnvRefs(raw, env, "", sources, isDeferredEnvPath) as Record<
    string,
    unknown
  >;

  for (const [path, value] of Object.entries(opts.overrides ?? {})) {
    if (value === undefined) continue;
    setByPath(withEnv, path, value);
    const primitive =
      value === null || ["string", "number", "boolean"].includes(typeof value)
        ? (value as never)
        : null;
    sources[path] = { value: primitive, source: "cli-flag" };
  }

  // Schema validation BEFORE defaults, so an unknown key is reported against what the user
  // wrote rather than against a merged object they never saw.
  //
  // Re-coded to CONFIG_INVALID: the schema registry raises the generic INPUT_INVALID, but the
  // error taxonomy reserves CONFIG_INVALID for "schema violation, unknown key, cross-field
  // assertion failure", and the CLI contract maps that to exit 1 with a config-shaped message.
  try {
    registry.assert("config.v1.json", withEnv, "config.yaml");
  } catch (e) {
    if (e instanceof InvestigatorError) {
      throw new InvestigatorError("CONFIG_INVALID", e.message, {
        ...(e.subReason !== undefined ? { subReason: e.subReason } : {}),
        context: e.context,
        cause: e,
      });
    }
    throw e;
  }

  deepMergeDefaults(withEnv, DEFAULTS as unknown as Record<string, unknown>, "", sources);

  // Defaults that are not plain leaves.
  const execution = withEnv["execution"] as Record<string, unknown>;
  const emulation = (execution["emulation"] ??= {}) as Record<string, unknown>;
  if (!emulation["profiles"] || Object.keys(emulation["profiles"] as object).length === 0) {
    emulation["profiles"] = DEFAULT_EMULATION_PROFILES;
    sources["execution.emulation.profiles"] = { value: null, source: "built-in-default" };
  }
  if (!emulation["defaultProfile"]) {
    emulation["defaultProfile"] = "desktop-chrome-1440";
    sources["execution.emulation.defaultProfile"] = {
      value: "desktop-chrome-1440",
      source: "built-in-default",
    };
  }
  if (!execution["targets"]) execution["targets"] = {};
  for (const t of Object.values(execution["targets"] as Record<string, Record<string, unknown>>)) {
    t["resetStrategy"] ??= "fresh-context";
    t["correlationHeaderAllowed"] ??= false;
  }

  const logging = (withEnv["logging"] ??= {}) as Record<string, unknown>;
  logging["redactLogs"] ??= true;
  logging["disableCrashDumps"] ??= true;

  const cfg = withEnv as unknown as ResolvedConfig;
  cfg.sources = sources;

  assertConfigInvariants(cfg);
  return cfg;
}

export function loadConfigFile(path: string, opts: LoadConfigOptions = {}): ResolvedConfig {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    throw new InvestigatorError("CONFIG_INVALID", `Cannot read config file`, {
      context: { path },
      cause: e,
    });
  }
  return loadConfigFromString(text, opts);
}
/** Whether the AI configuration can be used, without revealing any value. */
export type LlmConfigState = "configured" | "missing" | "unavailable";

export interface LlmConfigStatus {
  state: LlmConfigState;
  /** Variable NAMES only. Never a value (ADR-0009, security model). */
  missingVars: string[];
  apiKeyEnv: string;
  apiKeyConfigured: boolean;
  baseUrlHost: string | null;
}

/** Every `env:` reference inside the deferred `llm` subtree, as variable NAMES. */
function llmEnvRefs(cfg: ResolvedConfig): Array<{ path: string; variable: string }> {
  const out: Array<{ path: string; variable: string }> = [];
  const walk = (node: unknown, path: string): void => {
    if (isEnvRef(node)) {
      out.push({ path, variable: (node as string).slice(ENV_PREFIX.length) });
      return;
    }
    if (Array.isArray(node)) return node.forEach((v, i) => walk(v, `${path}[${i}]`));
    if (node && typeof node === "object") {
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        walk(v, path ? `${path}.${k}` : k);
      }
    }
  };
  walk(cfg.llm, "llm");
  return out;
}

/**
 * Report whether AI configuration is usable, WITHOUT resolving it and without throwing.
 *
 * `doctor` and any other status surface uses this: a missing DeepSeek variable is a fact to
 * report, not a reason to fail a command that never makes a provider call (decision 6). Only
 * variable names are returned, never values.
 */
export function llmConfigStatus(
  cfg: ResolvedConfig,
  env: NodeJS.ProcessEnv = process.env
): LlmConfigStatus {
  const missingVars = llmEnvRefs(cfg)
    .filter(({ variable }) => {
      const v = env[variable];
      return v === undefined || v === "";
    })
    .map(({ variable }) => variable);

  const apiKeyValue = env[cfg.llm.apiKeyEnv];
  const apiKeyConfigured = apiKeyValue !== undefined && apiKeyValue !== "";
  if (!apiKeyConfigured) missingVars.push(cfg.llm.apiKeyEnv);

  let baseUrlHost: string | null = null;
  if (!isEnvRef(cfg.llm.baseUrl)) {
    try {
      baseUrlHost = new URL(cfg.llm.baseUrl).host;
    } catch {
      baseUrlHost = null;
    }
  } else {
    const resolved = env[(cfg.llm.baseUrl as string).slice(ENV_PREFIX.length)];
    if (resolved) {
      try {
        baseUrlHost = new URL(resolved).host;
      } catch {
        baseUrlHost = null;
      }
    }
  }

  return {
    state: missingVars.length === 0 ? "configured" : "missing",
    missingVars: [...new Set(missingVars)],
    apiKeyEnv: cfg.llm.apiKeyEnv,
    apiKeyConfigured,
    baseUrlHost,
  };
}

/**
 * Resolve the deferred `llm` subtree. Call this ONLY from an AI-dependent operation.
 *
 * Failure is typed and names the missing variables, never their values. This is the single point
 * where the deferred references become real, and therefore the only place the https invariant on
 * a resolved base URL can be enforced.
 */
export function resolveLlmSettings(
  cfg: ResolvedConfig,
  env: NodeJS.ProcessEnv = process.env
): ResolvedConfig["llm"] {
  const refs = llmEnvRefs(cfg);
  const missing = refs
    .filter(({ variable }) => {
      const v = env[variable];
      return v === undefined || v === "";
    })
    .map(({ variable }) => variable);

  if (missing.length) {
    fail(
      "CONFIG_ENV_UNRESOLVED",
      `AI configuration is incomplete: ${missing.join(", ")} not set. ` +
        `Deterministic commands do not need these; this operation does.`,
      { context: { missingVariables: missing.join(","), count: missing.length } }
    );
  }

  const sources: Record<string, ConfigSourceEntry> = {};
  const resolved = resolveEnvRefs(cfg.llm, env, "llm", sources) as ResolvedConfig["llm"];

  if (
    !resolved.allowInsecureBaseUrl &&
    resolved.baseUrl &&
    !resolved.baseUrl.startsWith("https:")
  ) {
    fail("CONFIG_INVALID", "llm.baseUrl must use https unless llm.allowInsecureBaseUrl is true", {
      context: { path: "llm.baseUrl" },
    });
  }

  return resolved;
}
