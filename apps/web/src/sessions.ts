/**
 * One live chat session per client address, and enough stored state to survive a refresh.
 *
 * Why a lock at all: two tabs driving the same workspace would interleave `investigate` commands
 * against one SQLite database and one investigation, and the operator would be reading a
 * transcript that is missing half of what happened. The lock is a concurrency guard, not a
 * security control — the server is loopback-only, so anyone who can reach it is already on the
 * machine.
 *
 * Why a TTL: a browser that is closed cannot tell us it is gone. Without expiry, closing the tab
 * would lock the operator out of their own agent until they restarted the server. The client
 * heartbeats while it is open and releases on `pagehide`; the TTL is the backstop for a crash, a
 * killed browser, or a laptop that slept.
 */

export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

export interface Session {
  id: string;
  ip: string;
  /** The user this session belongs to. Survives the session, so history can be attributed. */
  userId: string;
  createdAt: number;
  lastSeenAt: number;
  /** Opaque to this module: the chat transcript and where the operator got to. */
  state: unknown;
}

/**
 * A user here is a returning browser, not an authenticated identity. There is no login, and this
 * records no credential: it exists so the host can keep a session's history across a restart and
 * attribute it to the same person who started it.
 */
export interface User {
  id: string;
  createdAt: number;
  lastSeenAt: number;
  lastIp: string;
  sessionCount: number;
}

/** Where users and sessions are kept between restarts. See storage.ts for the disk implementation. */
export interface SessionPersistence {
  loadUsers(): User[];
  saveUsers(users: User[]): void;
  loadSessions(): Session[];
  saveSessions(sessions: Session[]): void;
}

/**
 * Always `active`. The union is gone with the lock it existed for.
 *
 * Keeping a `busy` variant "in case" left an unreachable branch in the server that could only be
 * read as a state the system can enter. A type that describes states nothing produces is a
 * question every later reader has to answer again.
 */
export type AcquireResult = { status: "active"; session: Session };

/**
 * `::1`, `::ffff:127.0.0.1` and `127.0.0.1` are the same machine reaching the same loopback
 * socket. Treating them as three addresses would hand out three sessions and defeat the lock,
 * which is the one thing this exists to prevent.
 */
export function normalizeIp(raw: string | undefined | null): string {
  if (!raw) return "unknown";
  let ip = raw.trim().toLowerCase();
  if (ip.startsWith("::ffff:")) ip = ip.slice("::ffff:".length);
  if (ip === "::1" || ip === "127.0.0.1" || ip === "localhost") return "loopback";
  return ip;
}

export class SessionStore {
  private readonly byId = new Map<string, Session>();
  private readonly users = new Map<string, User>();
  private readonly persistence: SessionPersistence | null;

  constructor(
    private readonly newId: () => string,
    private readonly clock: Clock = systemClock,
    /** How long a session survives without a heartbeat. */
    readonly ttlMs: number = 60_000,
    persistence: SessionPersistence | null = null
  ) {
    this.persistence = persistence;
    if (!persistence) return;

    // Restart recovery. Expired sessions are dropped on the way in rather than resurrected: a
    // session that lapsed before the restart must not come back holding the lock.
    const now = this.clock.now();
    for (const user of persistence.loadUsers()) this.users.set(user.id, user);
    for (const session of persistence.loadSessions()) {
      if (now - session.lastSeenAt < this.ttlMs) this.byId.set(session.id, session);
    }
  }

  private flushSessions(): void {
    this.persistence?.saveSessions([...this.byId.values()]);
  }

  private flushUsers(): void {
    this.persistence?.saveUsers([...this.users.values()]);
  }

  /**
   * Resolve the returning browser behind a request, minting an id the first time. Called before
   * `acquire`, so a session always has a user to belong to.
   */
  identify(userId: string | null | undefined, ip: string): User {
    const now = this.clock.now();
    const existing = userId ? this.users.get(userId) : undefined;
    if (existing) {
      existing.lastSeenAt = now;
      existing.lastIp = ip;
      this.flushUsers();
      return existing;
    }
    const user: User = {
      id: this.newId(),
      createdAt: now,
      lastSeenAt: now,
      lastIp: ip,
      sessionCount: 0,
    };
    this.users.set(user.id, user);
    this.flushUsers();
    return user;
  }

