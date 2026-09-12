import { describe, it, expect } from "vitest";
import { SessionStore, normalizeIp, readCookie, type Clock } from "./sessions.js";

/**
 * The session lock decides whether a second browser on the same machine is allowed to drive the
 * same workspace. Getting it wrong in either direction is bad: too loose and two transcripts
 * interleave commands against one SQLite database; too tight and closing a tab locks the operator
 * out of their own agent until the server restarts.
 *
 * Time is injected so the TTL is asserted rather than waited for.
 */

function fixed(startAt = 1_000_000): Clock & { advance(ms: number): void } {
  let now = startAt;
  return {
    now: () => now,
    advance(ms: number) {
      now += ms;
    },
  };
}

function storeWith(ttlMs = 60_000) {
  const clock = fixed();
  let n = 0;
  const store = new SessionStore(() => `S${++n}`, clock, ttlMs);
  return { store, clock };
}

describe("normalizeIp", () => {
  it("treats every loopback spelling as one machine", () => {
    for (const raw of [
      "127.0.0.1",
      "::1",
      "::ffff:127.0.0.1",
      "localhost",
      "  ::1  ",
      "::FFFF:127.0.0.1",
    ]) {
      expect(normalizeIp(raw), raw).toBe("loopback");
    }
  });

  it("leaves a real address alone and survives a missing one", () => {
    expect(normalizeIp("10.4.2.9")).toBe("10.4.2.9");
    expect(normalizeIp(undefined)).toBe("unknown");
    expect(normalizeIp("")).toBe("unknown");
  });
});

describe("one live session per address", () => {
  it("gives the first caller the lock", () => {
    const { store } = storeWith();
    const first = store.acquire("loopback");
    expect(first.status).toBe("active");
  });

  it("reports busy for a second caller without a session", () => {
    const { store } = storeWith();
    store.acquire("loopback");
    const second = store.acquire("loopback");
    expect(second.status).toBe("busy");
    if (second.status === "busy") {
      expect(second.expiresInMs).toBeGreaterThan(0);
    }
    expect(store.size()).toBe(1);
  });

  it("resumes the same session when the cookie comes back — this is what a refresh does", () => {
    const { store, clock } = storeWith();
    const first = store.acquire("loopback");
    if (first.status !== "active") throw new Error("expected active");
    store.setState(first.session.id, { log: [1, 2, 3] });

    clock.advance(5_000);
    const again = store.acquire("loopback", first.session.id);
    expect(again.status).toBe("active");
    if (again.status === "active") {
      expect(again.session.id).toBe(first.session.id);
      expect(again.session.state).toEqual({ log: [1, 2, 3] });
    }
    expect(store.size()).toBe(1);
  });

  it("does not hand one address's session to a different address", () => {
    const { store } = storeWith();
    const mine = store.acquire("loopback");
    if (mine.status !== "active") throw new Error("expected active");
    const elsewhere = store.acquire("10.4.2.9", mine.session.id);
    expect(elsewhere.status).toBe("active");
    if (elsewhere.status === "active") {
      expect(elsewhere.session.id).not.toBe(mine.session.id);
    }
  });

  it("never evicts a live holder in favour of a newcomer", () => {
    const { store, clock } = storeWith();
    const holder = store.acquire("loopback");
    if (holder.status !== "active") throw new Error("expected active");
    for (let i = 0; i < 5; i++) {
      clock.advance(1_000);
      store.touch(holder.session.id);
      expect(store.acquire("loopback").status).toBe("busy");
    }
    expect(store.get(holder.session.id)).toBeDefined();
  });
});

describe("a closed tab must not lock the operator out", () => {
  it("frees the lock once the TTL lapses with no heartbeat", () => {
    const { store, clock } = storeWith(60_000);
    store.acquire("loopback");
    expect(store.acquire("loopback").status).toBe("busy");

    clock.advance(60_001);
    expect(store.acquire("loopback").status).toBe("active");
  });

  it("keeps the lock while heartbeats arrive", () => {
    const { store, clock } = storeWith(60_000);
    const held = store.acquire("loopback");
    if (held.status !== "active") throw new Error("expected active");

    for (let i = 0; i < 10; i++) {
      clock.advance(30_000);
      expect(store.touch(held.session.id), `heartbeat ${i}`).toBe(true);
    }
    expect(store.acquire("loopback").status).toBe("busy");
  });

  it("frees the lock immediately on an explicit release", () => {
    const { store } = storeWith();
    const held = store.acquire("loopback");
    if (held.status !== "active") throw new Error("expected active");

    expect(store.release(held.session.id)).toBe(true);
    expect(store.acquire("loopback").status).toBe("active");
  });

  it("refuses to resurrect an expired session through touch or setState", () => {
    const { store, clock } = storeWith(60_000);
    const held = store.acquire("loopback");
    if (held.status !== "active") throw new Error("expected active");

    clock.advance(60_001);
    expect(store.touch(held.session.id)).toBe(false);
    expect(store.setState(held.session.id, { log: [] })).toBe(false);
    expect(store.get(held.session.id)).toBeUndefined();
  });

  it("ignores a null or unknown id everywhere rather than throwing", () => {
    const { store } = storeWith();
    expect(store.touch(null)).toBe(false);
    expect(store.touch("nope")).toBe(false);
    expect(store.setState(undefined, {})).toBe(false);
    expect(store.release(null)).toBe(false);
    expect(store.get("nope")).toBeUndefined();
  });
});

describe("readCookie", () => {
  it("finds the named cookie among others", () => {
    expect(readCookie("a=1; investigator_session=abc123; b=2", "investigator_session")).toBe(
      "abc123"
    );
    expect(readCookie("investigator_session=only", "investigator_session")).toBe("only");
  });

  it("returns null when absent, empty, or a prefix collision", () => {
    expect(readCookie(undefined, "investigator_session")).toBeNull();
    expect(readCookie("", "investigator_session")).toBeNull();
    expect(readCookie("other=1", "investigator_session")).toBeNull();
    // `investigator_session_x` must not satisfy a lookup for `investigator_session`.
    expect(readCookie("investigator_session_x=1", "investigator_session")).toBeNull();
  });

  it("decodes a percent-encoded value", () => {
    expect(readCookie("investigator_session=a%20b", "investigator_session")).toBe("a b");
  });
});
