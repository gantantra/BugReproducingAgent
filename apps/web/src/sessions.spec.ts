import { describe, it, expect } from "vitest";
import {
  SessionStore,
  normalizeIp,
  readCookie,
  type Clock,
  type Session,
  type SessionPersistence,
  type User,
} from "./sessions.js";

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

  it("gives a second caller its own session rather than refusing", () => {
    // This asserted `busy` while every session shared one workspace, database and investigation
    // numbering. Sessions now own separate folders, so two tabs collide over nothing and the
    // refusal was a queue for one user — the server is loopback-only, so "per address" meant
    // per machine.
    const { store } = storeWith();
    const first = store.acquire("loopback");
    const second = store.acquire("loopback");
    expect(second.status).toBe("active");
    if (first.status !== "active" || second.status !== "active") throw new Error("expected active");
    expect(second.session.id).not.toBe(first.session.id);
    expect(store.size()).toBe(2);
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

  it("never disturbs a live session when a newcomer arrives", () => {
    // The guarantee that survives the lock's removal: opening a second tab must not take, reset
    // or expire the transcript the first one is still using.
    const { store, clock } = storeWith();
    const holder = store.acquire("loopback");
    if (holder.status !== "active") throw new Error("expected active");
    store.setState(holder.session.id, { log: [1, 2, 3] });

    for (let i = 0; i < 5; i++) {
      clock.advance(1_000);
      store.touch(holder.session.id);
      expect(store.acquire("loopback").status).toBe("active");
    }
    expect(store.get(holder.session.id)?.state).toEqual({ log: [1, 2, 3] });
  });
});

describe("an abandoned session expires, a live one does not", () => {
  it("drops a session once the TTL lapses with no heartbeat", () => {
    // Expiry still matters after the lock's removal, for a different reason: a lapsed session is
    // what makes the server refuse a write rather than send it to the shared root workspace.
    const { store, clock } = storeWith(60_000);
    const held = store.acquire("loopback");
    if (held.status !== "active") throw new Error("expected active");

    clock.advance(60_001);
    expect(store.get(held.session.id)).toBeUndefined();
    expect(store.size()).toBe(0);
  });

  it("keeps a session alive indefinitely while heartbeats arrive", () => {
    const { store, clock } = storeWith(60_000);
    const held = store.acquire("loopback");
    if (held.status !== "active") throw new Error("expected active");

    for (let i = 0; i < 10; i++) {
      clock.advance(30_000);
      expect(store.touch(held.session.id), `heartbeat ${i}`).toBe(true);
    }
    expect(store.get(held.session.id)).toBeDefined();
  });

  it("drops a session immediately on an explicit release", () => {
    const { store } = storeWith();
    const held = store.acquire("loopback");
    if (held.status !== "active") throw new Error("expected active");

    expect(store.release(held.session.id)).toBe(true);
    expect(store.get(held.session.id)).toBeUndefined();
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

describe("users, and surviving a restart on host storage", () => {
  function memory(): SessionPersistence & { users: User[]; sessions: Session[] } {
    const box = {
      users: [] as User[],
      sessions: [] as Session[],
      loadUsers: () => box.users,
      saveUsers: (u: User[]) => {
        box.users = u.map((x) => ({ ...x }));
      },
      loadSessions: () => box.sessions,
      saveSessions: (v: Session[]) => {
        box.sessions = v.map((x) => ({ ...x }));
      },
    };
    return box;
  }

  it("mints a user on first contact and recognises the same browser afterwards", () => {
    const clock = fixed();
    let n = 0;
    const store = new SessionStore(() => `S${++n}`, clock, 60_000, memory());

    const first = store.identify(null, "loopback");
    expect(store.userCount()).toBe(1);

    clock.advance(1000);
    const again = store.identify(first.id, "loopback");
    expect(again.id).toBe(first.id);
    expect(again.lastSeenAt).toBe(clock.now());
    expect(store.userCount()).toBe(1);
  });

  it("attributes a session to its user and counts sessions started", () => {
    const clock = fixed();
    let n = 0;
    const store = new SessionStore(() => `S${++n}`, clock, 60_000, memory());

    const a = store.acquire("loopback");
    if (a.status !== "active") throw new Error("expected active");
    const owner = store.getUser(a.session.userId);
    expect(owner).toBeDefined();
    expect(owner?.sessionCount).toBe(1);

    store.release(a.session.id);
    const b = store.acquire("loopback", null, owner?.id);
    if (b.status !== "active") throw new Error("expected active");
    expect(b.session.userId).toBe(owner?.id);
    expect(store.getUser(owner?.id)?.sessionCount).toBe(2);
    expect(store.userCount()).toBe(1);
  });

  it("writes both collections to storage as it goes", () => {
    const box = memory();
    const clock = fixed();
    let n = 0;
    const store = new SessionStore(() => `S${++n}`, clock, 60_000, box);

    const a = store.acquire("loopback");
    if (a.status !== "active") throw new Error("expected active");
    store.setState(a.session.id, { log: [{ t: "say", text: "hello" }] });

    expect(box.users).toHaveLength(1);
    expect(box.sessions).toHaveLength(1);
    expect(box.sessions[0]?.state).toEqual({ log: [{ t: "say", text: "hello" }] });
  });

  it("restores a live session after a restart, transcript intact", () => {
    const box = memory();
    const clock = fixed();
    let n = 0;

    const before = new SessionStore(() => `S${++n}`, clock, 60_000, box);
    const a = before.acquire("loopback");
    if (a.status !== "active") throw new Error("expected active");
    before.setState(a.session.id, { investigation: "INV-010", log: [1, 2] });

    // A new process reading the same files.
    clock.advance(5_000);
    const after = new SessionStore(() => `R${++n}`, clock, 60_000, box);
    const resumed = after.acquire("loopback", a.session.id);
    expect(resumed.status).toBe("active");
    if (resumed.status === "active") {
      expect(resumed.session.id).toBe(a.session.id);
      expect(resumed.session.state).toEqual({ investigation: "INV-010", log: [1, 2] });
    }
  });

  it("does not resurrect a session that had already lapsed before the restart", () => {
    const box = memory();
    const clock = fixed();
    let n = 0;

    const before = new SessionStore(() => `S${++n}`, clock, 60_000, box);
    const a = before.acquire("loopback");
    if (a.status !== "active") throw new Error("expected active");

    clock.advance(60_001);
    const after = new SessionStore(() => `R${++n}`, clock, 60_000, box);
    expect(after.get(a.session.id)).toBeUndefined();
    // And the lock is free for whoever asks next.
    expect(after.acquire("loopback").status).toBe("active");
  });

  it("starts clean when there is no persistence at all", () => {
    const store = new SessionStore(() => "S1");
    expect(store.size()).toBe(0);
    expect(store.userCount()).toBe(0);
    expect(store.acquire("loopback").status).toBe("active");
  });

  it("defaults to a 2-hour TTL to prevent sessions lapsing during browser runs", () => {
    const store = new SessionStore(() => "S1");
    expect(store.ttlMs).toBe(7_200_000);
  });
});
