/**
 * The allowlist must match the server that actually runs.
 *
 * This exists because it did not, and the failure was invisible until a live session died of it.
 * `ALLOWED_PLAYWRIGHT_TOOLS` was written from memory, and memory named eight tools the server has
 * never exposed while omitting `browser_find`, which a real authoring session reached for on a
 * real site. The CLI denied it — correctly, it was not on the allowlist — the session retried,
 * gave up, and reported "it could not get there" with no script. Nothing in the build, the lint,
 * or 529 unit tests could see it, because every one of them checked the list against itself.
 *
 * So this test asks the server. It boots the same `@playwright/mcp` the authoring command boots,
 * by reusing `playwrightMcpConfig()` rather than repeating its arguments, and asserts the
 * allowlist is exactly the server's surface minus the two tools we deliberately withhold.
 *
 * It fails in both directions on purpose:
 *  - a name here that the server does not have is a tool a session can never call
 *  - a name the server has that is missing here is a tool a session will be denied mid-run
 *
 * Upgrading the pinned version should break this test. That is the point: the new tools want
 * looking at, and the review is one line of output rather than a session failing in the field.
 */
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  ALLOWED_PLAYWRIGHT_TOOLS,
  REFUSED_PLAYWRIGHT_TOOLS,
  playwrightMcpConfig,
} from "../../apps/cli/src/claude-cli.js";

const PREFIX = "mcp__playwright__";

/** Launch the server exactly as the authoring command does and ask it for `tools/list`. */
async function serverToolNames(): Promise<string[]> {
  /* The output dir is irrelevant to `tools/list`, but it must not contain a space.
   *
   * Not a production concern — the Claude CLI spawns this server with an argv array and no shell,
   * so the real session directory ("…/OneDrive - Info Edge (India) Ltd/…") is passed intact. This
   * test cannot: `npx` on Windows is a .cmd shim that spawn cannot exec directly, so it needs
   * `shell: true`, which concatenates rather than escapes. Handed the repo path, the server got a
   * truncated `--output-dir`, never started, and the first run of this test timed out at 90s
   * looking exactly like a broken allowlist. `tmpdir()` is the 8.3 short path, so it has none. */
  const config = playwrightMcpConfig({ outputDir: tmpdir() }) as {
    mcpServers: { playwright: { command: string; args: string[] } };
  };
  const { command, args } = config.mcpServers.playwright;
  const onWindows = process.platform === "win32";
  const bin = onWindows && command === "npx" ? "npx.cmd" : command;

  const child = spawn(bin, args, { stdio: ["pipe", "pipe", "ignore"], shell: onWindows });

  try {
    return await new Promise<string[]>((resolve, reject) => {
      const send = (m: unknown) => child.stdin.write(`${JSON.stringify(m)}\n`);
      const timer = setTimeout(() => reject(new Error("MCP server did not answer in 90s")), 90_000);
      let buffered = "";

      child.on("error", reject);
      child.stdout.on("data", (chunk: Buffer) => {
        buffered += chunk.toString();
        let cut: number;
        while ((cut = buffered.indexOf("\n")) >= 0) {
          const line = buffered.slice(0, cut).trim();
          buffered = buffered.slice(cut + 1);
          if (!line) continue;

          let message: { id?: number; result?: { tools?: { name: string }[] } };
          try {
            message = JSON.parse(line);
          } catch {
            continue; // npx progress noise, not protocol
          }

          if (message.id === 1) {
            send({ jsonrpc: "2.0", method: "notifications/initialized" });
            send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
          }
          if (message.id === 2) {
            clearTimeout(timer);
            resolve((message.result?.tools ?? []).map((t) => t.name).sort());
          }
        }
      });

      send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "allowlist-check", version: "0" },
        },
      });
    });
  } finally {
    child.kill();
  }
}

describe("the Playwright MCP allowlist against the server that actually runs", () => {
  it("names only tools the server exposes, and every one it does not withhold", async () => {
    const exposed = await serverToolNames();
    expect(exposed.length, "server exposed no tools — it did not start correctly").toBeGreaterThan(
      0
    );

    const allowed = ALLOWED_PLAYWRIGHT_TOOLS.map((t) => t.slice(PREFIX.length));
    const expected = exposed.filter((t) => !REFUSED_PLAYWRIGHT_TOOLS.includes(t)).sort();

    // Reported as two lists rather than one set comparison, so a failure says which direction it
    // drifted in — a phantom name is a dead entry, a missing one denies a live session mid-run.
    expect(
      allowed.filter((t) => !exposed.includes(t)),
      "allowlisted but the server has no such tool"
    ).toEqual([]);
    expect(
      expected.filter((t) => !allowed.includes(t)),
      "the server exposes these and a session would be denied them"
    ).toEqual([]);

    expect([...allowed].sort()).toEqual(expected);
  });

  it("withholds the two tools that can fake a reproduction, and they are real", async () => {
    const exposed = await serverToolNames();

    // If a refusal names a tool that does not exist, the refusal is decoration. Both of these
    // were checked: the earlier list "refused" browser_route and storage setters the server has
    // never had, while shipping no protection at all.
    for (const tool of REFUSED_PLAYWRIGHT_TOOLS) {
      expect(exposed, `${tool} is refused but the server does not expose it`).toContain(tool);
      expect(ALLOWED_PLAYWRIGHT_TOOLS).not.toContain(`${PREFIX}${tool}`);
    }
  });
});
