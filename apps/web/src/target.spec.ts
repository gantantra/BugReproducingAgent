import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";

import { ParamError } from "./actions.js";
import { readTargets, validateTargetRequest, writeTarget } from "./target.js";

/**
 * Recording a target is the one place the web layer writes CONFIGURATION, so it has two jobs it
 * must not get wrong: refuse a decision the human has to make, and leave the rest of a file that a
 * human also edits exactly as it was.
 *
 * The second is not cosmetic. A parse/stringify round trip silently deleted every comment in the
 * file and re-emitted `video: "on"` unquoted -- and bare `on` is boolean true under YAML 1.1, so
 * the value reads correctly today and flips under a different parser.
 */

const ORIGINAL = `llm:
  provider: deepseek
  # A variable NAME, not an env: reference. The key never enters the resolved config object.
  apiKeyEnv: ANTHROPIC_AUTH_TOKEN
execution:
  # Quoted on purpose: bare on is boolean true under YAML 1.1.
  video: "on"
  browser: chromium
safety:
  allowedOrigins: []
  productionGuard: true
  blockDestructiveActions: true
`;

let ws: string;

beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), "investigator-target-"));
  mkdirSync(join(ws, ".investigator"), { recursive: true });
  writeFileSync(join(ws, ".investigator", "config.yaml"), ORIGINAL, "utf8");
});

afterEach(() => {
  try {
    rmSync(ws, { recursive: true, force: true });
  } catch {
    /* a locked handle on Windows must not fail the suite */
  }
});

function configText(): string {
  return readFileSync(join(ws, ".investigator", "config.yaml"), "utf8");
}

describe("decisions the operator has to make", () => {
  it("refuses production, and says why rather than citing a schema", () => {
    let caught: unknown;
    try {
      // A valid name, so this reaches the classification rule rather than stopping on the name.
      validateTargetRequest({
        name: "prod",
        baseUrl: "https://x.test",
        classification: "production",
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ParamError);
    expect(String((caught as Error).message)).toContain('no "production"');
    expect(String((caught as Error).message)).toContain("authorised");
  });

  it("refuses anything that is not an http(s) URL", () => {
    for (const bad of ["not a url", "ftp://x.test", "", "javascript:alert(1)", "/relative"]) {
      expect(
        () => validateTargetRequest({ name: "t1", baseUrl: bad, classification: "test" }),
        bad
      ).toThrow(ParamError);
    }
  });

  it("refuses a name that could collide with YAML or a path", () => {
    for (const bad of ["", "A", "has space", "../x", "x".repeat(60), "-lead", "trail-"]) {
      expect(
        () =>
          validateTargetRequest({ name: bad, baseUrl: "https://x.test", classification: "test" }),
        JSON.stringify(bad)
      ).toThrow(ParamError);
    }
  });

  it("accepts the three real classifications and normalises the url", () => {
    for (const c of ["fixture", "test", "staging"] as const) {
      const r = validateTargetRequest({
        name: "t1",
        baseUrl: "https://x.test/",
        classification: c,
      });
      expect(r.classification).toBe(c);
      expect(r.baseUrl).toBe("https://x.test");
    }
  });
});

describe("writing into a file a person also edits", () => {
  it("keeps every comment", () => {
    const before = (ORIGINAL.match(/^\s*#/gm) ?? []).length;
    writeTarget(ws, { name: "t1", baseUrl: "https://x.test", classification: "test" });
    const after = (configText().match(/^\s*#/gm) ?? []).length;
    expect(after).toBe(before);
    expect(configText()).toContain("The key never enters the resolved config object");
  });

  it("leaves a deliberately quoted value quoted", () => {
    writeTarget(ws, { name: "t1", baseUrl: "https://x.test", classification: "test" });
    expect(configText()).toContain('video: "on"');
    expect(parse(configText()).execution.video).toBe("on");
  });

  it("writes the target in block style, not flow style", () => {
    writeTarget(ws, { name: "t1", baseUrl: "https://x.test", classification: "test" });
    const text = configText();
    expect(text).toContain("  targets:\n    t1:\n");
    expect(text).not.toContain("{");
  });

  it("adds the origin to allowedOrigins and keeps destructive actions blocked", () => {
    const written = writeTarget(ws, {
      name: "t1",
      baseUrl: "https://x.test/some/path",
      classification: "test",
    });
    expect(written.origin).toBe("https://x.test");
    const cfg = parse(configText());
    expect(cfg.safety.allowedOrigins).toEqual(["https://x.test"]);
    expect(cfg.safety.blockDestructiveActions).toBe(true);
  });

  it("does not duplicate an origin two targets share", () => {
    writeTarget(ws, { name: "t1", baseUrl: "https://x.test/a", classification: "test" });
    writeTarget(ws, { name: "t2", baseUrl: "https://x.test/b", classification: "staging" });
    const cfg = parse(configText());
    expect(cfg.safety.allowedOrigins).toEqual(["https://x.test"]);
    expect(Object.keys(cfg.execution.targets).sort()).toEqual(["t1", "t2"]);
  });

  it("reads back what is configured, and reports none on a fresh workspace", () => {
    expect(readTargets(ws)).toEqual([]);
    writeTarget(ws, { name: "t1", baseUrl: "https://x.test", classification: "test" });
    expect(readTargets(ws)).toEqual([{ name: "t1", baseUrl: "https://x.test" }]);
  });
});
