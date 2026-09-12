#!/usr/bin/env node
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Keep the chat UI up on one fixed port.
 *
 * `npm run web` is a plain foreground server: when it exits, it is gone. This supervises it, so a
 * crash, an unhandled rejection, or a provider call that takes the process down brings it back on
 * the SAME port rather than leaving a dead link in someone's browser.
 *
 * Backoff is deliberate. A server that cannot bind — usually because something else grabbed the
 * port, or a previous instance has not released it — would otherwise spin at full speed and bury
 * the reason in a scrolling log. It retries, slower each time, up to a ceiling, and never gives up:
 * the point of this script is that the agent stays reachable.
 *
 *   node scripts/serve.mjs [--port 3000] [--workspace ./repro-workspace]
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");

const DEFAULT_PORT = 3000;
const MIN_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;
/** A process that survives this long is treated as healthy, and the backoff resets. */
const HEALTHY_AFTER_MS = 20_000;

function flag(name, fallback) {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : process.argv[i + 1];
}

const port = Number.parseInt(String(flag("--port", DEFAULT_PORT)), 10);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  process.stderr.write(`--port must be a valid port number\n`);
  process.exit(1);
}

const workspace = resolve(String(flag("--workspace", join(ROOT, "repro-workspace"))));
const bin = join(ROOT, "apps", "web", "dist", "bin.js");

if (!existsSync(bin)) {
  process.stderr.write(`Not built. Run \`npm run build\` first.\n  missing: ${bin}\n`);
  process.exit(1);
}
if (!existsSync(join(workspace, ".investigator"))) {
  process.stderr.write(
    `No workspace at ${workspace}.\n  Create one: node apps/cli/dist/bin.js init --workspace ${workspace}\n`
  );
  process.exit(1);
}

const logDir = join(ROOT, ".logs");
mkdirSync(logDir, { recursive: true });
const logPath = join(logDir, `web-${port}.log`);

function log(line) {
  const stamped = `[${new Date().toISOString()}] ${line}\n`;
  process.stdout.write(stamped);
  try {
    appendFileSync(logPath, stamped);
  } catch {
    /* a log that cannot be written must not take the server down */
  }
}

let child = null;
let stopping = false;
let backoff = MIN_BACKOFF_MS;
let restarts = 0;

function start() {
  if (stopping) return;

  const startedAt = Date.now();
  child = spawn(process.execPath, [bin, "--workspace", workspace, "--port", String(port)], {
    cwd: ROOT,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stdout.on("data", (d) => process.stdout.write(d));
  child.stderr.on("data", (d) => {
    const text = String(d);
    process.stderr.write(text);
    try {
      appendFileSync(logPath, text);
    } catch {
      /* ignore */
    }
  });

  child.on("exit", (code, signal) => {
    child = null;
    if (stopping) return;

    const alive = Date.now() - startedAt;
    if (alive >= HEALTHY_AFTER_MS) backoff = MIN_BACKOFF_MS;

    restarts += 1;
    log(
      `server exited (code=${code ?? "null"} signal=${signal ?? "none"}) after ${Math.round(alive / 1000)}s — ` +
        `restart #${restarts} on port ${port} in ${backoff}ms`
    );
    setTimeout(start, backoff);
    backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
  });

  child.on("error", (e) => log(`failed to spawn: ${e.message}`));
}

function stop(signal) {
  stopping = true;
  log(`stopping on ${signal}`);
  if (child) child.kill();
  process.exit(0);
}

process.on("SIGINT", () => stop("SIGINT"));
process.on("SIGTERM", () => stop("SIGTERM"));

log(`supervising the chat UI on http://127.0.0.1:${port}/`);
log(`workspace ${workspace}`);
log(`log ${logPath}`);
start();
