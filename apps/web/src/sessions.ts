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
  createdAt: number;
  lastSeenAt: number;
  /** Opaque to this module: the chat transcript and where the operator got to. */
  state: unknown;
}

export type AcquireResult =
  | { status: "active"; session: Session }
  | { status: "busy"; heldSince: number; lastSeenAt: number; expiresInMs: number };

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

  constructor(
    private readonly newId: () => string,
    private readonly clock: Clock = systemClock,
    /** How long a session survives without a heartbeat. */
    readonly ttlMs: number = 60_000
  ) {}

  private live(session: Session, now: number): boolean {
    return now - session.lastSeenAt < this.ttlMs;
  }

  /** Drop everything past its TTL. Called before any decision that depends on who holds the lock. */
  private sweep(now: number): void {
    for (const [id, session] of this.byId) {
      if (!this.live(session, now)) this.byId.delete(id);
    }
  }

  /** The live session for an address, if any. */
  private holderFor(ip: string, now: number): Session | undefined {
    for (const session of this.byId.values()) {
      if (session.ip === ip && this.live(session, now)) return session;
    }
    return undefined;
  }

  /**
   * Resume `existingId` if it is still this address's session, otherwise take the lock if it is
   * free. A different live session on the same address is reported as busy rather than evicted:
   * silently stealing it would leave the other tab issuing commands into a transcript nobody is
   * reading.
   */
  acquire(ip: string, existingId?: string | null): AcquireResult {
    const now = this.clock.now();
    this.sweep(now);

    if (existingId) {
      const mine = this.byId.get(existingId);
      if (mine && mine.ip === ip) {
        mine.lastSeenAt = now;
        return { status: "active", session: mine };
      }
    }

    const holder = this.holderFor(ip, now);
    if (holder) {
      return {
        status: "busy",
        heldSince: holder.createdAt,
        lastSeenAt: holder.lastSeenAt,
        expiresInMs: Math.max(0, this.ttlMs - (now - holder.lastSeenAt)),
      };
    }

    const session: Session = {
      id: this.newId(),
      ip,
      createdAt: now,
      lastSeenAt: now,
      state: null,
    };
    this.byId.set(session.id, session);
    return { status: "active", session };
  }

  /** Keep a session alive. Returns false if it has already expired or was released. */
  touch(id: string | null | undefined): boolean {
    if (!id) return false;
    const now = this.clock.now();
    const session = this.byId.get(id);
    if (!session || !this.live(session, now)) return false;
    session.lastSeenAt = now;
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
    return this.byId.delete(id);
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
