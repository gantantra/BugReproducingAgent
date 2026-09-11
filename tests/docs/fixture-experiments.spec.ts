import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { schemaRegistry } from "@investigator/core";

/**
 * The shipped fixture experiments must stay schema-valid and must stay runnable.
 *
 * The completion audit found the documented M1 demo referenced
 * `packages/test-fixtures/experiments/product-failing-intermittent.json`, which did not exist --
 * the milestone's own demo command could not run. These files close that gap, so a test keeps
 * them honest: a schema change or a stray edit that breaks one fails here rather than in a demo.
 */

const DIR = join(process.cwd(), "packages", "test-fixtures", "experiments");

describe("shipped fixture experiments", () => {
  const files = readdirSync(DIR).filter((f) => f.endsWith(".json"));

  it("ships the experiment the documented M1 demo names", () => {
    expect(files).toContain("product-failing-intermittent.json");
  });

  it.each(files)("%s is valid against fixture-experiment.v1.json", (file) => {
    const parsed = JSON.parse(readFileSync(join(DIR, file), "utf8")) as unknown;
    const registry = schemaRegistry();
    expect(() => registry.assert("fixture-experiment.v1.json", parsed, file)).not.toThrow();
  });

  it.each(files)("%s declares read-only side effects and no destructive action", (file) => {
    const e = JSON.parse(readFileSync(join(DIR, file), "utf8")) as {
      safety: { maxSideEffectClass: string; destructiveActionIds: string[] };
    };
    // A shipped fixture must never require a destructive acknowledgement to run, or the demo
    // would be teaching operators to acknowledge destructive actions casually.
    expect(e.safety.maxSideEffectClass).toBe("read");
    expect(e.safety.destructiveActionIds).toEqual([]);
  });

  it.each(files)("%s contains no absolute URL, so it cannot escape the fixture target", (file) => {
    const raw = readFileSync(join(DIR, file), "utf8");
    // Every navigation is target-relative. An absolute URL in a shipped fixture could point
    // anywhere, including outside safety.allowedOrigins.
    expect(raw).not.toMatch(/"url"\s*:\s*"https?:\/\//);
  });

  it.each(files)("%s contains no credential-shaped material", (file) => {
    const raw = readFileSync(join(DIR, file), "utf8");
    expect(raw).not.toMatch(/sk-[A-Za-z0-9]{16,}|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{20,}\./);
    expect(raw.toLowerCase()).not.toMatch(/"(password|secret|api_?key|token)"\s*:/);
  });
});
