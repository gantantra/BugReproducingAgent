import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import { randomUUID, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, extname, join, resolve, sep } from "node:path";

import {
  ACTIONS,
  ParamError,
  artifactRequest,
  findAction,
  suiteVideoRequest,
  type BuildContext,
  type Params,
} from "./actions.js";
import { SessionStore, normalizeIp, readCookie } from "./sessions.js";
import { FileSessionPersistence } from "./storage.js";
import { readTargets, targetFromReport, validateTargetRequest, writeTarget } from "./target.js";
import {
  ensureSessionWorkspace,
  listSessionFolders,
  recordSessionEvent,
} from "./session-workspace.js";
import { CredentialStore } from "@investigator/storage";
import { extractCredentials } from "@investigator/ai-flows";

/**
 * A local chat front end for the investigator.
 *
 * It owns no part of the pipeline. Every action spawns the same `investigate` binary an operator
 * would type, with `--json`, and renders the answer. That is deliberate rather than lazy: the
 * approval gates, the redaction boundary and the API key all live inside that process, so a bug in
 * this file cannot approve a gate the CLI would refuse, write an unredacted byte, or read the key.
 *
 * Exposure: it binds loopback only, requires a token minted at startup on every API call, and
 * refuses a cross-origin request. It runs processes on the operator's machine, so it is treated as
 * a privileged local surface, not a web app.
 */

/** `dist/` sits beside `public/`, so the assets are one level up from the compiled file. */
const PUBLIC_DIR = resolve(__dirname, "..", "public");

export interface ServerOptions {
  workspace: string;
  cliBin: string;
  port: number;
  token: string;
  /** Where the CLI is spawned from: the operator's launch directory, so `.env` resolves as usual. */
  launchDir: string;
  /** How long a chat session survives without a heartbeat. Default 60s. */
  sessionTtlMs?: number;
}

interface Job {
  id: string;
  action: string;
  status: "running" | "complete" | "failed";
  lines: string[];
  result: unknown;
  exitCode: number | null;
  listeners: Set<ServerResponse>;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".webm": "video/webm",
  ".mp4": "video/mp4",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".zip": "application/zip",
  ".bin": "application/octet-stream",
};

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(text);
}

