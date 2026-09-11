import type { Browser, Page } from "playwright";
import type { EmulationProfile } from "@investigator/core";
import type { EmulationDiscrepancy, ResolvedEmulation } from "@investigator/core";

/**
 * Resolved emulation (ADR-0014).
 *
 * The manifest stores values READ BACK from the live browser context, not copied from the
 * profile definition. Where requested and observed differ, both are recorded as a discrepancy
 * and surfaced as a run warning, because a silent divergence would make every later comparison
 * quietly wrong.
 *
 * `browserVersion` is observed at launch and never templated. A user-agent string containing a
 * literal version placeholder must never reach the wire.
 */

export interface ResolveEmulationArgs {
  page: Page;
  browser: Browser;
  profileName: string;
  profile: EmulationProfile;
  headless: boolean;
  channel?: string | null;
  launchArgs?: string[];
}

/** FIXED in-page probe. Literal source, no parameters. */
const READ_BACK = (): {
  userAgent: string;
  devicePixelRatio: number;
  maxTouchPoints: number;
  innerWidth: number;
  innerHeight: number;
  screenWidth: number;
  screenHeight: number;
  locale: string;
  timezoneId: string;
  prefersDark: boolean;
  prefersReducedMotion: boolean;
  forcedColors: boolean;
} => {
  const resolved = Intl.DateTimeFormat().resolvedOptions();
  return {
    userAgent: navigator.userAgent,
    devicePixelRatio: window.devicePixelRatio,
    maxTouchPoints: navigator.maxTouchPoints,
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    screenWidth: window.screen.width,
    screenHeight: window.screen.height,
    locale: resolved.locale,
    timezoneId: resolved.timeZone,
    prefersDark: window.matchMedia("(prefers-color-scheme: dark)").matches,
    prefersReducedMotion: window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    forcedColors: window.matchMedia("(forced-colors: active)").matches,
  };
};

export async function resolveEmulation(args: ResolveEmulationArgs): Promise<ResolvedEmulation> {
  const { profile } = args;
  const discrepancies: EmulationDiscrepancy[] = [];

  let observed: Awaited<
    ReturnType<typeof args.page.evaluate<ReturnType<typeof READ_BACK>>>
  > | null = null;
  try {
    observed = await args.page.evaluate(READ_BACK);
  } catch {
    // A page that cannot be probed (never navigated, or already closed) leaves the requested
    // values recorded with an explicit discrepancy rather than a fabricated read-back.
    discrepancies.push({ field: "readBack", requested: "available", observed: "unavailable" });
  }

  const note = (
    field: string,
    requested: string | number | boolean | null,
    got: string | number | boolean | null
  ): void => {
    if (requested !== got) discrepancies.push({ field, requested, observed: got });
  };

  if (observed) {
    note("deviceScaleFactor", profile.deviceScaleFactor, observed.devicePixelRatio);
    note("viewport.width", profile.viewport.width, observed.innerWidth);
    note("viewport.height", profile.viewport.height, observed.innerHeight);
    note("locale", profile.locale, observed.locale);
    note("timezoneId", profile.timezoneId, observed.timezoneId);
    if (profile.maxTouchPoints !== undefined) {
      note("maxTouchPoints", profile.maxTouchPoints, observed.maxTouchPoints);
    }
    if (profile.userAgent) note("userAgent", profile.userAgent, observed.userAgent);
    const observedScheme = observed.prefersDark ? "dark" : "light";
    if (profile.colorScheme !== "no-preference") {
      note("colorScheme", profile.colorScheme, observedScheme);
    }
  }

  const resolved: ResolvedEmulation = {
    profileName: args.profileName,
    profileSource: "config.execution.emulation.profiles",
    resolved: {
      viewport: observed
        ? { width: observed.innerWidth, height: observed.innerHeight }
        : profile.viewport,
      screen: observed
        ? { width: observed.screenWidth, height: observed.screenHeight }
        : (profile.screen ?? profile.viewport),
      deviceScaleFactor: observed ? observed.devicePixelRatio : profile.deviceScaleFactor,
      isMobile: profile.isMobile,
      hasTouch: profile.hasTouch,
      maxTouchPoints: observed ? observed.maxTouchPoints : (profile.maxTouchPoints ?? 0),
      // Always the concrete string the browser actually reports.
      userAgent: observed ? observed.userAgent : (profile.userAgent ?? ""),
      userAgentSource: observed ? "read-back" : profile.userAgent ? "config" : "browser-default",
      locale: observed ? observed.locale : profile.locale,
      timezoneId: observed ? observed.timezoneId : profile.timezoneId,
      colorScheme: observed ? (observed.prefersDark ? "dark" : "light") : profile.colorScheme,
      reducedMotion: observed
        ? observed.prefersReducedMotion
          ? "reduce"
          : "no-preference"
        : (profile.reducedMotion ?? "no-preference"),
      forcedColors: observed
        ? observed.forcedColors
          ? "active"
          : "none"
        : (profile.forcedColors ?? "none"),
      network: profile.network ?? null,
      cpu: profile.cpu ?? null,
      geolocation: null,
      permissions: [],
    },
    browser: {
      engine: "chromium",
      channel: args.channel ?? null,
      playwrightVersion: playwrightVersion(),
      // Observed at launch. Never assumed.
      browserVersion: args.browser.version(),
      headless: args.headless,
      ...(args.launchArgs ? { launchArgs: args.launchArgs } : {}),
    },
  };

  if (discrepancies.length) resolved.discrepancies = discrepancies;
  return resolved;
}

function playwrightVersion(): string {
  try {
    // Recorded per run so a Playwright upgrade is visible in every manifest it affected.
    // This package is CommonJS ("type": "commonjs"), and the resolve is deliberately lazy so a
    // missing playwright install degrades to "unknown" instead of throwing at import time.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pkg = require("playwright/package.json") as { version?: string };
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}
