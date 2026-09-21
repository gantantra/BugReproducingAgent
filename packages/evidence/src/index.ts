/**
 * @investigator/evidence — the Evidence Normalization Plane.
 *
 * Playwright produces evidence. Deterministic software normalizes and measures evidence. DeepSeek interprets and prioritizes evidence. Humans authorize consequential transitions.
 *
 * This package imports NO AI code. Enforced by the ESLint boundary rule and by
 * tests/docs/import-boundary.spec.ts (ADR-0006).
 */

export * from "./raw-events.js";
export * from "./normalize.js";
export * from "./redaction.js";
export * from "./capture-status.js";
export * from "./timeline.js";
export * from "./extract.js";
export * from "./outcome.js";
export * from "./plane.js";
export * from "./evidence-quality.js";
export * from "./signature.js";
export * from "./statistics.js";
