#!/usr/bin/env node
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { createInvestigatorServer, mintToken } from "./server.js";
import { readOrCreateToken } from "./storage.js";

/**
 * Entry point for the local chat UI.
 *
 * Deliberately not a dependency of anything: it discovers the CLI binary on disk and runs it as a
 * child process, so the web front end shares the CLI's behaviour without importing a line of it.
 */

function flagValue(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  if (i === -1) return undefined;
  return argv[i + 1];
}

/** The CLI's own rule: the nearest `.investigator` directory walking upward. */
function findWorkspace(start: string): string | null {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, ".investigator"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Find `apps/cli/dist/bin.js` by walking up from this file, so the layout can move. */
function findCliBin(start: string): string | null {
  let dir = resolve(start);
  for (;;) {
    const candidate = join(dir, "apps", "cli", "dist", "bin.js");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function main(): void {
  const argv = process.argv.slice(2);

  const wsFlag = flagValue(argv, "--workspace");
  const workspace = wsFlag ? resolve(wsFlag) : findWorkspace(process.cwd());
  if (!workspace || !existsSync(join(workspace, ".investigator"))) {
    process.stderr.write(
      "No workspace found. Create one first:\n\n" +
        "  node apps/cli/dist/bin.js init --workspace ./my-workspace\n\n" +
        "then re-run with --workspace ./my-workspace\n"
    );
    process.exit(1);
  }

  const cliBin = findCliBin(__dirname);
  if (!cliBin) {
    process.stderr.write("Could not find apps/cli/dist/bin.js. Run `npm run build` first.\n");
    process.exit(1);
  }

  const portRaw = flagValue(argv, "--port");
  // Same default as `npm run serve`, so the two entry points do not disagree about the address.
  const port = portRaw ? Number.parseInt(portRaw, 10) : 9999;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    process.stderr.write(`--port must be a valid port number, got ${String(portRaw)}\n`);
    process.exit(1);
  }

  // Stable across restarts, so a supervised restart does not invalidate an open page.
  const token = readOrCreateToken(workspace, mintToken);
  const server = createInvestigatorServer({
    workspace,
    cliBin,
    port,
    token,
    launchDir: process.cwd(),
  });

  // Loopback only. This surface starts processes on the operator's machine; it is not a web app
  // and must never be reachable from the network.
  server.listen(port, "127.0.0.1", () => {
    process.stdout.write(
      `\n  Investigator chat UI\n\n` +
        `  open        http://127.0.0.1:${port}/\n` +
        `  workspace   ${workspace}\n` +
        `  cli         ${cliBin}\n\n` +
        `  Loopback only. Every action runs the same 'investigate' command you would type,\n` +
        `  so approvals, redaction and the API key stay inside that process.\n\n` +
        `  Ctrl+C to stop.\n\n`
    );
  });

  server.on("error", (e: NodeJS.ErrnoException) => {
    if (e.code === "EADDRINUSE") {
      process.stderr.write(`Port ${port} is already in use. Try --port ${port + 1}.\n`);
      process.exit(1);
    }
    process.stderr.write(`${e.message}\n`);
    process.exit(1);
  });
}

main();
