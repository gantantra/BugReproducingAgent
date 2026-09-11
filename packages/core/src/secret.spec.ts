import { describe, it, expect } from "vitest";
import { inspect } from "node:util";
import { Secret, REDACTED, isSecret, scrubKnownSecrets } from "./secret.js";
import { InvestigatorError } from "./errors.js";
import { Logger, MemorySink } from "./logger.js";

/**
 * Secret hygiene (frozen decision 6, ADR-0008).
 *
 * Every path by which a value normally escapes into a log line, an error message, or an artifact
 * is checked here. This is the test that makes "never logged, never persisted" a property rather
 * than an aspiration.
 */

const PLAIN = "sk-live-DO-NOT-LEAK-4f3a91c7e2b85d06";

describe("Secret", () => {
  it("refuses to serialise itself by every common route", () => {
    const s = new Secret("DEEPSEEK_API_KEY", PLAIN);

    expect(String(s)).toBe(REDACTED);
    expect(`${s}`).toBe(REDACTED);
    expect(s + "").toBe(REDACTED);
    expect(s.toString()).toBe(REDACTED);
    expect(JSON.stringify(s)).toBe(`"${REDACTED}"`);
    expect(JSON.stringify({ key: s })).toBe(`{"key":"${REDACTED}"}`);
    expect(JSON.stringify([s])).toBe(`["${REDACTED}"]`);
    expect(inspect(s)).toBe(REDACTED);
    expect(inspect({ nested: s })).toContain(REDACTED);
    expect(inspect({ nested: s })).not.toContain(PLAIN);
  });

  it("keeps the plaintext out of every own-property enumeration", () => {
    const s = new Secret("DEEPSEEK_API_KEY", PLAIN);

    expect(Object.keys(s)).not.toContain("plaintext");
    expect(JSON.stringify(Object.keys(s))).not.toContain(PLAIN);
    expect(Object.values(s)).not.toContain(PLAIN);
    expect(Object.getOwnPropertyNames(s).map((k) => (s as never)[k])).not.toContain(PLAIN);
    // The WeakMap means there is no own symbol holding it either.
    for (const sym of Object.getOwnPropertySymbols(s)) {
      expect((s as never)[sym]).not.toBe(PLAIN);
    }
    expect(JSON.stringify({ ...s })).not.toContain(PLAIN);
  });

  it("yields the plaintext only through reveal and use", () => {
    const s = new Secret("K", PLAIN);
    expect(s.reveal()).toBe(PLAIN);
    expect(s.use((p) => p.length)).toBe(PLAIN.length);
    expect(s.length).toBe(PLAIN.length);
  });

  it("compares without disclosing", () => {
    const s = new Secret("K", PLAIN);
    expect(s.equalsPlaintext(PLAIN)).toBe(true);
    expect(s.equalsPlaintext(PLAIN + "x")).toBe(false);
    expect(s.equalsPlaintext("")).toBe(false);
  });

  it("is recognisable and scrubbable", () => {
    const s = new Secret("K", PLAIN);
    expect(isSecret(s)).toBe(true);
    expect(isSecret("string")).toBe(false);
    expect(scrubKnownSecrets(`before ${PLAIN} after`, [s])).toBe(`before ${REDACTED} after`);
  });

  it("never leaks through a logger, even at debug level", () => {
    const sink = new MemorySink();
    const s = new Secret("DEEPSEEK_API_KEY", PLAIN);
    const log = new Logger({ sink, level: "debug" }).withSecret(s);

    log.debug("calling provider", { key: s as never, url: `https://x/?k=${PLAIN}` });
    log.info(`inline ${PLAIN}`);
    log.error("failed", { detail: `Authorization: Bearer ${PLAIN}` });

    expect(sink.text()).not.toContain(PLAIN);
    expect(sink.text()).toContain(REDACTED);
  });

  it("never leaks through a typed error", () => {
    const sink = new MemorySink();
    const s = new Secret("K", PLAIN);
    const log = new Logger({ sink, level: "debug" }).withSecret(s);

    // `context` is primitives-only by type, which is the structural half of the guarantee.
    const err = new InvestigatorError("AI_AUTH", "provider rejected the credential", {
      context: { variable: "DEEPSEEK_API_KEY", status: 401 },
    });
    log.failure(err);

    expect(sink.text()).not.toContain(PLAIN);
    expect(JSON.stringify(err.toJSON())).not.toContain(PLAIN);
    // The variable NAME is safe and useful; the value is not.
    expect(sink.text()).toContain("DEEPSEEK_API_KEY");
  });

  it("the logger backstop masks key-shaped values it was never told about", () => {
    const sink = new MemorySink();
    const log = new Logger({ sink, level: "debug" });
    log.info("header", {
      h: "Bearer AKIAIOSFODNN7EXAMPLEKEY123456789",
      jwt: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk",
    });
    expect(sink.text()).not.toContain("AKIAIOSFODNN7EXAMPLEKEY123456789");
    expect(sink.text()).not.toContain("eyJhbGciOiJIUzI1NiJ9");
  });
});
