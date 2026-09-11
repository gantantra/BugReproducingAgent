import { describe, it, expect, afterEach } from "vitest";
import { searchExperiment } from "@investigator/test-fixtures";
import { DEFAULT_EMULATION_PROFILES } from "@investigator/core";
import { createHarness, readManifests, runExperiment, type Harness } from "./harness.js";

/**
 * Chrome mobile is Chromium emulation (ADR-0014), and the manifest must record what the BROWSER
 * reported, not what the profile requested.
 *
 * The completion audit found the mobile profile shipped and the code path implemented, but no test
 * ever ran with it: `pixel-7-chrome-mobile` was unexercised, so nothing would have failed if
 * mobile emulation silently stopped applying. This exercises it end to end and asserts the three
 * things ADR-0014 actually promises.
 *
 * Language discipline (CLAUDE.md): these assertions concern Chromium's mobile EMULATION. They are
 * not evidence of real-device Android Chrome behaviour and must never be described as such.
 */

let h: Harness | undefined;
afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

const MOBILE = "pixel-7-chrome-mobile";

describe("mobile emulation", () => {
  it("materializes the mobile profile's concrete values in the run manifest", async () => {
    h = await createHarness({ fixtures: ["passing"] });

    const experiment = searchExperiment("passing") as Record<string, unknown>;
    experiment["emulationProfile"] = MOBILE;
    const results = await runExperiment(h, experiment, 1);

    expect(results).toHaveLength(1);
    expect(results[0]?.outcome, "a mobile-emulated run must still pass").toBe("VALID_COMPLETED");

    const manifests = await readManifests(h);
    expect(manifests).toHaveLength(1);
    const emulation = manifests[0]?.["emulation"] as {
      profileName: string;
      resolved: Record<string, unknown>;
    };

    expect(emulation.profileName).toBe(MOBILE);

    // Materialised, not templated: a Playwright upgrade must not be able to change what this
    // profile meant in a past investigation.
    const expected = DEFAULT_EMULATION_PROFILES[MOBILE]!;
    const resolved = emulation.resolved as {
      viewport: { width: number; height: number };
      deviceScaleFactor: number;
      isMobile: boolean;
      hasTouch: boolean;
      userAgent: string;
      locale: string;
      timezoneId: string;
    };
    // `resolved` is what the BROWSER reported, so it is compared against the browser, not against
    // the profile. The profile's requested values are asserted through `discrepancies` below:
    // where the two agree there is no discrepancy, and where they differ the divergence is
    // recorded rather than silently accepted (ADR-0014).
    expect(resolved.deviceScaleFactor).toBe(expected.deviceScaleFactor);
    expect(resolved.locale).toBe(expected.locale);
    expect(resolved.userAgent, "userAgent must never carry a version placeholder").not.toContain(
      "<version>"
    );
    // A mobile profile must advertise a mobile UA. Inheriting Chromium's default gave a desktop
    // Windows string, which would make a "Chrome mobile" run misleading to any UA-sniffing app.
    expect(resolved.userAgent, "mobile emulation must advertise a mobile UA").toMatch(
      /Android|Mobile/
    );
    expect(resolved.userAgent).toBe(expected.userAgent);

    // Every requested-vs-observed divergence is explicitly recorded, with both values.
    const discrepancies = (
      manifests[0]?.["emulation"] as {
        discrepancies?: Array<{ field: string; requested: unknown; observed: unknown }>;
      }
    ).discrepancies;
    for (const d of discrepancies ?? []) {
      expect(d.field, "a discrepancy must name its field").toBeTruthy();
      expect(d, "a discrepancy must carry both values").toHaveProperty("requested");
      expect(d, "a discrepancy must carry both values").toHaveProperty("observed");
    }
  });

  it("reads mobile values back from the live page rather than copying the profile", async () => {
    h = await createHarness({ fixtures: ["passing"] });

    const experiment = searchExperiment("passing") as Record<string, unknown>;
    experiment["emulationProfile"] = MOBILE;
    await runExperiment(h, experiment, 1);

    const manifests = await readManifests(h);
    const emulation = manifests[0]?.["emulation"] as {
      resolved: { deviceScaleFactor: number; maxTouchPoints?: number; isMobile: boolean };
      discrepancies?: Array<{ field: string }>;
    };

    // These three come from the in-page probe (window.devicePixelRatio, navigator.maxTouchPoints).
    // A desktop context cannot produce them, so their presence proves the emulation reached the
    // browser and that the manifest reflects the browser rather than the config file.
    expect(emulation.resolved.deviceScaleFactor).toBeCloseTo(2.625, 3);
    expect(emulation.resolved.maxTouchPoints, "touch points come from navigator").toBeGreaterThan(
      0
    );
    expect(emulation.resolved.isMobile).toBe(true);

    // Any divergence between requested and observed must be recorded, never silently accepted.
    for (const d of emulation.discrepancies ?? []) {
      expect(d.field, "an unexplained emulation discrepancy").toBeTruthy();
    }
  });

  it("desktop and mobile profiles produce materially different resolved values", async () => {
    h = await createHarness({ fixtures: ["passing"] });

    const desktop = searchExperiment("passing", { experimentId: "EXP-DESKTOP" });
    await runExperiment(h, desktop, 1);

    const mobileExp = searchExperiment("passing", {
      experimentId: "EXP-MOBILE",
    }) as Record<string, unknown>;
    mobileExp["emulationProfile"] = MOBILE;
    await runExperiment(h, mobileExp, 1);

    const manifests = await readManifests(h);
    expect(manifests).toHaveLength(2);

    const byProfile = new Map(
      manifests.map((m) => {
        const e = m["emulation"] as { profileName: string; resolved: Record<string, unknown> };
        return [e.profileName, e.resolved];
      })
    );
    const d = byProfile.get("desktop-chrome-1440") as {
      viewport: { width: number };
      isMobile: boolean;
      userAgent: string;
    };
    const mo = byProfile.get(MOBILE) as {
      viewport: { width: number };
      isMobile: boolean;
      userAgent: string;
    };

    expect(d, "the desktop run's manifest").toBeDefined();
    expect(mo, "the mobile run's manifest").toBeDefined();
    // The mobile layout viewport must be materially narrower than the desktop one, and the two
    // profiles must be distinguishable in the evidence. Exact widths are not asserted: the
    // layout viewport is the browser's, and a page's own viewport meta legitimately affects it.
    expect(mo.viewport.width).toBeLessThan(d.viewport.width);
    expect(d.isMobile).toBe(false);
    expect(mo.isMobile).toBe(true);
    // Chromium's mobile emulation advertises Android; desktop does not.
    expect(mo.userAgent).not.toBe(d.userAgent);
    expect(mo.userAgent).toMatch(/Android|Mobile/);
    expect(d.userAgent).not.toMatch(/Android/);
  });
});
