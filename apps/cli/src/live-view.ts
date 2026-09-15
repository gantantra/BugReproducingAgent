import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * What the operator watches while an authoring session drives the browser.
 *
 * The viewport used to show only the screenshots the model chose to take: six frames across
 * twenty-six browser actions in a real session, so it sat on the first frame while the session
 * clicked on through the site. Frames now come from Playwright itself. MCP loads this hook with
 * `--init-page` into every tab, and the hook writes the newest tab to `live/frame.jpg` about once
 * a second, whenever it has changed. Nothing it captures reaches the model, the session log or the
 * authored script -- it is a view of the browser, not evidence.
 */

export const LIVE_VIEW_DIR = "live";
export const LIVE_VIEW_INTERVAL_MS = 1000;
const HOOK_FILE = "live-view.cjs";

export function liveFramePath(sessionDir: string): string {
  return join(sessionDir, LIVE_VIEW_DIR, "frame.jpg");
}

/** Write the hook next to the session and return the path to hand MCP as `--init-page`. */
export function writeLiveViewHook(sessionDir: string): string {
  mkdirSync(sessionDir, { recursive: true });
  const path = join(sessionDir, HOOK_FILE);
  writeFileSync(path, LIVE_VIEW_HOOK_SOURCE, "utf8");
  return path;
}

/* CommonJS, because MCP loads it with `require` and calls its `default` export with `{ page }`.
 * The frame is written to a temporary file and renamed over the old one, so the web server never
 * serves a half-written JPEG. A frame that fails (a dialog is open, the tab is navigating) is
 * skipped and the next tick tries again: a missed frame is a stale picture, never a failed run. */
const LIVE_VIEW_HOOK_SOURCE = `"use strict";
// Written by \`investigate author\`. Loaded by Playwright MCP through --init-page, once per tab.
const { mkdirSync, renameSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");

const dir = join(__dirname, ${JSON.stringify(LIVE_VIEW_DIR)});
const frame = join(dir, "frame.jpg");
const partial = join(dir, "frame.partial");
const pages = [];
let timer = null;
let busy = false;
let last = null;

async function capture() {
  const page = pages[pages.length - 1];
  if (!page || busy) return;
  busy = true;
  try {
    const shot = await page.screenshot({
      type: "jpeg",
      quality: 60,
      scale: "css",
      caret: "initial",
      timeout: 3000,
    });
    if (last && last.equals(shot)) return;
    mkdirSync(dir, { recursive: true });
    writeFileSync(partial, shot);
    renameSync(partial, frame);
    last = shot;
  } catch {
    // Skipped; the next tick captures again.
  } finally {
    busy = false;
  }
}

exports.default = async function liveView({ page }) {
  pages.push(page);
  page.on("close", () => {
    const i = pages.indexOf(page);
    if (i !== -1) pages.splice(i, 1);
    if (pages.length === 0 && timer) {
      clearInterval(timer);
      timer = null;
    }
  });
  if (!timer) {
    timer = setInterval(capture, ${LIVE_VIEW_INTERVAL_MS});
    if (typeof timer.unref === "function") timer.unref();
  }
  void capture();
};
`;
