import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXIT } from "@investigator/core";

/**
 * CLI end-to-end tests, run against the BUILT binary rather than the source, so the packaging
 * and the bin entry point are covered too.
 */

const CLI = join(process.cwd(), "apps", "cli", "dist", "bin.js");

interface Run {
  status: number;
  stdout: string;
  stderr: string;
}

function invoke(args: string[], cwd: string, env: Record<string, string> = {}): Run {
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], {
      cwd,
      encoding: "utf8",
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, stdout, stderr: "" };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { status: err.status ?? -1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "investigator-e2e-"));
});

afterAll(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* disposable */
  }
});

describe("investigate CLI", () => {
  it("the built binary exists (run `npm run build` first)", () => {
    expect(existsSync(CLI), `${CLI} not found`).toBe(true);
  });

  it("--help lists the full frozen command contract", () => {
    const r = invoke(["--help"], dir);
    expect(r.status).toBe(0);
    for (const cmd of [
      "init",
      "intake",
      "plan",
      "approve",
      "run",
      "classify",
      "suite",
      "frequency",
      "minimize",
      "revalidate",
      "report",
      "export",
    ]) {
      expect(r.stdout, `--help omits ${cmd}`).toContain(cmd);
    }
  });

  it("--help states the governing principle", () => {
    const r = invoke(["--help"], dir);
    expect(r.stdout).toContain("Playwright produces evidence");
    expect(r.stdout).toContain("Humans authorize consequential transitions");
  });

  it("offers no flag that could bypass an approval gate", () => {
    const r = invoke(["--help"], dir);
    expect(r.stdout).not.toContain("--yes");
    expect(r.stdout).not.toContain("--force-approve");
    expect(r.stdout).not.toMatch(/--auto\b/);
  });

  it("init creates a usable workspace and is idempotent", () => {
    const first = invoke(["init", "--json"], dir);
    expect(first.status).toBe(EXIT.OK);
    const parsed = JSON.parse(first.stdout) as {
      ok: boolean;
      configWritten: boolean;
      schemaVersion: number;
      workspace: string;
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.configWritten).toBe(true);
    expect(parsed.schemaVersion).toBeGreaterThanOrEqual(1);
    expect(existsSync(join(dir, ".investigator", "investigator.db"))).toBe(true);
    expect(existsSync(join(dir, ".investigator", "config.yaml"))).toBe(true);
    expect(existsSync(join(dir, ".investigator", "policies", "default.yaml"))).toBe(true);

    // Re-running must not overwrite config.yaml.
    const configPath = join(dir, ".investigator", "config.yaml");
    writeFileSync(configPath, readFileSync(configPath, "utf8") + "\n# operator edit\n");
    const second = invoke(["init", "--json"], dir);
    expect(second.status).toBe(EXIT.OK);
    expect((JSON.parse(second.stdout) as { configWritten: boolean }).configWritten).toBe(false);
    expect(readFileSync(configPath, "utf8")).toContain("# operator edit");
  });

  it("doctor reports state without printing any secret material", () => {
    const r = invoke(["doctor", "--json"], dir, {
      DEEPSEEK_API_KEY: "sk-must-not-appear-in-output-123456",
      DEEPSEEK_BASE_URL: "https://api.example.invalid/v1",
      DEEPSEEK_FAST_MODEL: "m1",
      DEEPSEEK_REASONING_MODEL: "m2",
      DEEPSEEK_FALLBACK_MODEL: "m3",
    });
    expect(r.status).toBe(EXIT.OK);

    const combined = r.stdout + r.stderr;
    expect(combined).not.toContain("sk-must-not-appear-in-output-123456");

    const parsed = JSON.parse(r.stdout) as {
      config: {
        apiKeyConfigured: boolean;
        apiKeyEnv: string;
        baseUrlHost: string;
        journalMode: string;
      };
      redaction: { policyId: string; mode: string };
    };
    // The variable NAME and the fact it is configured are safe and useful. The value is not.
    expect(parsed.config.apiKeyEnv).toBe("DEEPSEEK_API_KEY");
    expect(parsed.config.apiKeyConfigured).toBe(true);
    expect(parsed.config.baseUrlHost).toBe("api.example.invalid");
    expect(parsed.config.journalMode).toBe("wal");
    expect(parsed.redaction.policyId).toBe("default");
    expect(parsed.redaction.mode).toBe("strict");
  });

  it("doctor works with no API key present at all", () => {
    const env = {
      DEEPSEEK_BASE_URL: "https://api.example.invalid/v1",
      DEEPSEEK_FAST_MODEL: "m1",
      DEEPSEEK_REASONING_MODEL: "m2",
      DEEPSEEK_FALLBACK_MODEL: "m3",
      DEEPSEEK_API_KEY: "",
    };
    const r = invoke(["doctor", "--json"], dir, env);
    expect(r.status).toBe(EXIT.OK);
    expect(
      (JSON.parse(r.stdout) as { config: { apiKeyConfigured: boolean } }).config.apiKeyConfigured
    ).toBe(false);
  });

  it("unimplemented commands exit 1 and name their milestone", () => {
    const env = {
      DEEPSEEK_BASE_URL: "https://api.example.invalid/v1",
      DEEPSEEK_FAST_MODEL: "m1",
      DEEPSEEK_REASONING_MODEL: "m2",
      DEEPSEEK_FALLBACK_MODEL: "m3",
    };
    for (const [args, milestone] of [
      [["intake", "--from", "x.md"], "M2"],
      [["plan"], "M3"],
      [["approve", "experiment_selection"], "M2"],
      [["classify"], "M4"],
      [["minimize"], "M6"],
      [["report"], "M7"],
      [["export"], "M7"],
    ] as Array<[string[], string]>) {
      const r = invoke([...args, "--json"], dir, env);
      expect(r.status, `${args[0]} should exit 1`).toBe(EXIT.USAGE);
      const out = JSON.parse(r.stdout) as { code: string; message: string };
      expect(out.code).toBe("NOT_IMPLEMENTED");
      expect(out.message, `${args[0]} should name its milestone`).toContain(milestone);
    }
  });

  it("run without an approved experiment exits GATE_REQUIRED", () => {
    const r = invoke(["run", "--json"], dir, {
      DEEPSEEK_BASE_URL: "https://api.example.invalid/v1",
      DEEPSEEK_FAST_MODEL: "m1",
      DEEPSEEK_REASONING_MODEL: "m2",
      DEEPSEEK_FALLBACK_MODEL: "m3",
    });
    expect(r.status).toBe(EXIT.GATE_REQUIRED);
    expect((JSON.parse(r.stdout) as { code: string }).code).toBe("GATE_REQUIRED");
  });

  it("refuses to run with Playwright protocol logging enabled", () => {
    const r = invoke(["doctor", "--json"], dir, {
      DEBUG: "pw:api",
      DEEPSEEK_BASE_URL: "https://api.example.invalid/v1",
      DEEPSEEK_FAST_MODEL: "m1",
      DEEPSEEK_REASONING_MODEL: "m2",
      DEEPSEEK_FALLBACK_MODEL: "m3",
    });
    expect(r.status).toBe(EXIT.USAGE);
    const out = JSON.parse(r.stdout) as { code: string; message: string };
    expect(out.code).toBe("CONFIG_INVALID");
    expect(out.message).toContain("unredacted");

    // The escape hatch works, and marks the session.
    const allowed = invoke(["doctor", "--json", "--allow-unsafe-debug"], dir, {
      DEBUG: "pw:api",
      DEEPSEEK_BASE_URL: "https://api.example.invalid/v1",
      DEEPSEEK_FAST_MODEL: "m1",
      DEEPSEEK_REASONING_MODEL: "m2",
      DEEPSEEK_FALLBACK_MODEL: "m3",
    });
    expect(allowed.status).toBe(EXIT.OK);
    expect(
      (JSON.parse(allowed.stdout) as { safety: { unsafeDiagnostics: boolean } }).safety
        .unsafeDiagnostics
    ).toBe(true);
  });

  it("reports a missing workspace as WORKSPACE_NOT_FOUND", () => {
    const empty = mkdtempSync(join(tmpdir(), "investigator-empty-"));
    try {
      const r = invoke(["doctor", "--json"], empty);
      expect(r.status).toBe(EXIT.USAGE);
      expect((JSON.parse(r.stdout) as { code: string }).code).toBe("WORKSPACE_NOT_FOUND");
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
