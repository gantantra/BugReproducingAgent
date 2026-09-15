import { describe, it, expect, afterEach } from "vitest";
import { createRequire } from "node:module";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LIVE_VIEW_INTERVAL_MS, liveFramePath, writeLiveViewHook } from "./live-view.js";

/**
 * The hook MCP loads into every tab (`--init-page`).
 *
 * These load the file exactly as written to disk, the way MCP does, rather than a copy of its
 * logic: what matters is that the JavaScript MCP will `require` actually captures frames.
 */

const requireHook = createRequire(import.meta.url);

class FakePage {
  shots = 0;
  frame = Buffer.from("frame-1");
  options: unknown = null;
  private closeHandlers: Array<() => void> = [];
  async screenshot(options: unknown): Promise<Buffer> {
    this.shots++;
    this.options = options;
    return this.frame;
  }
  on(event: string, fn: () => void): void {
    if (event === "close") this.closeHandlers.push(fn);
  }
  close(): void {
    for (const fn of this.closeHandlers) fn();
  }
}

type Hook = { default: (a: { page: FakePage }) => Promise<void> };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(check: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out waiting for the live frame");
    await sleep(10);
  }
}

describe("the live-view hook MCP loads into every tab", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function load(): { dir: string; hook: Hook } {
    const dir = mkdtempSync(join(tmpdir(), "live-view-"));
    dirs.push(dir);
    return { dir, hook: requireHook(writeLiveViewHook(dir)) as Hook };
  }

  const frameText = (dir: string) =>
    existsSync(liveFramePath(dir)) ? readFileSync(liveFramePath(dir)).toString() : "";

  it("writes the page's frame without waiting for the model to take a screenshot", async () => {
    const { dir, hook } = load();
    const page = new FakePage();
    await hook.default({ page });
    await until(() => frameText(dir) === "frame-1");
    expect(page.options).toMatchObject({ type: "jpeg" });
    page.close();
  });

  it("follows the newest tab, and replaces the frame when the page changes", async () => {
    const { dir, hook } = load();
    const first = new FakePage();
    const second = new FakePage();
    second.frame = Buffer.from("frame-2");
    await hook.default({ page: first });
    await until(() => frameText(dir) === "frame-1");
    await hook.default({ page: second });
    await until(() => frameText(dir) === "frame-2");
    second.frame = Buffer.from("frame-3");
    await until(() => frameText(dir) === "frame-3", LIVE_VIEW_INTERVAL_MS * 3);
    second.close();
    first.close();
  });

  it("stops capturing once every tab has closed", async () => {
    const { dir, hook } = load();
    const page = new FakePage();
    await hook.default({ page });
    await until(() => frameText(dir) === "frame-1");
    page.close();
    const shots = page.shots;
    await sleep(LIVE_VIEW_INTERVAL_MS * 1.5);
    expect(page.shots).toBe(shots);
  });
});
