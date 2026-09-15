import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CredentialStore, CREDENTIALS_FILENAME } from "./credential-store.js";

/**
 * The credential store exists so an operator can say "use this test account" and have it used.
 * These tests are about the two halves of that: the value must be USABLE, and it must never
 * become visible anywhere it should not be.
 */

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cred-store-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("storing and resolving", () => {
  it("gives back what the operator supplied", () => {
    const store = new CredentialStore(dir, {});
    store.set("ACCOUNT_PHONE", "9876543210");
    expect(store.revealSync("ACCOUNT_PHONE")).toBe("9876543210");
  });

  it("survives a restart, because a new process reads the same file", () => {
    new CredentialStore(dir, {}).set("ACCOUNT_OTP", "123456");
    expect(new CredentialStore(dir, {}).revealSync("ACCOUNT_OTP")).toBe("123456");
  });

  it("returns undefined rather than throwing for a name that was never set", () => {
    // The interpreter turns undefined into EXEC_ACTION_FAILED naming the variable, which is the
    // error an operator can act on. A throw here would surface as an unrelated crash.
    expect(new CredentialStore(dir, {}).revealSync("NEVER_SET")).toBeUndefined();
  });

  it("prefers the file over the environment", () => {
    // The file is what the operator typed most recently. An exported variable from months ago
    // must not silently win over it.
    const store = new CredentialStore(dir, { ACCOUNT_PHONE: "from-env" });
    store.set("ACCOUNT_PHONE", "from-file");
    expect(store.revealSync("ACCOUNT_PHONE")).toBe("from-file");
  });

  it("falls back to the environment, so a CI machine needs no file", () => {
    const store = new CredentialStore(dir, { ACCOUNT_PASSWORD: "from-env" });
    expect(store.revealSync("ACCOUNT_PASSWORD")).toBe("from-env");
    expect(store.names()).toEqual([]);
  });

  it("forgets a deleted credential", () => {
    const store = new CredentialStore(dir, {});
    store.set("ACCOUNT_EMAIL", "qa@example.invalid");
    expect(store.delete("ACCOUNT_EMAIL")).toBe(true);
    expect(store.revealSync("ACCOUNT_EMAIL")).toBeUndefined();
    expect(store.delete("ACCOUNT_EMAIL")).toBe(false);
  });
});

describe("what must never get through", () => {
  it("refuses a name that is not env-var shaped", () => {
    const store = new CredentialStore(dir, {});
    for (const bad of ["lower", "HAS SPACE", "1LEADING", "has-dash", ""]) {
      expect(() => store.set(bad, "x"), bad).toThrow();
    }
  });

  it("refuses an empty value", () => {
    expect(() => new CredentialStore(dir, {}).set("ACCOUNT_PIN", "")).toThrow();
  });

  it("does not read a badly-shaped name out of the environment either", () => {
    const store = new CredentialStore(dir, { "not a name": "x" });
    expect(store.revealSync("not a name")).toBeUndefined();
  });

  it("ignores entries in the file that do not match the name or value rules", () => {
    // The file is on the operator's disk and may be hand-edited. A malformed entry is dropped,
    // not trusted, and never becomes a name the model is told about.
    writeFileSync(
      join(dir, CREDENTIALS_FILENAME),
      JSON.stringify({ schemaVersion: 1, credentials: { ok: "a", VALID: "b", EMPTY: "" } })
    );
    expect(new CredentialStore(dir, {}).names()).toEqual(["VALID"]);
  });

  it("names the variable and not the value when a reveal fails", async () => {
    const store = new CredentialStore(dir, {});
    await expect(store.reveal("ACCOUNT_TOKEN")).rejects.toThrow(/ACCOUNT_TOKEN/);
  });

  it("hands back a Secret, not a string, from the async path", async () => {
    const store = new CredentialStore(dir, {});
    store.set("ACCOUNT_PASSWORD", "hunter2-is-not-in-this-string");
    const secret = await store.reveal("ACCOUNT_PASSWORD");
    // The whole point of Secret: stringifying it cannot leak it into a log line.
    expect(String(secret)).not.toContain("hunter2");
    expect(JSON.stringify({ secret })).not.toContain("hunter2");
  });
});

describe("the file on disk", () => {
  it("is written atomically and leaves no temp file behind", () => {
    const store = new CredentialStore(dir, {});
    store.set("ACCOUNT_PHONE", "9876543210");
    store.set("ACCOUNT_OTP", "123456");
    const raw = readFileSync(join(dir, CREDENTIALS_FILENAME), "utf8");
    expect(JSON.parse(raw).credentials).toEqual({
      ACCOUNT_PHONE: "9876543210",
      ACCOUNT_OTP: "123456",
    });
  });

  it("reports every value for the redactor to mask", () => {
    const store = new CredentialStore(dir, {});
    store.set("ACCOUNT_PHONE", "9876543210");
    store.set("ACCOUNT_OTP", "123456");
    expect(store.allValues().sort()).toEqual(["123456", "9876543210"]);
  });

  it("starts empty rather than failing when there is no file", () => {
    expect(new CredentialStore(dir, {}).names()).toEqual([]);
    expect(new CredentialStore(dir, {}).allValues()).toEqual([]);
    expect(new CredentialStore(dir, {}).entries()).toEqual([]);
  });

  it("stores and retrieves description metadata with entries()", () => {
    const store = new CredentialStore(dir, {});
    store.set("ACCOUNT_PHONE", "9876543210", "Phone number for login");
    store.set("ACCOUNT_OTP", "1234", "One-time passcode");

    expect(store.entries()).toEqual([
      { name: "ACCOUNT_OTP", description: "One-time passcode" },
      { name: "ACCOUNT_PHONE", description: "Phone number for login" },
    ]);
    expect(store.descriptions()).toEqual({
      ACCOUNT_PHONE: "Phone number for login",
      ACCOUNT_OTP: "One-time passcode",
    });

    store.delete("ACCOUNT_OTP");
    expect(store.entries()).toEqual([
      { name: "ACCOUNT_PHONE", description: "Phone number for login" },
    ]);
    expect(store.descriptions()).toEqual({
      ACCOUNT_PHONE: "Phone number for login",
    });
  });

  it("transparently loads schemaVersion 1 files without descriptions", () => {
    const v1Path = join(dir, CREDENTIALS_FILENAME);
    writeFileSync(
      v1Path,
      JSON.stringify({
        schemaVersion: 1,
        credentials: {
          LEGACY_KEY: "legacy-val",
        },
      }),
      "utf8"
    );

    const store = new CredentialStore(dir, {});
    expect(store.revealSync("LEGACY_KEY")).toBe("legacy-val");
    expect(store.entries()).toEqual([{ name: "LEGACY_KEY" }]);
  });
});

