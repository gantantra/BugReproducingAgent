import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Handing a failed replay back to the session that recorded the script.
 *
 * The agent replays a freshly authored script before offering N runs of it. A replay that stops
 * BEFORE the final check is the script, not the bug: the site offered a path it did not record, or
 * it raced a step that had not finished. The session that recorded it is the one thing that can fix
 * that — it has the browser, the profile and the context — so it is told exactly where the replay
 * stopped, what it was waiting for, and what the page showed, and it records the flow again.
 *
 * A replay that fails AT the final check is never sent back. That may be the bug itself, and
 * "repairing" it would be recording a workaround for the thing being measured.
 */

export interface RepairStop {
  line: number | null;
  statement: string;
  waitingFor: string | null;
  runs: number;
  /** What the page showed when the run stopped, from Playwright's own error context. */
  pageSnapshot?: string;
}

export interface RepairEvidence {
  repetitions: number;
  reachedCheck: number;
  stoppedEarly: number;
  stops: RepairStop[];
}

/** The page snapshot Playwright writes into `error-context.md`, trimmed to what fits a prompt. */
export function pageSnapshotFrom(markdown: string, maxLines = 80): string | null {
  const m = /# Page snapshot\s*```(?:yaml)?\r?\n([\s\S]*?)```/.exec(markdown);
  if (!m) return null;
  const lines = m[1]!.replace(/\s+$/, "").split(/\r?\n/);
  if (lines.length <= maxLines) return lines.join("\n");
  return [...lines.slice(0, maxLines), `… (${lines.length - maxLines} more lines)`].join("\n");
}

/** The evidence `rerun` saved beside its report, or null when there is none to repair from. */
export function readRepairEvidence(suiteDir: string): RepairEvidence | null {
  const path = join(suiteDir, "artifacts", "last-run.evidence.json");
  if (!existsSync(path)) return null;

  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!Array.isArray(raw["stops"]) || typeof raw["stoppedEarly"] !== "number") return null;

  const stops = (raw["stops"] as Array<Record<string, unknown>>).slice(0, 3).map((s): RepairStop => {
    const contextPath = typeof s["errorContextPath"] === "string" ? s["errorContextPath"] : null;
    const pageSnapshot =
      contextPath && existsSync(contextPath) ? pageSnapshotFrom(readFileSync(contextPath, "utf8")) : null;
    return {
      line: typeof s["line"] === "number" ? s["line"] : null,
      statement: String(s["statement"] ?? ""),
      waitingFor: typeof s["waitingFor"] === "string" ? s["waitingFor"] : null,
      runs: typeof s["runs"] === "number" ? s["runs"] : 1,
      ...(pageSnapshot ? { pageSnapshot } : {}),
    };
  });

  return {
    repetitions: typeof raw["repetitions"] === "number" ? raw["repetitions"] : 0,
    reachedCheck: typeof raw["reachedCheck"] === "number" ? raw["reachedCheck"] : 0,
    stoppedEarly: raw["stoppedEarly"],
    stops,
  };
}

/** What the session is told when its script did not get through a replay. */
export function buildRepairPrompt(e: RepairEvidence): string {
  const lines = [
    "The script you recorded was replayed, and it did not get through to the final check.",
    "",
    `Of ${e.repetitions} replay(s), ${e.reachedCheck} reached the final check and ${e.stoppedEarly} stopped before it:`,
  ];
  for (const s of e.stops) {
    const where =
      s.line !== null ? `at script line ${s.line}: \`${s.statement}\`` : `before the first step: ${s.statement}`;
    lines.push(`- ${s.runs} run(s) stopped ${where}${s.waitingFor ? ` — waiting for ${s.waitingFor}, which never appeared` : ""}.`);
  }

  const withSnapshot = e.stops.find((s) => s.pageSnapshot);
  if (withSnapshot) {
    lines.push("", "What the page showed at that moment:", "", "```yaml", withSnapshot.pageSnapshot!, "```");
  }

  lines.push(
    "",
    "The browser has restarted on the same profile. The site is now in whatever state the replays left it in — an account a replay created is still there, for instance — and that is the state you start from.",
    "",
    "Record the whole flow again, from the very start, as one clean attempt. This recording replaces the old one completely, so every step has to be in it, not only the part that failed.",
    "",
    "Make it hold on the runs after this one too:",
    "- after anything you submit, record a browser_wait_for on proof it went through, before navigating;",
    "- declare with OPTIONAL any screen a later run may not see — including the one the replay did not find, if it only appears in some states.",
    "",
    "End with the check on the outcome, then AUTHORING: DONE."
  );
  return lines.join("\n");
}