async function readBody(req: IncomingMessage, limitBytes = 1_000_000): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > limitBytes) throw new Error("request body too large");
    chunks.push(buf);
  }
  if (size === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export function createInvestigatorServer(opts: ServerOptions) {
  const jobs = new Map<string, Job>();
  const origin = `http://127.0.0.1:${opts.port}`;
  const workspaceRoot = resolve(opts.workspace);
  // Users and sessions live on the host's own disk, inside the workspace, so they survive a
  // restart and never leave this machine.
  const persistence = new FileSessionPersistence(opts.workspace);
  const sessions = new SessionStore(
    () => randomUUID(),
    undefined,
    opts.sessionTtlMs ?? 7_200_000,
    persistence
  );
  const SESSION_COOKIE = "investigator_session";
  const USER_COOKIE = "investigator_user";

  /**
   * The folder this session owns, created on first use.
   *
   * Everything the session produces lands under it, because every command is given it as
   * `--workspace`. Falls back to the root workspace only for a request arriving without a known
   * session -- which cannot drive the CLI anyway, since those routes all require one.
   */
  function sessionDirFor(sessionId: string | null): string | null {
    if (!sessionId) return null;
    const session = sessions.get(sessionId);
    if (!session) return null;
    return ensureSessionWorkspace(workspaceRoot, session.createdAt, session.id).dir;
  }

  /**
   * Resolve the session's folder or refuse the request. There is no third option.
   *
   * An earlier version fell back to the shared root workspace when the session had lapsed, which
   * quietly undid the entire point: a report written after a 60-second gap landed in the root,
   * and the investigation it opened was created there too, mixed in with every other session's.
   * Nothing failed and nothing said so. Refusing is the honest answer -- the page already knows
   * how to re-acquire a session and resend, and a caller with no session has nowhere to write.
   */
  function requireSessionDir(res: ServerResponse, sessionId: string | null): string | null {
    const dir = sessionDirFor(sessionId);
    if (dir) return dir;
    sendJson(res, 409, {
      ok: false,
      code: "SESSION_EXPIRED",
      message: "your session has expired — refresh the page to start a new one",
    });
    return null;
  }

  /** This session's credentials. Rooted in the session folder, so they die with it. */
  function credentialsFor(sessionDir: string): CredentialStore {
    return new CredentialStore(join(sessionDir, ".investigator"));
  }

  /**
   * Turn a validated workspace-relative path into an absolute one, refusing anything that lands
   * outside THIS SESSION's workspace. The regex already bans traversal; this is the second,
   * positive check, because a path that escapes here would be handed straight to a process.
   *
   * Bound per request rather than once, so one session cannot name a path into another's folder.
   */
  function buildContextFor(sessionDir: string): BuildContext {
    const root = resolve(sessionDir);
    return {
      inWorkspace(rel: string): string {
        const full = resolve(root, rel);
        if (full !== root && !full.startsWith(root + sep)) {
          throw new ParamError("path", `path escapes the workspace: ${rel}`);
        }
        return full;
      },
    };
  }

  /** Spawn the CLI. stdout carries JSON; stderr carries the human lines we stream to the log. */
  function runCli(
    argv: string[],
    workspace: string,
    onLine?: (line: string) => void
  ): Promise<{ json: unknown; text: string; exitCode: number | null }> {
    return new Promise((resolvePromise) => {
      // The session's own folder, not the shared root: this is what puts a session's database,
      // artifacts, videos and approvals inside the session folder rather than beside everyone
      // else's. The CLI needs no knowledge of sessions to make that true.
      const full = [...argv, "--workspace", workspace, "--json"];
      const child = spawn(process.execPath, [opts.cliBin, ...full], {
        // The directory the operator launched the UI from, which is where a `.env` sits and where
        // they would have run the command by hand. Paths from the browser are made absolute
        // against the workspace before they reach argv, so cwd never has to serve both roles.
        cwd: opts.launchDir,
        // The key is never read here. The child reads it from its own environment, exactly as it
        // does when a person runs the command, and it is never echoed back to the browser.
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });

      let out = "";
      let err = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (d: string) => (out += d));
      child.stderr.on("data", (d: string) => {
        err += d;
        if (!onLine) return;
        const parts = err.split(/\r?\n/);
        err = parts.pop() ?? "";
        for (const line of parts) if (line.trim()) onLine(line);
      });

      child.on("error", (e) => {
        resolvePromise({ json: null, text: `failed to start the CLI: ${e.message}`, exitCode: -1 });
      });

      child.on("close", (code) => {
        if (err.trim() && onLine) onLine(err.trim());
        let parsed: unknown = null;
        const trimmed = out.trim();
        if (trimmed) {
          try {
            parsed = JSON.parse(trimmed);
          } catch {
            parsed = null;
          }
        }
        resolvePromise({ json: parsed, text: (err || out).trim(), exitCode: code });
      });
    });
  }

  function pushJobEvent(job: Job, event: string, data: unknown): void {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const listener of job.listeners) listener.write(payload);
  }

  function startJob(
    actionId: string,
    argv: string[],
    workspace: string,
    sessionId?: string | null
  ): Job {
    const job: Job = {
      id: randomUUID(),
      action: actionId,
      status: "running",
      lines: [],
      result: null,
      exitCode: null,
      listeners: new Set(),
    };
    jobs.set(job.id, job);

    const keepAliveTimer = sessionId
      ? setInterval(() => {
          sessions.touch(sessionId);
        }, 15_000)
      : null;

    void runCli(argv, workspace, (line) => {
      job.lines.push(line);
      pushJobEvent(job, "log", { line });
    }).then(({ json, text, exitCode }) => {
      if (keepAliveTimer) clearInterval(keepAliveTimer);
      if (sessionId) sessions.touch(sessionId);
      job.result = json ?? { ok: exitCode === 0, message: text };
      job.exitCode = exitCode;
      job.status = exitCode === 0 ? "complete" : "failed";
      pushJobEvent(job, "done", { status: job.status, exitCode, result: job.result });
      for (const listener of job.listeners) listener.end();
      job.listeners.clear();
    });

    return job;
  }

  /**
   * The first video Playwright recorded on the authored suite's last run, as listed in its own
   * report. The path comes from the report, not the request, and is served only if it resolves
   * inside the suite's `artifacts/` folder and is a `.webm`.
   */
  function findSuiteVideo(workspace: string, investigation: string): string | null {
    const artifacts = resolve(
      workspace,
      ".investigator",
      "investigations",
      investigation,
      "authoring",
      "suite",
      "artifacts"
    );
    const reportPath = join(artifacts, "last-run.report.json");
    if (!existsSync(reportPath)) return null;
    let report: unknown;
    try {
      report = JSON.parse(readFileSync(reportPath, "utf8"));
    } catch {
      return null;
    }
    let found: string | null = null;
    const walk = (suite: unknown): void => {
      const s = suite as { suites?: unknown[]; specs?: unknown[] } | null;
      if (found || !s || typeof s !== "object") return;
      for (const spec of s.specs ?? []) {
        for (const test of (spec as { tests?: unknown[] }).tests ?? []) {
          for (const result of (test as { results?: unknown[] }).results ?? []) {
            const attachments =
              (result as { attachments?: Array<{ name?: string; path?: string }> }).attachments ??
              [];
            const video = attachments.find((a) => a.name === "video" && typeof a.path === "string");
            if (video?.path) {
              found = video.path;
              return;
            }
          }
        }
      }
      for (const child of s.suites ?? []) walk(child);
    };
    walk(report);
    if (!found) return null;
    const full = resolve(artifacts, found);
    if (!full.startsWith(artifacts + sep)) return null;
    if (extname(full).toLowerCase() !== ".webm" || !existsSync(full)) return null;
    return full;
  }

  /** Locate an artifact by content hash. The layout is `<kind>/<first two hex>/<sha>.<ext>`. */
  function findArtifact(
    workspace: string,
    investigation: string,
    kind: string,
    sha: string
  ): string | null {
    const dir = join(
      workspace,
      ".investigator",
      "investigations",
      investigation,
      "artifacts",
      kind,
      sha.slice(0, 2)
    );
    if (!existsSync(dir)) return null;
    const match = readdirSync(dir).find((f) => f.startsWith(`${sha}.`) || f === sha);
    if (!match) return null;
    const full = resolve(dir, match);
    // Containment: refuse anything that resolved outside the workspace, whatever the inputs did.
    const root = resolve(workspace) + sep;
    return full.startsWith(root) ? full : null;
  }

  function authorised(req: IncomingMessage, url?: URL): boolean {
    const headerToken = req.headers["x-investigator-token"];
    const queryToken = url?.searchParams.get("token");
    const sent =
      (typeof headerToken === "string" ? headerToken : undefined) ??
      (typeof queryToken === "string" ? queryToken : undefined);
    if (typeof sent !== "string" || sent !== opts.token) return false;
    // A page on another origin must not be able to drive a process runner on this machine.
    const reqOrigin = req.headers.origin;
    if (typeof reqOrigin === "string" && reqOrigin !== origin) return false;
    return true;
  }

  function serveStatic(res: ServerResponse, pathname: string): void {
    const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
    const full = resolve(PUBLIC_DIR, rel);
    if (!full.startsWith(resolve(PUBLIC_DIR) + sep) || !existsSync(full)) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return;
    }
    const ext = extname(full).toLowerCase();
    let body = readFileSync(full);
    if (rel === "index.html") {
      // The page needs the token to call the API. Injecting it here keeps it out of the URL bar,
      // browser history, and any link the operator might paste somewhere.
      body = Buffer.from(
        body
          .toString("utf8")
          .replace("__TOKEN__", opts.token)
          .replace("__WORKSPACE__", opts.workspace),
        "utf8"
      );
    }
    res.writeHead(200, {
      "content-type": MIME[ext] ?? "application/octet-stream",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    res.end(body);
  }

  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", origin);
      const path = url.pathname;

      if (!path.startsWith("/api/")) {
        serveStatic(res, path);
        return;
      }

      if (!authorised(req, url)) {
        sendJson(res, 403, { ok: false, code: "FORBIDDEN", message: "bad or missing token" });
        return;
      }

      const sessionId =
        readCookie(req.headers.cookie, SESSION_COOKIE) ?? url.searchParams.get("session");
      const userId = readCookie(req.headers.cookie, USER_COOKIE);
      const clientIp = normalizeIp(req.socket.remoteAddress);

      try {
        /**
         * Resume this browser's session, or start one.
         *
         * A second tab used to be refused with SESSION_IN_USE, because every session shared one
         * workspace database and one investigation sequence. Sessions own separate folders now,
         * so there is nothing left to collide over and nothing here returns `busy`.
         */
        if (path === "/api/session" && req.method === "GET") {
          const result = sessions.acquire(clientIp, sessionId, userId);
          // HttpOnly: the page never needs to read either, and script cannot leak them. The user
          // cookie outlives the session so a returning browser is recognised as the same person;
          // it identifies a browser, not a person who logged in, and carries no credential.
          res.setHeader("set-cookie", [
            `${SESSION_COOKIE}=${encodeURIComponent(result.session.id)}; Path=/; HttpOnly; SameSite=Strict`,
            `${USER_COOKIE}=${encodeURIComponent(result.session.userId)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000`,
          ]);
          const owner = sessions.getUser(result.session.userId);
          // Create the session's folder now, at the moment the session becomes real, and tell the
          // page where it is. The page renders the root workspace until this arrives, because the
          // folder does not exist before a session claims it.
          const ws = ensureSessionWorkspace(
            workspaceRoot,
            result.session.createdAt,
            result.session.id
          );
          if (ws.created) recordSessionEvent(ws.dir, { kind: "session-opened", folder: ws.name });
          sendJson(res, 200, {
            ok: true,
            status: "active",
            resumed: result.session.state !== null,
            createdAt: result.session.createdAt,
            workspace: ws.dir,
            sessionFolder: ws.name,
            sessionFolders: listSessionFolders(workspaceRoot).slice(0, 50),
            ttlMs: sessions.ttlMs,
            state: result.session.state,
            user: owner
              ? { id: owner.id, firstSeen: owner.createdAt, sessions: owner.sessionCount }
              : null,
          });
          return;
        }

        if (path === "/api/session/state" && req.method === "POST") {
          const body = (await readBody(req, 4_000_000)) as { state?: unknown };
          const stored = sessions.setState(sessionId, body.state ?? null);
          if (!stored) {
            sendJson(res, 409, {
              ok: false,
              code: "SESSION_EXPIRED",
              message: "This session is no longer active. Refresh to start a new one.",
            });
            return;
          }
          sendJson(res, 200, { ok: true });
          return;
        }

        if (path === "/api/session/heartbeat" && req.method === "POST") {
          const alive = sessions.touch(sessionId);
          sendJson(res, alive ? 200 : 409, {
            ok: alive,
            code: alive ? undefined : "SESSION_EXPIRED",
          });
          return;
        }

        // Sent by the page as it unloads, so the next tab does not wait out the whole TTL.
        if (path === "/api/session/release" && req.method === "POST") {
          sessions.release(sessionId);
          res.setHeader(
            "set-cookie",
            `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`
          );
          sendJson(res, 200, { ok: true });
          return;
        }

        /* Targets, asked for in the conversation instead of hand-edited into config.yaml.
         * The agent cannot plan an experiment without one: `get_application_constraints` returns
         * NOT_FOUND and the model correctly declines to propose anything it cannot ground. */
        if (path === "/api/targets" && req.method === "GET") {
          const dir = requireSessionDir(res, sessionId);
          if (!dir) return;
          sessions.touch(sessionId);
          sendJson(res, 200, { ok: true, targets: readTargets(dir) });
          return;
        }

        if (path === "/api/targets" && req.method === "POST") {
          const sessionWs = requireSessionDir(res, sessionId);
          if (!sessionWs) return;
          sessions.touch(sessionId);
          const written = writeTarget(sessionWs, validateTargetRequest(await readBody(req)));
          recordSessionEvent(sessionWs, {
            kind: "target",
            name: written.name,
            baseUrl: written.baseUrl,
          });
          sendJson(res, 200, { ok: true, target: written });
          return;
        }

        /* The target named in the report, recorded without asking the operator to repeat it.
         *
         * `target: null` means the text names no web address, and only then does the page ask. The
         * same route records an address the operator types into that box, so a typed address and one
         * found in a report go through one derivation and one validation. */
        if (path === "/api/targets/from-report" && req.method === "POST") {
          const sessionWs = requireSessionDir(res, sessionId);
          if (!sessionWs) return;
          sessions.touch(sessionId);
          const body = (await readBody(req)) as { text?: unknown };
          const derived = targetFromReport(typeof body.text === "string" ? body.text : "");
          if (!derived) {
            sendJson(res, 200, { ok: true, target: null });
            return;
          }
          const written = writeTarget(sessionWs, derived);
          recordSessionEvent(sessionWs, {
            kind: "target",
            name: written.name,
            baseUrl: written.baseUrl,
            source: "report",
          });
          sendJson(res, 200, { ok: true, target: written });
          return;
        }

        /* Test-account credentials, supplied by the operator so a flow that must sign in can.
         *
         * Deliberately NOT an allowlist action. Every other capability here spawns `investigate`
         * with arguments, and a credential on a command line is readable by every process on the
         * machine and lands in the action log the operator can see. This route writes the value
         * straight into the workspace credential store instead, so it never becomes argv and
         * never becomes a log line.
         *
         * GET returns NAMES and masked ENTRIES with descriptions. There is no route that reads a value
         * back out: the executor resolves one in its own process, and nothing else needs to. */
        if (path === "/api/credentials" && req.method === "GET") {
          const dir = requireSessionDir(res, sessionId);
          if (!dir) return;
          sessions.touch(sessionId);
          const store = credentialsFor(dir);
          sendJson(res, 200, { ok: true, names: store.names(), entries: store.entries() });
          return;
        }

        if (path === "/api/credentials" && req.method === "POST") {
          const dir = requireSessionDir(res, sessionId);
          if (!dir) return;
          sessions.touch(sessionId);
          const body = (await readBody(req)) as {
            name?: unknown;
            value?: unknown;
            description?: unknown;
          };
          const name = typeof body.name === "string" ? body.name : "";
          const value = typeof body.value === "string" ? body.value : "";
          const description =
            typeof body.description === "string" ? body.description.trim() : undefined;
          if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(name)) {
            sendJson(res, 400, {
              ok: false,
              code: "BAD_NAME",
              message: "a credential name must be UPPER_SNAKE_CASE",
            });
            return;
          }
          if (value.length === 0 || value.length > 4096) {
            // Says that the value was unusable. Never says what it was.
            sendJson(res, 400, {
              ok: false,
              code: "BAD_VALUE",
              message: "a credential value must be between 1 and 4096 characters",
            });
            return;
          }
          const store = credentialsFor(dir);
          store.set(name, value, description);
          // The NAME is recorded so the session's history shows a credential was supplied. The
          // value is not, here or anywhere else this process writes.
          recordSessionEvent(dir, { kind: "credential", name });
          sendJson(res, 200, { ok: true, name, names: store.names(), entries: store.entries() });
          return;
        }

        if (path === "/api/credentials" && req.method === "DELETE") {
          const dir = requireSessionDir(res, sessionId);
          if (!dir) return;
          sessions.touch(sessionId);
          const name = url.searchParams.get("name") ?? "";
          if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(name)) {
            sendJson(res, 400, { ok: false, code: "BAD_NAME", message: "refused" });
            return;
          }
          const store = credentialsFor(dir);
          const removed = store.delete(name);
          sendJson(res, 200, { ok: true, removed, names: store.names(), entries: store.entries() });
          return;
        }

        if (path === "/api/credentials/extract" && req.method === "POST") {
          const dir = requireSessionDir(res, sessionId);
          if (!dir) return;
          sessions.touch(sessionId);
          const body = (await readBody(req)) as { text?: unknown; question?: unknown };
          const text = typeof body.text === "string" ? body.text : "";
          const question = typeof body.question === "string" ? body.question : undefined;
          if (!text.trim()) {
            sendJson(res, 400, {
              ok: false,
              code: "BAD_PARAM",
              message: "text is required",
            });
            return;
          }
          const result = await extractCredentials(text, question ? { question } : undefined);
          const store = credentialsFor(dir);
          for (const item of result.extracted) {
            store.set(item.name, item.value, item.description);
            recordSessionEvent(dir, { kind: "credential", name: item.name });
          }
          sendJson(res, 200, {
            ok: true,
            extracted: result.extracted.map((e) => ({ name: e.name, description: e.description })),
            // The reply as the operator wrote it, secrets swapped for their names. It carries no
            // value, so it can go back to the page and on to the model.
            referencedText: result.referencedText,
            names: store.names(),
            entries: store.entries(),
          });
          return;
        }

        if (path === "/api/actions" && req.method === "GET") {
          sendJson(res, 200, {
            ok: true,
            workspace: sessionDirFor(sessionId) ?? workspaceRoot,
            actions: ACTIONS.map((a) => ({ id: a.id, summary: a.summary, streams: a.streams })),
          });
          return;
        }

        // The operator's own words, written to a file the CLI reads. Kept inside the workspace,
        // which is gitignored, because a bug report routinely contains test-account credentials.
        if (path === "/api/report" && req.method === "POST") {
          const body = (await readBody(req)) as { text?: unknown; name?: unknown };
          const text = typeof body.text === "string" ? body.text : "";
          if (!text.trim()) {
            sendJson(res, 400, { ok: false, code: "EMPTY_REPORT", message: "report is empty" });
            return;
          }
          const name =
            typeof body.name === "string" && /^[A-Za-z0-9._-]{1,60}$/.test(body.name)
              ? body.name
              : "report.md";
          const sessionWs = requireSessionDir(res, sessionId);
          if (!sessionWs) return;
          sessions.touch(sessionId);
          const dir = resolve(sessionWs, "reports");
          mkdirSync(dir, { recursive: true });
          const full = resolve(dir, name);
          if (!full.startsWith(resolve(sessionWs) + sep)) {
            sendJson(res, 400, { ok: false, code: "BAD_PATH", message: "refused" });
            return;
          }
          writeFileSync(full, text, "utf8");

          // Keep every version the operator submitted, not just the last one.
          //
          // The interview rewrites the report each time an answer is folded back in, so the file
          // the CLI reads is overwritten repeatedly. Without this, the reporter's original words
          // -- the only thing in the whole pipeline that is not derived from something else --
          // would be destroyed by the first clarification they gave.
          const stamp = new Date()
            .toISOString()
            .replace(/[:.]/g, "-")
            .replace(/-\d{3}Z$/, "Z");
          const versions = resolve(dir, "versions");
          mkdirSync(versions, { recursive: true });
          writeFileSync(resolve(versions, `${stamp}-${name}`), text, "utf8");
          recordSessionEvent(sessionWs, {
            kind: "report",
            path: `reports/${name}`,
            version: `reports/versions/${stamp}-${name}`,
            bytes: Buffer.byteLength(text),
          });

          sendJson(res, 200, { ok: true, path: `reports/${name}`, bytes: Buffer.byteLength(text) });
          return;
        }

        if (path === "/api/action" && req.method === "POST") {
          // Driving the agent is activity: a long batch must not let the session lapse.
          sessions.touch(sessionId);
          const body = (await readBody(req)) as { action?: unknown; params?: Params };
          const action = findAction(body.action);
          if (!action) {
            sendJson(res, 400, {
              ok: false,
              code: "UNKNOWN_ACTION",
              message: `no such action: ${String(body.action)}`,
            });
            return;
          }
          const sessionWs = requireSessionDir(res, sessionId);
          if (!sessionWs) return;
          const argv = action.build(body.params ?? {}, buildContextFor(sessionWs));
          recordSessionEvent(sessionWs, { kind: "action", action: action.id, argv });

          if (action.streams) {
            const job = startJob(action.id, argv, sessionWs, sessionId);
            sendJson(res, 202, { ok: true, jobId: job.id, argv, summary: action.summary });
            return;
          }

          const { json, text, exitCode } = await runCli(argv, sessionWs);
          sendJson(res, 200, {
            ok: true,
            argv,
            exitCode,
            result: json ?? { ok: exitCode === 0, message: text },
            text,
          });
          return;
        }

        if (path.startsWith("/api/job/") && req.method === "GET") {
          const id = path.slice("/api/job/".length).replace(/\/events$/, "");
          const job = jobs.get(id);
          if (!job) {
            sendJson(res, 404, { ok: false, code: "NO_SUCH_JOB", message: "unknown job" });
            return;
          }
          if (!path.endsWith("/events")) {
            sendJson(res, 200, {
              ok: true,
              status: job.status,
              exitCode: job.exitCode,
              lines: job.lines,
              result: job.result,
            });
            return;
          }
          res.writeHead(200, {
            "content-type": "text/event-stream",
            "cache-control": "no-store",
            connection: "keep-alive",
          });
          for (const line of job.lines) {
            res.write(`event: log\ndata: ${JSON.stringify({ line })}\n\n`);
          }
          if (job.status !== "running") {
            res.write(
              `event: done\ndata: ${JSON.stringify({
                status: job.status,
                exitCode: job.exitCode,
                result: job.result,
              })}\n\n`
            );
            res.end();
            return;
          }
          job.listeners.add(res);
          req.on("close", () => job.listeners.delete(res));
          return;
        }

        if (path === "/api/artifact" && req.method === "GET") {
          const { investigation, kind, sha } = artifactRequest(url.searchParams);
          const dir = requireSessionDir(res, sessionId);
          if (!dir) return;
          const full = findArtifact(dir, investigation, kind, sha);
          if (!full) {
            sendJson(res, 404, { ok: false, code: "NO_SUCH_ARTIFACT", message: "not found" });
            return;
          }
          const ext = extname(full).toLowerCase();
          res.writeHead(200, {
            "content-type": MIME[ext] ?? "application/octet-stream",
            "cache-control": "no-store",
            "x-content-type-options": "nosniff",
          });
          res.end(readFileSync(full));
          return;
        }

        if (path === "/api/suite-video" && req.method === "GET") {
          const { investigation } = suiteVideoRequest(url.searchParams);
          const dir = requireSessionDir(res, sessionId);
          if (!dir) return;
          const full = findSuiteVideo(dir, investigation);
          if (!full) {
            sendJson(res, 404, { ok: false, code: "NO_SUCH_ARTIFACT", message: "not found" });
            return;
          }
          res.writeHead(200, {
            "content-type": MIME[".webm"] ?? "video/webm",
            "cache-control": "no-store",
            "x-content-type-options": "nosniff",
          });
          res.end(readFileSync(full));
          return;
        }

        if (path === "/api/session-image" && req.method === "GET") {
          const fileParam = url.searchParams.get("file") ?? "";
          if (!fileParam) {
            sendJson(res, 400, {
              ok: false,
              code: "BAD_PARAM",
              message: "file parameter required",
            });
            return;
          }
          const dir = requireSessionDir(res, sessionId);
          if (!dir) return;
          let full = resolve(dir, fileParam);
          const root = resolve(dir) + sep;
          if (!full.startsWith(root) || !existsSync(full)) {
            const folderName = basename(dir);
            if (fileParam.startsWith(folderName + "/") || fileParam.startsWith(folderName + "\\")) {
              const alt = resolve(dir, fileParam.slice(folderName.length + 1));
              if (alt.startsWith(root) && existsSync(alt)) {
                full = alt;
              }
            }
          }
          if (!full.startsWith(root) || !existsSync(full)) {
            sendJson(res, 404, { ok: false, code: "NOT_FOUND", message: "image not found" });
            return;
          }
          const ext = extname(full).toLowerCase();
          if (![".png", ".jpg", ".jpeg", ".webp", ".gif"].includes(ext)) {
            sendJson(res, 403, { ok: false, code: "FORBIDDEN", message: "not an image" });
            return;
          }
          res.writeHead(200, {
            "content-type": MIME[ext] ?? "image/png",
            "cache-control": "no-store",
            "x-content-type-options": "nosniff",
          });
          res.end(readFileSync(full));
          return;
        }

        sendJson(res, 404, { ok: false, code: "NO_SUCH_ROUTE", message: path });
      } catch (e) {
        if (e instanceof ParamError) {
          sendJson(res, 400, { ok: false, code: "BAD_PARAM", param: e.param, message: e.message });
          return;
        }
        sendJson(res, 500, {
          ok: false,
          code: "SERVER_ERROR",
          message: e instanceof Error ? e.message : String(e),
        });
      }
    })();
  });

  return server;
}

export function mintToken(): string {
  return randomBytes(24).toString("hex");
}
