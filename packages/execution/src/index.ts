/**
 * @investigator/execution
 *
 * Playwright produces evidence. Deterministic software normalizes and measures evidence. DeepSeek interprets and prioritizes evidence. Humans authorize consequential transitions.
 *
 * This package imports NO AI code and never will (ADR-0006). Enforced by the ESLint boundary
 * rule, by TypeScript project references, and by tests/docs/import-boundary.spec.ts.
 */

export * from "./types.js";
export * from "./destructive-classifier.js";
export * from "./collector.js";
export * from "./action-interpreter.js";
export * from "./emulation.js";
export * from "./manifest.js";
export * from "./worker.js";
export * from "./enqueue.js";
export * from "./suite-capture.js";
