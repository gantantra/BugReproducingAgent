import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import { randomUUID, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { extname, join, resolve, sep } from "node:path";

import {
  ACTIONS,
  ParamError,
  artifactRequest,
  findAction,
  type BuildContext,
  type Params,
} from "./actions.js";
import { SessionStore, normalizeIp, readCookie } from "./sessions.js";
import { FileSessionPersistence } from "./storage.js";
import { readTargets, validateTargetRequest, writeTarget } from "./target.js";

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
    opts.sessionTtlMs ?? 60_000,
    persistence
  );
  const SESSION_COOKIE = "investigator_session";
  const USER_COOKIE = "investigator_user";

  /**
   * Turn a validated workspace-relative path into an absolute one, refusing anything that lands
   * outside the workspace. The regex already bans traversal; this is the second, positive check,
   * because a path that escapes here would be handed straight to a process.
   */
  const buildContext: BuildContext = {
    inWorkspace(rel: string): string {
      const full = resolve(workspaceRoot, rel);
      if (full !== workspaceRoot && !full.startsWith(workspaceRoot + sep)) {
        throw new ParamError("path", `path escapes the workspace: ${rel}`);
      }
      return full;
    },
  };

  /** Spawn the CLI. stdout carries JSON; stderr carries the human lines we stream to the log. */
  function runCli(
    argv: string[],
    onLine?: (line: string) => void
  ): Promise<{ json: unknown; text: string; exitCode: number | null }> {
    return new Promise((resolvePromise) => {
      const full = [...argv, "--workspace", opts.workspace, "--json"];
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

  function startJob(actionId: string, argv: string[]): Job {
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

    void runCli(argv, (line) => {
      job.lines.push(line);
      pushJobEvent(job, "log", { line });
    }).then(({ json, text, exitCode }) => {
      job.result = json ?? { ok: exitCode === 0, message: text };
      job.exitCode = exitCode;
      job.status = exitCode === 0 ? "complete" : "failed";
      pushJobEvent(job, "done", { status: job.status, exitCode, result: job.result });
      for (const listener of job.listeners) listener.end();
      job.listeners.clear();
    });

    return job;
  }

  /** Locate an artifact by content hash. The layout is `<kind>/<first two hex>/<sha>.<ext>`. */
  function findArtifact(investigation: string, kind: string, sha: string): string | null {
    const dir = join(
      opts.workspace,
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
    const root = resolve(opts.workspace) + sep;
    return full.startsWith(root) ? full : null;
  }

  function authorised(req: IncomingMessage): boolean {
    const sent = req.headers["x-investigator-token"];
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

      if (!authorised(req)) {
        sendJson(res, 403, { ok: false, code: "FORBIDDEN", message: "bad or missing token" });
        return;
      }

      const sessionId = readCookie(req.headers.cookie, SESSION_COOKIE);
      const userId = readCookie(req.headers.cookie, USER_COOKIE);
      const clientIp = normalizeIp(req.socket.remoteAddress);

      try {
        /**
         * Claim or resume the session for this address. The cookie is what survives a refresh;
         * the address is what makes a second browser on the same machine wait rather than
         * silently start a rival transcript against the same workspace.
         */
        if (path === "/api/session" && req.method === "GET") {
          const result = sessions.acquire(clientIp, sessionId, userId);
          if (result.status === "busy") {
            sendJson(res, 409, {
              ok: false,
              code: "SESSION_IN_USE",
              message:
                "Another session is already running on your machine. Close that tab or window " +
                "first, then refresh here to use the agent.",
              heldSince: result.heldSince,
              lastSeenAt: result.lastSeenAt,
              expiresInMs: result.expiresInMs,
              ttlMs: sessions.ttlMs,
            });
            return;
          }
          // HttpOnly: the page never needs to read either, and script cannot leak them. The user
          // cookie outlives the session so a returning browser is recognised as the same person;
          // it identifies a browser, not a person who logged in, and carries no credential.
          res.setHeader("set-cookie", [
            `${SESSION_COOKIE}=${encodeURIComponent(result.session.id)}; Path=/; HttpOnly; SameSite=Strict`,
            `${USER_COOKIE}=${encodeURIComponent(result.session.userId)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000`,
          ]);
          const owner = sessions.getUser(result.session.userId);
          sendJson(res, 200, {
            ok: true,
            status: "active",
            resumed: result.session.state !== null,
            createdAt: result.session.createdAt,
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
          sendJson(res, 200, { ok: true, targets: readTargets(opts.workspace) });
          return;
        }

        if (path === "/api/targets" && req.method === "POST") {
          sessions.touch(sessionId);
          const written = writeTarget(opts.workspace, validateTargetRequest(await readBody(req)));
          sendJson(res, 200, { ok: true, target: written });
          return;
        }

        if (path === "/api/actions" && req.method === "GET") {
          sendJson(res, 200, {
            ok: true,
            workspace: opts.workspace,
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
          const dir = resolve(opts.workspace, "reports");
          mkdirSync(dir, { recursive: true });
          const full = resolve(dir, name);
          if (!full.startsWith(resolve(opts.workspace) + sep)) {
            sendJson(res, 400, { ok: false, code: "BAD_PATH", message: "refused" });
            return;
          }
          writeFileSync(full, text, "utf8");
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
          const argv = action.build(body.params ?? {}, buildContext);

          if (action.streams) {
            const job = startJob(action.id, argv);
            sendJson(res, 202, { ok: true, jobId: job.id, argv, summary: action.summary });
            return;
          }

          const { json, text, exitCode } = await runCli(argv);
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
          const full = findArtifact(investigation, kind, sha);
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
