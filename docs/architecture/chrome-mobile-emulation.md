# Chrome Mobile Clarification

Status: M0 frozen candidate

## Governing principle

Playwright produces evidence. Deterministic software normalizes and measures evidence. DeepSeek interprets and prioritizes evidence. Humans authorize consequential transitions.

## Definition

For MVP, "Chrome mobile" means Chromium with explicit mobile-emulation parameters:

- viewport
- screen dimensions
- device scale factor
- user agent
- mobile layout behavior
- touch support
- locale and timezone when configured
- network and CPU profiles when configured

## What is claimed and what is not

| Claimed | Not claimed |
| --- | --- |
| Chromium rendering and script behaviour under the recorded emulation parameters | Real Android Chrome behaviour |
| Layout, media queries, and touch-event dispatch consistent with those parameters | GPU driver, compositor, or hardware rasterisation behaviour |
| Deterministic, repeatable emulation across runs | Physical touch hardware, gesture recognition, pointer precision |
| Client-observable network and CPU behaviour under the configured throttling profile | Real cellular radio behaviour, carrier proxies, OS-level networking |
| Client-observable storage behaviour | Android OS behaviour, background eviction, low-memory kill |
| Web content behaviour | Native apps, WebView-in-app differences, custom tabs |

Every generated report includes this boundary statement verbatim in its Environment section. The
report linter fails on the phrases "on Android", "on a real device", "on mobile Chrome" without the
qualifier "emulated".

## Resolved values, not profile names

Each run manifest stores resolved emulation values, not only the device profile name.

```json
{
  "emulation": {
    "profileName": "pixel-7-chrome-mobile",
    "profileSource": "config.execution.emulation.profiles",
    "resolved": {
      "viewport": { "width": 412, "height": 915 },
      "screen": { "width": 412, "height": 915 },
      "deviceScaleFactor": 2.625,
      "isMobile": true,
      "hasTouch": true,
      "maxTouchPoints": 5,
      "userAgent": "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/<version> Mobile Safari/537.36",
      "userAgentSource": "config",
      "locale": "en-IN",
      "timezoneId": "Asia/Kolkata",
      "colorScheme": "light",
      "reducedMotion": "no-preference",
      "forcedColors": "none",
      "network": { "profile": "fast-3g", "downloadKbps": 1600, "uploadKbps": 750, "latencyMs": 150, "offline": false },
      "cpu": { "throttlingRate": 4 },
      "geolocation": null,
      "permissions": []
    },
    "browser": {
      "engine": "chromium",
      "channel": null,
      "playwrightVersion": "1.x.y",
      "browserVersion": "<observed at launch>",
      "headless": true,
      "launchArgs": ["--disable-dev-shm-usage"]
    }
  }
}
```

Rules:

1. `resolved` is captured from the actual browser context after creation, not copied from the
   profile definition. Where a value can be read back from the page (`navigator.userAgent`,
   `window.devicePixelRatio`, `navigator.maxTouchPoints`, `Intl.DateTimeFormat().resolvedOptions()`),
   it is read back and the read-back value is what gets stored. A mismatch between requested and
   observed is recorded in `emulation.discrepancies[]` and surfaced as a run warning.
2. `browserVersion` is observed at launch. It is never assumed and never templated. Any user-agent
   string containing a literal `<version>` placeholder that reaches the wire is a bug; the resolved
   record stores the concrete string the browser actually sent.
3. Comparing runs across differing `resolved` values is only permitted when the comparison
   explicitly declares emulation as the varied factor. Otherwise the extractor refuses the
   comparison with `EVIDENCE_CATEGORY_MISSING`-style typed refusal, because a difference caused by
   a viewport change is not a finding about the product.
4. Headless versus headed is part of the record and is treated as a factor. A repro that only
   occurs headless is reported as such rather than being presented as a user-facing defect.

## Determinism levers

Applied by default so that repeated runs differ as little as possible:

- fixed `locale`, `timezoneId`, `colorScheme`, `reducedMotion`
- seeded RNG for any agent-side jitter; the seed is recorded
- `Math.random` and `Date.now` are **not** patched in the page by default: patching changes the
  application under test. Where an experiment needs it, it is an explicit, declared, approved
  factor recorded in the manifest.
- animations are not globally disabled by default, for the same reason. `reducedMotion` is a real
  browser setting and is recorded; injecting CSS overrides is an explicit factor.
- network and CPU throttling are off unless a profile is configured, and when on they are recorded
  as resolved numbers.

The general rule: the agent does not quietly alter the application under test to make results
stable. Every intervention is a declared, recorded, approved factor. Instability is a *finding*,
not a nuisance to be suppressed.

## Built-in profiles

MVP ships three, defined in config so they are editable and versioned with the workspace:

| Profile | Purpose |
| --- | --- |
| `desktop-chrome-1440` | Baseline desktop: 1440x900, DSF 1, no touch |
| `pixel-7-chrome-mobile` | Mainstream Android-class emulation |
| `low-end-android-throttled` | Same as above plus `fast-3g` network and CPU rate 4 |

Playwright device descriptors may be used as the *source* of a profile definition, but the
definition is materialised into config with concrete values, so a Playwright upgrade cannot
silently change what "Pixel 7" meant in a past investigation. Manifests from before the change
remain interpretable.
