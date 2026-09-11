import { describe, it, expect } from "vitest";
import {
  isEnvRef,
  llmConfigStatus,
  loadConfigFromString,
  resolveLlmSettings,
} from "./config.js";
import { isInvestigatorError } from "./errors.js";

/**
 * Config loader (M1-AT-1).
 *
 * The point of strictness here: a typo in a safety field must not silently disable the safety
 * field, so an unknown key is an error rather than a warning (ADR-0015).
 */

const ENV = {
  DEEPSEEK_BASE_URL: "https://api.example.invalid/v1",
  DEEPSEEK_FAST_MODEL: "m-fast",
  DEEPSEEK_REASONING_MODEL: "m-reason",
  DEEPSEEK_FALLBACK_MODEL: "m-fallback",
};

/**
 * `exec` and `safety` are injected into their own sections. Appending everything at the end of
 * the document silently reparents it under the last key, which strict validation then rejects
 * for the wrong reason.
 */
function yaml(exec = "", safety = ""): string {
  return `
llm:
  provider: deepseek
  baseUrl: env:DEEPSEEK_BASE_URL
  apiKeyEnv: DEEPSEEK_API_KEY
  aliases:
    FAST_MODEL: { modelId: env:DEEPSEEK_FAST_MODEL, inferenceMode: non-thinking }
    REASONING_MODEL: { modelId: env:DEEPSEEK_REASONING_MODEL, inferenceMode: thinking }
    FALLBACK_MODEL: { modelId: env:DEEPSEEK_FALLBACK_MODEL, inferenceMode: non-thinking }
  budgets: { perInvestigationUsd: 5, perCallTokens: 32000 }
storage:
  metadata: sqlite
  artifacts: local
  queue: local
  redactionPolicy: policies/default.yaml
execution:
  browser: chromium
  workers: 1
  maxParallelRuns: 1
  targets:
    fix:
      baseUrl: http://127.0.0.1:9999
      classification: fixture
${exec}
approvals:
  required: [experiment_selection, target_failure, final_reproduction]
safety:
  allowedOrigins:
    - http://127.0.0.1:9999
${safety}
`;
}

function load(
  exec = "",
  env: Record<string, string> = ENV
): ReturnType<typeof loadConfigFromString> {
  return loadConfigFromString(yaml(exec), { env: env as NodeJS.ProcessEnv });
}

function codeOf(fn: () => unknown): string {
  try {
    fn();
    return "NO_ERROR";
  } catch (e) {
    return isInvestigatorError(e) ? e.code : "UNTYPED";
  }
}

