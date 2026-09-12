import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensureSessionWorkspace,
  listSessionFolders,
  recordSessionEvent,
  sessionFolderName,
} from "./session-workspace.js";

/**
 * One folder per session, holding everything that session produced.
 *
 * The claim these tests defend is containment: a session writes inside its own folder and
 * nowhere else, and two sessions never share one.
 */

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "session-ws-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const AT = Date.parse("2026-09-12T10:14:33.000Z");

/** Write a parent workspace config for the session to seed from. */
function seedParent(yaml: string): void {
  mkdirSync(join(root, ".investigator"), { recursive: true });
  writeFileSync(join(root, ".investigator", "config.yaml"), yaml);
}

describe("naming", () => {
  it("leads with the timestamp, so folders sort chronologically by name", () => {
    const earlier = sessionFolderName(AT, "aaaaaaaa-1111");
    const later = sessionFolderName(AT + 86_400_000, "bbbbbbbb-2222");
    expect(later > earlier).toBe(true);
    expect(earlier).toMatch(/^2026-09-12T10-14-33Z-/);
  });

  it("distinguishes two sessions created in the same second", () => {
    expect(sessionFolderName(AT, "aaaaaaaa")).not.toBe(sessionFolderName(AT, "bbbbbbbb"));
  });

  it("produces a name safe to use as a directory", () => {
    // No colons: Windows refuses them outright, and the ISO form is full of them.
    expect(sessionFolderName(AT, "a/b\\c:d")).not.toMatch(/[:\\/]/);
  });
});

describe("creating the folder", () => {
  it("puts it under sessions/ and gives it a workspace skeleton", () => {
    const ws = ensureSessionWorkspace(root, AT, "abc123");
    expect(ws.created).toBe(true);
    expect(ws.dir).toBe(join(root, "sessions", ws.name));
    expect(existsSync(join(ws.dir, ".investigator", "investigations"))).toBe(true);
    expect(existsSync(join(ws.dir, "reports"))).toBe(true);
  });

  it("is idempotent, because every request that needs a path calls it", () => {
    const first = ensureSessionWorkspace(root, AT, "abc123");
    const second = ensureSessionWorkspace(root, AT, "abc123");
    expect(second.created).toBe(false);
    expect(second.dir).toBe(first.dir);
  });

  it("gives two sessions two folders", () => {
    const a = ensureSessionWorkspace(root, AT, "aaaaaa");
    const b = ensureSessionWorkspace(root, AT + 1000, "bbbbbb");
    expect(a.dir).not.toBe(b.dir);
  });

  it("inherits how the machine talks to the world", () => {
    // Provider, storage, policy, budgets: identical for every session, tedious to restate, and
    // carrying no trace of what anyone investigated.
    seedParent("llm:\n  provider: deepseek\nsafety:\n  productionGuard: true\n");
    const ws = ensureSessionWorkspace(root, AT, "abc123");
    const seeded = readFileSync(join(ws.dir, ".investigator", "config.yaml"), "utf8");
    expect(seeded).toContain("productionGuard");
    expect(seeded).toContain("deepseek");
  });

  it("does NOT inherit what anyone was investigating", () => {
    // The isolation that matters. A target one operator added must not arrive pre-configured for
    // the next person to open the page, and no session should announce "using the configured
    // target X" for an X nobody in that session named.
    seedParent(
      [
        "execution:",
        "  targets:",
        "    someone-elses:",
        "      baseUrl: https://not-yours.example",
        "      classification: test",
        "safety:",
        "  allowedOrigins:",
        "    - https://not-yours.example",
        "",
      ].join("\n")
    );
    const ws = ensureSessionWorkspace(root, AT, "abc123");
    const seeded = readFileSync(join(ws.dir, ".investigator", "config.yaml"), "utf8");
    expect(seeded).not.toContain("not-yours.example");
    expect(seeded).not.toContain("someone-elses");
  });

  it("keeps the operator's comments and quoting in what it does inherit", () => {
    // `video: "on"` has to stay quoted: bare `on` is boolean true under YAML 1.1.
    seedParent('# how this machine runs\nexecution:\n  video: "on"\n  workers: 1\n');
    const ws = ensureSessionWorkspace(root, AT, "abc123");
    const seeded = readFileSync(join(ws.dir, ".investigator", "config.yaml"), "utf8");
    expect(seeded).toContain("# how this machine runs");
    expect(seeded).toContain('video: "on"');
  });

  it("does not re-seed over a session's own edits", () => {
    seedParent("original: true\n");
    const ws = ensureSessionWorkspace(root, AT, "abc123");
    writeFileSync(join(ws.dir, ".investigator", "config.yaml"), "edited: true\n");
    ensureSessionWorkspace(root, AT, "abc123");
    // A target configured mid-session must not be silently reverted by the next request.
    expect(readFileSync(join(ws.dir, ".investigator", "config.yaml"), "utf8")).toBe(
      "edited: true\n"
    );
  });

  it("still creates the folder when there is no parent config to inherit", () => {
    const ws = ensureSessionWorkspace(root, AT, "abc123");
    expect(existsSync(ws.dir)).toBe(true);
    // Absent, not fabricated: a config claiming targets nobody configured would be worse.
    expect(existsSync(join(ws.dir, ".investigator", "config.yaml"))).toBe(false);
  });
});

describe("listing", () => {
  it("returns nothing before any session has run", () => {
    expect(listSessionFolders(root)).toEqual([]);
  });

  it("returns folders newest first", () => {
    const a = ensureSessionWorkspace(root, AT, "aaaaaa");
    const b = ensureSessionWorkspace(root, AT + 86_400_000, "bbbbbb");
    expect(listSessionFolders(root)).toEqual([b.name, a.name]);
  });
});

describe("the session log", () => {
  it("appends rather than overwrites, so the history survives", () => {
    const ws = ensureSessionWorkspace(root, AT, "abc123");
    recordSessionEvent(ws.dir, { kind: "report", bytes: 10 });
    recordSessionEvent(ws.dir, { kind: "credential", name: "ACCOUNT_PHONE" });
    const lines = readFileSync(join(ws.dir, "session.jsonl"), "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!).kind).toBe("report");
    expect(JSON.parse(lines[1]!).name).toBe("ACCOUNT_PHONE");
  });

  it("never throws, because a log must not stop the investigation it describes", () => {
    // A NUL is rejected by every OS as a path segment, so this cannot be written. Built with
    // String.fromCharCode rather than pasted raw: a literal NUL in a source file makes git and
    // grep treat the whole file as binary, which is how this line went unnoticed once already.
    const unwritable = join(root, "nope", `${String.fromCharCode(0)}bad`);
    expect(() => recordSessionEvent(unwritable, { kind: "x" })).not.toThrow();
  });
});