  getUser(id: string | null | undefined): User | undefined {
    return id ? this.users.get(id) : undefined;
  }

  userCount(): number {
    return this.users.size;
  }

  private live(session: Session, now: number): boolean {
    return now - session.lastSeenAt < this.ttlMs;
  }

  /** Drop everything past its TTL. Called before any decision that depends on who holds the lock. */
  private sweep(now: number): void {
    let dropped = false;
    for (const [id, session] of this.byId) {
      if (!this.live(session, now)) {
        this.byId.delete(id);
        dropped = true;
      }
    }
    if (dropped) this.flushSessions();
  }

  /**
   * Resume `existingId` if it is still this address's session, otherwise start a new one.
   *
   * This used to refuse a second session on the same address, and the reason it gave was that
   * "two tabs would issue commands into the same workspace database and the same investigation,
   * and each transcript would be missing half of what happened". That was true when every session
   * shared one workspace. It stopped being true when each session got its own folder, its own
   * database and its own investigation numbering: two tabs now collide over nothing.
   *
   * What remained was the cost. The server is loopback-only, so every connection resolves to one
   * address, which made this one session per MACHINE — a second tab, a second browser, or a
   * reopened window after a crash was told to go away for up to a minute. A concurrency guard
   * protecting against a collision that can no longer happen is just a queue for one user.
   *
   * `AcquireResult` keeps its `busy` variant: the store is not the only possible caller, and
   * removing a state from the type to express "this never happens now" loses the ability to say
   * it later. Nothing in this method returns it.
   */
  acquire(ip: string, existingId?: string | null, userId?: string | null): AcquireResult {
    const now = this.clock.now();
    this.sweep(now);

    if (existingId) {
      const mine = this.byId.get(existingId);
      if (mine && mine.ip === ip) {
        mine.lastSeenAt = now;
        this.flushSessions();
        return { status: "active", session: mine };
      }
    }

    const owner = this.identify(userId, ip);
    owner.sessionCount += 1;
    this.flushUsers();

    const session: Session = {
      id: this.newId(),
      ip,
      userId: owner.id,
      createdAt: now,
      lastSeenAt: now,
      state: null,
    };
    this.byId.set(session.id, session);
    this.flushSessions();
    return { status: "active", session };
  }

  /** Keep a session alive. Returns false if it has already expired or was released. */
  touch(id: string | null | undefined): boolean {
    if (!id) return false;
    const now = this.clock.now();
    const session = this.byId.get(id);
    if (!session || !this.live(session, now)) return false;
    session.lastSeenAt = now;
    this.flushSessions();
    return true;
  }

  /** Store the transcript. Refuses an unknown or expired id rather than resurrecting it. */
  setState(id: string | null | undefined, state: unknown): boolean {
    if (!id) return false;
    const now = this.clock.now();
    const session = this.byId.get(id);
    if (!session || !this.live(session, now)) return false;
    session.lastSeenAt = now;
    session.state = state;
    this.flushSessions();
    return true;
  }

  get(id: string | null | undefined): Session | undefined {
    if (!id) return undefined;
    const session = this.byId.get(id);
    if (!session) return undefined;
    return this.live(session, this.clock.now()) ? session : undefined;
  }

  /** Explicit release, sent by the page as it unloads so the next tab is not made to wait. */
  release(id: string | null | undefined): boolean {
    if (!id) return false;
    const removed = this.byId.delete(id);
    if (removed) this.flushSessions();
    return removed;
  }

  /** Live session count, for diagnostics and tests. */
  size(): number {
    this.sweep(this.clock.now());
    return this.byId.size;
  }
}

/** Read one cookie out of a Cookie header without pulling in a parser. */
export function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}
