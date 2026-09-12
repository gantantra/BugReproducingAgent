import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
  unlinkSync,
} from "node:fs";
import { dirname, join } from "node:path";

import type { Session, SessionPersistence, User } from "./sessions.js";

/**
 * Users and sessions on the host's own disk.
 *
 * Two files, one per collection, inside the workspace: `users.json` and `sessions.json` under
 * `<workspace>/.web/`. Deliberately NOT under `.investigator/`, which is the schema-governed
 * evidence tree — chat state is not evidence and must not look like it to anything walking that
 * directory.
 *
 * What this means for the transcript: it carries the reporter's own words, which routinely include
 * test-account credentials. Writing it here puts it exactly where the report file already lives —
 * inside the workspace, which is gitignored and never leaves the machine. That is the whole reason
 * it is stored on the host rather than anywhere remote.
 *
 * Writes are atomic. A half-written sessions file read back at startup would present a corrupt
 * transcript as a real one, so every write lands in a temporary file and is renamed over the
 * target, which is atomic on both Windows and POSIX for a same-directory rename.
 */

interface Persisted {
  version: 1;
  users: User[];
  sessions: Session[];
}

const EMPTY: Persisted = { version: 1, users: [], sessions: [] };

function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    // A corrupt or truncated file is not worth failing the whole server for: the investigation
    // itself is durable in the workspace database, and only the chat transcript is lost.
    return fallback;
  }
}

function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  try {
    renameSync(tmp, path);
  } catch {
    // Windows can refuse a rename over a file another handle still holds. Fall back to a direct
    // write rather than leaving the temporary file behind and the target stale.
    writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    try {
      unlinkSync(tmp);
    } catch {
      /* the temporary file is not worth an error */
    }
  }
}

export class FileSessionPersistence implements SessionPersistence {
  readonly usersPath: string;
  readonly sessionsPath: string;

  constructor(workspace: string) {
    const dir = join(workspace, ".web");
    this.usersPath = join(dir, "users.json");
    this.sessionsPath = join(dir, "sessions.json");
  }

  loadUsers(): User[] {
    return readJson<Persisted>(this.usersPath, EMPTY).users ?? [];
  }

  saveUsers(users: User[]): void {
    writeJsonAtomic(this.usersPath, { version: 1, users, sessions: [] });
  }

  loadSessions(): Session[] {
    return readJson<Persisted>(this.sessionsPath, EMPTY).sessions ?? [];
  }

  saveSessions(sessions: Session[]): void {
    writeJsonAtomic(this.sessionsPath, { version: 1, users: [], sessions });
  }
}

/** Used where persistence is not wanted, so the store's own logic stays independent of disk. */
export const noPersistence: SessionPersistence = {
  loadUsers: () => [],
  saveUsers: () => {},
  loadSessions: () => [],
  saveSessions: () => {},
};
