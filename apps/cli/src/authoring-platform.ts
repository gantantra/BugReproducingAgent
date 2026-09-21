import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { EmulationProfile } from "@investigator/core";

/**
 * The browser platform an authoring session runs as (ADR-0014).
 *
 * The platform is part of the bug. A report said "on my android chrome", the plan read it
 * correctly -- and then said "I will be on desktop Chrome" and resized the window, because nothing
 * the session had could make the browser mobile. A narrow desktop window still sends a desktop
 * user agent, so a site that checks it serves the desktop page and the reported flow never
 * appears.
 *
 * So the model only NAMES a configured profile, from anything the operator said, and the harness
 * launches the browser as that profile's concrete values. The name is checked against config
 * before anything uses it, and the operator sees the choice on the plan card before a browser
 * opens.
 */

export interface PlatformChoice {
  profile: string;
  /** Where the choice came from: the plan, a later request in the session, or the config default. */
  source: "plan" | "session-request" | "default";
}

const SOURCES: ReadonlySet<string> = new Set(["plan", "session-request", "default"]);

export function describeProfile(name: string, p: EmulationProfile): string {
  const traits = [
    `${p.viewport.width}×${p.viewport.height}`,
    p.hasTouch ? "touch" : null,
    p.isMobile && !p.userAgent ? "no mobile user agent configured" : null,
    p.network || p.cpu ? "network/CPU throttling is not applied while authoring" : null,
  ].filter((t): t is string => t !== null);
  return `${name} (${p.isMobile ? "emulated Chrome mobile" : "desktop Chrome"}, ${traits.join(", ")})`;
}

export function profileCatalogue(profiles: Readonly<Record<string, EmulationProfile>>): string {
  return Object.entries(profiles)
    .map(([name, p]) => `- ${describeProfile(name, p)}`)
    .join("\n");
}

const PLATFORM_LINE = /^\s*[*_`]*PLATFORM:\s*[*_`]*([A-Za-z0-9._-]+)/i;

/** The profile name on the last `PLATFORM:` line of a plan, as written. Unchecked. */
export function readPlatformLine(message: string): string | null {
  const lines = message.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = PLATFORM_LINE.exec(lines[i]!);
    if (m) return m[1]!;
  }
  return null;
}

/** The plan as the operator reads it: the `PLATFORM:` line is shown separately. */
export function stripPlatformLine(text: string): string {
  return text
    .split(/\r?\n/)
    .filter((l) => !PLATFORM_LINE.test(l))
    .join("\n")
    .trim();
}

/**
 * The browser context options for a profile, for Playwright MCP's config file and the emitted
 * suite alike, so the authored run and every re-run are the same browser. Mirrors what the
 * measured worker applies. Network and CPU throttling have no context option and are left out.
 */
export function browserContextOptions(p: EmulationProfile): Record<string, unknown> {
  return {
    viewport: p.viewport,
    screen: p.screen ?? p.viewport,
    deviceScaleFactor: p.deviceScaleFactor,
    isMobile: p.isMobile,
    hasTouch: p.hasTouch,
    locale: p.locale,
    timezoneId: p.timezoneId,
    colorScheme: p.colorScheme,
    ...(p.reducedMotion ? { reducedMotion: p.reducedMotion } : {}),
    ...(p.forcedColors ? { forcedColors: p.forcedColors } : {}),
    ...(p.userAgent ? { userAgent: p.userAgent } : {}),
  };
}

/** The recorded choice, or null when there is none or it names a profile config no longer has. */
export function readPlatformFile(
  path: string,
  profiles: Readonly<Record<string, EmulationProfile>>
): PlatformChoice | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as {
      profile?: unknown;
      source?: unknown;
    };
    if (
      typeof parsed.profile === "string" &&
      Object.prototype.hasOwnProperty.call(profiles, parsed.profile) &&
      typeof parsed.source === "string" &&
      SOURCES.has(parsed.source)
    ) {
      return { profile: parsed.profile, source: parsed.source as PlatformChoice["source"] };
    }
  } catch {
    // Corrupt: treated as absent, and the caller falls back to the default it names.
  }
  return null;
}

export function writePlatformFile(path: string, choice: PlatformChoice): void {
  writeFileSync(path, `${JSON.stringify(choice, null, 2)}\n`, "utf8");
}
