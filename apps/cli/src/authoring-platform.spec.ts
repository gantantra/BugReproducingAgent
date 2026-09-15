import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EmulationProfile } from "@investigator/core";
import {
  browserContextOptions,
  describeProfile,
  readPlatformFile,
  readPlatformLine,
  stripPlatformLine,
  writePlatformFile,
} from "./authoring-platform.js";

const base = {
  locale: "en-IN",
  timezoneId: "Asia/Kolkata",
  colorScheme: "light",
  reducedMotion: "no-preference",
  forcedColors: "none",
  network: null,
  cpu: null,
} as const;

const PROFILES: Record<string, EmulationProfile> = {
  "desktop-chrome-1440": {
    ...base,
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    isMobile: false,
    hasTouch: false,
  },
  "pixel-7-chrome-mobile": {
    ...base,
    viewport: { width: 412, height: 915 },
    deviceScaleFactor: 2.625,
    isMobile: true,
    hasTouch: true,
    userAgent: "Mozilla/5.0 (Linux; Android 13; Pixel 7) Mobile Safari/537.36",
  },
  "low-end-android-throttled": {
    ...base,
    viewport: { width: 412, height: 915 },
    deviceScaleFactor: 2.625,
    isMobile: true,
    hasTouch: true,
    cpu: { throttlingRate: 4 },
  },
};

describe("reading the platform a plan chose", () => {
  const PLAN = [
    "The reporter was on Android Chrome, so the browser is the mobile profile.",
    "1. Open https://www.99acres.com/profile/editProfile",
    "",
    "PLATFORM: pixel-7-chrome-mobile",
    "AUTHORING: PLAN",
  ].join("\n");

  it("takes the profile name from the PLATFORM line", () => {
    expect(readPlatformLine(PLAN)).toBe("pixel-7-chrome-mobile");
  });

  it("is null when the plan named no platform, so the caller uses the default and says so", () => {
    expect(readPlatformLine("1. Open the page\nAUTHORING: PLAN")).toBeNull();
  });

  it("keeps the line out of the plan the operator reads, and nothing else", () => {
    expect(stripPlatformLine("1. Open the page\nPLATFORM: pixel-7-chrome-mobile")).toBe("1. Open the page");
  });
});

describe("the browser a profile launches", () => {
  it("is real mobile emulation for a mobile profile, not just a narrow window", () => {
    const o = browserContextOptions(PROFILES["pixel-7-chrome-mobile"]!);
    expect(o).toMatchObject({
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: 2.625,
      viewport: { width: 412, height: 915 },
      userAgent: expect.stringContaining("Android"),
    });
  });

  it("does not invent a user agent a profile does not define", () => {
    expect(browserContextOptions(PROFILES["desktop-chrome-1440"]!)).not.toHaveProperty("userAgent");
  });

  it("tells the operator what a profile cannot do while authoring", () => {
    const d = describeProfile("low-end-android-throttled", PROFILES["low-end-android-throttled"]!);
    expect(d).toContain("emulated Chrome mobile");
    expect(d).toContain("no mobile user agent configured");
    expect(d).toContain("throttling is not applied");
  });
});

describe("the recorded choice", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const file = () => {
    const d = mkdtempSync(join(tmpdir(), "platform-"));
    dirs.push(d);
    return join(d, "platform.json");
  };

  it("round-trips", () => {
    const path = file();
    writePlatformFile(path, { profile: "pixel-7-chrome-mobile", source: "plan" });
    expect(readPlatformFile(path, PROFILES)).toEqual({ profile: "pixel-7-chrome-mobile", source: "plan" });
  });

  it("is not trusted when it names a profile config does not have, or is corrupt", () => {
    const path = file();
    writePlatformFile(path, { profile: "iphone-safari", source: "plan" });
    expect(readPlatformFile(path, PROFILES)).toBeNull();
    writeFileSync(path, "{ not json", "utf8");
    expect(readPlatformFile(path, PROFILES)).toBeNull();
    expect(readPlatformFile(join(path, "..", "missing.json"), PROFILES)).toBeNull();
  });
});
