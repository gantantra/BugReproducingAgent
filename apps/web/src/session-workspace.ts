import { copyFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * One folder per session, holding everything that session touched.
 *
 * A session is a conversation: the operator describes a bug, answers questions, names a target,
 * supplies a test account, approves a gate, and runs a batch. Before this, the pieces of that
 * conversation were scattered — the report in `reports/`, the evidence in `.investigator/`, the
 * credentials beside the config, the approvals somewhere else — and all of it shared one root
 * with every other session that had ever run. Answering "what did that session actually produce?"
 * meant reading timestamps across four directories and guessing.
 *
 * So a session folder is not a copy or an index of the real thing. It IS a workspace:
 *
 * ```
 * sessions/2026-09-12T10-14-33Z-3f9a1c/
 *   .investigator/
 *     config.yaml           seeded from the parent, so targets carry over
 *     investigator.db       this session's investigations, runs, jobs, lineage
 *     investigations/       manifests, normalized evidence, artifacts, videos, approvals
 *     .credentials.json     the test account the operator supplied, for this session only
 *   reports/                the operator's own words, each version they submitted
 *   session.json            what happened, in order
 * ```
 *
 * Every `investigate` command the page runs is given `--workspace <that folder>`, so the CLI puts
 * its output there for the same reason it would anywhere else: it was told to. Nothing is moved
 * afterwards and nothing is copied back, which is what makes the claim true rather than
 * maintained.
 *
 * Two consequences worth stating plainly, because they are trade-offs and not free:
 *
 *  - **Sessions do not share a database.** `investigate status` in one session cannot see another
 *    session's investigations. That is the point — a session is self-contained — but it means the
 *    folder, not the database, is now the unit you keep or delete.
 *  - **Deleting a session folder deletes its evidence.** There is no second copy elsewhere.
 */

/** `sessions/<timestamp>-<short id>`, sortable by name because the timestamp leads. */
export function sessionFolderName(createdAt: number, sessionId: string): string {
  const iso = new Date(createdAt)
    .toISOString()
    .replace(/[:.]/g, "-")
    .replace(/-\d{3}Z$/, "Z");
  // A short slice of the session id disambiguates two sessions created in the same second.
  const short =
    sessionId
      .replace(/[^A-Za-z0-9]/g, "")
      .slice(0, 6)
      .toLowerCase() || "000000";
  return `${iso}-${short}`;
}

export interface SessionWorkspace {
  /** The folder name under `sessions/`, which is also how the UI refers to the session. */
  name: string;
  /** Absolute path to the session folder. Contains `.investigator/`. */
  dir: string;
  /** True the first time this session's folder was created. */
  created: boolean;
}

/**
 * Resolve — and on first use create — the folder for one session.
 *
 * Idempotent: called on every request that needs a path, and cheap after the first. The parent
 * workspace's `config.yaml` is copied once, never re-copied, so a target the operator configures
 * mid-session is not silently reverted by the next request.
 */
export function ensureSessionWorkspace(
  rootWorkspace: string,
  createdAt: number,
  sessionId: string
): SessionWorkspace {
  const name = sessionFolderName(createdAt, sessionId);
  const dir = resolve(rootWorkspace, "sessions", name);
  const investigator = join(dir, ".investigator");
  const created = !existsSync(investigator);

  if (created) {
    for (const d of [investigator, join(investigator, "investigations"), join(dir, "reports")]) {
      mkdirSync(d, { recursive: true });
    }
    seedConfig(rootWorkspace, investigator);
  }

  return { name, dir, created };
}

/**
 * Give the new session the parent workspace's configuration.
 *
 * Without this every session would start with no targets and no allowed origins, and the operator
 * would be asked to re-describe their environment each time — which is exactly the terminal
 * round-trip the page exists to remove. The parent's `config.yaml` is the operator's standing
 * setup; a session inherits it and may then diverge without affecting the next one.
 */
function seedConfig(rootWorkspace: string, investigatorDir: string): void {
  const target = join(investigatorDir, "config.yaml");
  if (existsSync(target)) return;

  const candidates = [
    join(rootWorkspace, ".investigator", "config.yaml"),
    join(rootWorkspace, "config.yaml"),
  ];
  for (const source of candidates) {
    if (existsSync(source)) {
      copyFileSync(source, target);
      return;
    }
  }
  // No parent config to inherit. `investigate init` writes a default one on first use; leaving
  // the file absent is better than fabricating a config that claims targets nobody configured.
}

/** Every session folder, newest first. The names sort lexically because the timestamp leads. */
export function listSessionFolders(rootWorkspace: string): string[] {
  const dir = resolve(rootWorkspace, "sessions");
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()
    .reverse();
}

/**
 * Append one line to the session's own record of what happened.
 *
 * Deliberately a log, not a summary: it is written as events occur, so it survives a crash and
 * cannot drift from what actually ran. The chat transcript is stored separately by the session
 * store; this is the file-level history — which report was submitted, which gate was approved,
 * which batch ran.
 */
export function recordSessionEvent(sessionDir: string, event: Record<string, unknown>): void {
  const path = join(sessionDir, "session.jsonl");
  try {
    const line = `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`;
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(path, line, { encoding: "utf8", flag: "a" });
  } catch {
    // A session log that cannot be written must never stop the investigation it is describing.
  }
}
