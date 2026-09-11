import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";

/**
 * M2-AT-13: no code path outside the `approve` handler constructs an ApprovalRecord.
 *
 * Playwright produces evidence. Deterministic software normalizes and measures evidence. DeepSeek interprets and prioritizes evidence. Humans authorize consequential transitions.
 *
 * The approval mechanism is only as strong as the number of places that can mint one. This walks
 * the source and asserts there is exactly one, because a second — however well intentioned, and
 * however guarded at the time it was written — is how auto-approval arrives later by accident.
 */

const ROOT = process.cwd();

function sourceFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist") continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p));
    else if (entry.endsWith(".ts") && !entry.endsWith(".spec.ts") && !entry.endsWith(".test.ts")) {
      out.push(p);
    }
  }
  return out;
}

const PRODUCTION = [
  ...sourceFiles(join(ROOT, "packages")),
  ...sourceFiles(join(ROOT, "apps")),
];

/** The one file allowed to record a human decision. */
const AUTHORISED = join("apps", "cli", "src", "commands", "approve.ts");

describe("approval authority (M2-AT-13)", () => {
  it("only the approve command inserts an ApprovalRecord", () => {
    const callers = PRODUCTION.filter((f) => /\binsertApproval\s*\(/.test(readFileSync(f, "utf8")))
      .map((f) => f.slice(ROOT.length + 1))
      // The storage adapter DEFINES insertApproval; defining it is not minting one.
      .filter((rel) => !rel.includes(join("packages", "storage")));

    expect(callers, `unexpected ApprovalRecord writers: ${callers.join(", ")}`).toEqual([
      AUTHORISED,
    ]);
  });

  it("no source offers an auto-approval switch", () => {
    // A flag, config key, or environment variable that grants an approval would defeat the gate
    // without any code needing to call insertApproval directly.
    for (const file of PRODUCTION) {
      const text = readFileSync(file, "utf8");
      const rel = file.slice(ROOT.length + 1);
      expect(text, `${rel} offers --yes`).not.toMatch(/["']--yes["']/);
      expect(text, `${rel} offers --force-approve`).not.toMatch(/["']--force-approve["']/);
      expect(text, `${rel} offers --auto-approve`).not.toMatch(/["']--auto-approve["']/);
      expect(text, `${rel} reads an auto-approve env var`).not.toMatch(/AUTO_APPROVE/);
      expect(text, `${rel} reads an autoApprove config key`).not.toMatch(/autoApprove/);
    }
  });

  it("the executor cannot reach the approvals package", () => {
    // Execution consumes an approval's RESULT (the effective proposal, via the CLI); it must not
    // be able to evaluate or create approvals itself.
    for (const file of sourceFiles(join(ROOT, "packages", "execution"))) {
      const text = readFileSync(file, "utf8");
      expect(text, `${file} imports approvals`).not.toMatch(
        /from\s+["']@investigator\/approvals["']/
      );
    }
  });

  it("the approvals package cannot reach the executor or a browser", () => {
    for (const file of sourceFiles(join(ROOT, "packages", "approvals"))) {
      const text = readFileSync(file, "utf8");
      expect(text, `${file} imports execution`).not.toMatch(
        /from\s+["']@investigator\/execution["']/
      );
      expect(text, `${file} imports playwright`).not.toMatch(/from\s+["']playwright["']/);
    }
  });
});