describe("config loader", () => {
  it("resolves env: references outside the AI subtree, and never embeds a secret", () => {
    const cfg = load();
    // apiKeyEnv is a NAME, never resolved into the config object.
    expect(cfg.llm.apiKeyEnv).toBe("DEEPSEEK_API_KEY");
    expect(JSON.stringify(cfg)).not.toContain("sk-");
  });

  it("defers the AI subtree at load and resolves it only on demand", () => {
    // Decision 6: no deterministic command reads llm.*, so requiring DEEPSEEK_* before a browser
    // run was a false dependency that made `investigate run` fail on a fresh workspace.
    const cfg = load();
    expect(isEnvRef(cfg.llm.baseUrl), "llm.baseUrl stays an env: marker at load").toBe(true);
    expect(isEnvRef(cfg.llm.aliases.FAST_MODEL.modelId)).toBe(true);

    // Resolution is explicit, and yields the real values.
    const resolved = resolveLlmSettings(cfg, ENV as unknown as NodeJS.ProcessEnv);
    expect(resolved.baseUrl).toBe(ENV.DEEPSEEK_BASE_URL);
    expect(resolved.aliases.FAST_MODEL.modelId).toBe("m-fast");
  });

  it("loads with NO AI variables set at all, and reports them as missing", () => {
    const cfg = load("", { PATH: "x" });
    const status = llmConfigStatus(cfg, { PATH: "x" } as NodeJS.ProcessEnv);
    expect(status.state).toBe("missing");
    expect(status.apiKeyConfigured).toBe(false);
    expect(status.missingVars).toContain("DEEPSEEK_API_KEY");
    // Names only. A status report must never carry a value.
    expect(JSON.stringify(status)).not.toContain("sk-");
  });

  it("fails typed, naming variables and not values, when an AI operation needs them", () => {
    const cfg = load("", { PATH: "x" });
    try {
      resolveLlmSettings(cfg, { PATH: "x" } as NodeJS.ProcessEnv);
      throw new Error("expected a failure");
    } catch (e) {
      expect(isInvestigatorError(e)).toBe(true);
      if (isInvestigatorError(e)) {
        expect(e.code).toBe("CONFIG_ENV_UNRESOLVED");
        expect(e.message).toContain("DEEPSEEK_BASE_URL");
        expect(e.message).not.toContain("sk-");
      }
    }
  });

  it("applies built-in defaults and records their source", () => {
    const cfg = load();
    expect(cfg.execution.leaseMs).toBe(60000);
    expect(cfg.execution.heartbeatMs).toBe(10000);
    expect(cfg.execution.capture.tracePolicy).toBe("withhold");
    expect(cfg.execution.video).toBe("on-failure");
    expect(cfg.storage.sqlite.journalMode).toBe("wal");
    expect(cfg.sources["execution.leaseMs"]?.source).toBe("built-in-default");
    // llm.baseUrl is deferred, so it has no resolved source at load time. Its source is
    // recorded when resolveLlmSettings runs, which is the only place the value exists.
    expect(cfg.sources["llm.baseUrl"]?.source).not.toBe("env");
  });

  it("rejects an unknown key rather than ignoring it", () => {
    expect(codeOf(() => load("  allowedOrigns: []"))).toBe("CONFIG_INVALID");
    expect(codeOf(() => load("  maxRunsPerInvestigaton: 10"))).toBe("CONFIG_INVALID");
  });

  it("names the variable when a NON-deferred env: reference is unresolvable", () => {
    // execution.channel is not in the deferred subtree, so it must still fail at load:
    // deferring anything the executor needs would move a load-time failure into a run.
    try {
      load("\n  channel: env:REPROAGENT_CHANNEL");
      throw new Error("expected a failure");
    } catch (e) {
      expect(isInvestigatorError(e)).toBe(true);
      if (isInvestigatorError(e)) {
        expect(e.code).toBe("CONFIG_ENV_UNRESOLVED");
        expect(e.message).toContain("REPROAGENT_CHANNEL");
        expect(e.context["variable"]).toBe("REPROAGENT_CHANNEL");
      }
    }
  });

  it("rejects logging.redactLogs false", () => {
    // The base document has no `logging` block, so append a real one. The field exists solely
    // so that an attempt to disable redaction fails loudly rather than being accepted.
    const bad = yaml() + "\nlogging:\n  level: info\n  redactLogs: false\n";
    expect(codeOf(() => loadConfigFromString(bad, { env: ENV as NodeJS.ProcessEnv }))).toBe(
      "CONFIG_INVALID"
    );
    // And the same document with the field left at its only permitted value loads.
    const ok = yaml() + "\nlogging:\n  level: info\n  redactLogs: true\n";
    expect(loadConfigFromString(ok, { env: ENV as NodeJS.ProcessEnv }).logging.redactLogs).toBe(
      true
    );
  });

  it("rejects logging.disableCrashDumps false", () => {
    const bad = yaml() + "\nlogging:\n  disableCrashDumps: false\n";
    expect(codeOf(() => loadConfigFromString(bad, { env: ENV as NodeJS.ProcessEnv }))).toBe(
      "CONFIG_INVALID"
    );
  });

  it("rejects a non-WAL journal mode", () => {
    expect(
      codeOf(() =>
        loadConfigFromString(
          yaml().replace(
            "  redactionPolicy:",
            "  sqlite: { journalMode: delete }\n  redactionPolicy:"
          ),
          { env: ENV as NodeJS.ProcessEnv }
        )
      )
    ).toBe("CONFIG_INVALID");
  });

  it("rejects heartbeatMs >= leaseMs / 3", () => {
    expect(codeOf(() => load("  leaseMs: 9000\n  heartbeatMs: 3000").execution)).toBe(
      "CONFIG_INVALID"
    );
    // Just under the boundary is fine.
    expect(load("  leaseMs: 9000\n  heartbeatMs: 2999").execution.heartbeatMs).toBe(2999);
  });

  it("rejects maxParallelRuns above worker capacity", () => {
    expect(codeOf(() => load("  perWorkerConcurrency: 1\n  maxParallelRuns: 4"))).toBe(
      "CONFIG_INVALID"
    );
  });

  it("rejects a target whose origin is not in safety.allowedOrigins", () => {
    const bad = yaml().replace("http://127.0.0.1:9999\n", "http://127.0.0.1:1111\n");
    expect(codeOf(() => loadConfigFromString(bad, { env: ENV as NodeJS.ProcessEnv }))).toBe(
      "CONFIG_INVALID"
    );
  });

  it("rejects a production classification outright", () => {
    const bad = yaml().replace("classification: fixture", "classification: production");
    expect(codeOf(() => loadConfigFromString(bad, { env: ENV as NodeJS.ProcessEnv }))).toBe(
      "CONFIG_INVALID"
    );
  });

  it("rejects an origin matching productionOriginPatterns", () => {
    // Belongs under `safety`, not `execution`.
    const bad = yaml("", '  productionOriginPatterns: ["127\\\\.0\\\\.0\\\\.1"]');
    expect(codeOf(() => loadConfigFromString(bad, { env: ENV as NodeJS.ProcessEnv }))).toBe(
      "CONFIG_INVALID"
    );
  });

  it("rejects fewer than the three mandatory gates", () => {
    const bad = yaml().replace(
      "required: [experiment_selection, target_failure, final_reproduction]",
      "required: [experiment_selection]"
    );
    expect(codeOf(() => loadConfigFromString(bad, { env: ENV as NodeJS.ProcessEnv }))).toBe(
      "CONFIG_INVALID"
    );
  });

  it("rejects the unimplemented trace pipeline with a message naming the ADR", () => {
    try {
      load("  capture:\n    tracePolicy: redacted-pipeline");
      throw new Error("expected a failure");
    } catch (e) {
      expect(isInvestigatorError(e) && e.code).toBe("CONFIG_INVALID");
      expect(
        String((e as Error).message) + JSON.stringify((e as never as { context: unknown }).context)
      ).toContain("ADR-0022");
    }
  });

  it("rejects an unimplemented storage adapter", () => {
    const bad = yaml().replace("metadata: sqlite", "metadata: postgres");
    expect(codeOf(() => loadConfigFromString(bad, { env: ENV as NodeJS.ProcessEnv }))).toBe(
      "CONFIG_INVALID"
    );
  });

  it("CLI overrides take precedence over env and file, and record their source", () => {
    const cfg = loadConfigFromString(yaml(), {
      env: ENV as NodeJS.ProcessEnv,
      overrides: { "execution.seed": 4242 },
    });
    expect(cfg.execution.seed).toBe(4242);
    expect(cfg.sources["execution.seed"]?.source).toBe("cli-flag");
  });

  it("supplies the three built-in emulation profiles with concrete values", () => {
    const cfg = load();
    expect(Object.keys(cfg.execution.emulation.profiles).sort()).toEqual([
      "desktop-chrome-1440",
      "low-end-android-throttled",
      "pixel-7-chrome-mobile",
    ]);
    // Materialised, not a Playwright device name: a library upgrade cannot change what the
    // profile meant in a past investigation (ADR-0014).
    const pixel = cfg.execution.emulation.profiles["pixel-7-chrome-mobile"]!;
    expect(pixel.deviceScaleFactor).toBe(2.625);
    expect(pixel.viewport).toEqual({ width: 412, height: 915 });
    expect(pixel.hasTouch).toBe(true);
  });
});
