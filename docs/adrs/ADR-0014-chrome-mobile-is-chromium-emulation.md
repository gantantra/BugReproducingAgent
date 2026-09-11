---
id: ADR-0014
title: Chrome mobile means Chromium with explicit mobile emulation, recorded as resolved read-back values
status: accepted
date: 2026-09-10
touches: [execution, evidence]
decision: Define Chrome mobile as Chromium with explicit emulation parameters; store resolved values read back from the live browser rather than a profile name; refuse cross-emulation comparisons unless emulation is the declared varied factor; and require a verbatim boundary statement in every report.
consequences: Findings are scoped honestly to emulated Chrome and remain interpretable years later, at the cost of never being able to claim real-device behaviour.
---

# ADR-0014 — Chrome mobile is Chromium emulation

## Governing principle

Playwright produces evidence. Deterministic software normalizes and measures evidence. DeepSeek interprets and prioritizes evidence. Humans authorize consequential transitions.

## Context

"It only happens on Chrome mobile" is one of the most common intermittent-bug reports. Emulated
Chromium is a legitimate and useful place to investigate it: layout, media queries, touch-event
dispatch, and client-side timing under throttling are all genuinely exercised. What is *not*
exercised is the GPU stack, real touch hardware, the Android OS, real radio behaviour, and
device-level resource pressure.

A report that blurs the two drives a fix for behaviour that may not occur on real devices.

## Decision

For MVP, "Chrome mobile" means Chromium with explicit mobile-emulation parameters: viewport,
screen dimensions, device scale factor, user agent, mobile layout behavior, touch support, locale
and timezone when configured, network and CPU profiles when configured.

Each run manifest stores resolved emulation values, not only the device profile name.

Specifically:

1. `resolved` is captured from the **live browser context after creation**, not copied from the
   profile definition. Values readable from the page (`navigator.userAgent`,
   `window.devicePixelRatio`, `navigator.maxTouchPoints`,
   `Intl.DateTimeFormat().resolvedOptions()`) are read back, and the read-back value is what is
   stored. Requested-versus-observed mismatches are recorded in `emulation.discrepancies[]` and
   surfaced as run warnings.
2. `browserVersion` is observed at launch, never templated. A user-agent string containing a
   literal version placeholder must never reach the wire.
3. Playwright device descriptors may *seed* a profile, but the profile is materialised into config
   with concrete values, so a Playwright upgrade cannot silently change what a profile meant in a
   past investigation.
4. Comparing runs across differing resolved emulation is refused unless the comparison explicitly
   declares emulation as the varied factor. A difference caused by a viewport change is not a
   finding about the product.
5. Headless versus headed is a recorded factor. A repro that occurs only headless is reported as
   such rather than presented as a user-facing defect.
6. No claim of real Android Chrome, GPU behavior, physical touch hardware, OS behavior,
   real-device resource constraints, or native apps. The boundary statement appears verbatim in
   every report, and the report linter fails on "on Android", "on a real device", or "on mobile
   Chrome" without the qualifier "emulated".

## No quiet stabilisation

The agent does not patch `Math.random` or `Date.now` in the page, does not globally disable
animations, and does not inject CSS overrides, because those change the application under test.
`reducedMotion` and `colorScheme` are real browser settings and are recorded. Any such intervention
must be a declared, recorded, approved factor. Instability is a finding, not a nuisance to suppress.

## Alternatives considered

| Alternative | Why rejected |
| --- | --- |
| Real devices via a device cloud | Correct eventually; contradicts the local, zero-infrastructure MVP and adds cost and flakiness |
| Store only the profile name | A profile definition change makes past manifests uninterpretable |
| Trust requested emulation values | Requested and applied can diverge; the divergence would be invisible |
| Allow cross-emulation comparison freely | Produces confident findings about our own configuration |

## Consequences

Positive: findings are honestly scoped; manifests remain interpretable across Playwright upgrades;
requested-versus-observed drift is visible; comparisons are apples to apples.

Negative: emulation genuinely diverges from devices, and some real defects will not reproduce here.
The system scopes the claim rather than closing the gap. Real-device support is recorded as
deferred (open question Q19).
