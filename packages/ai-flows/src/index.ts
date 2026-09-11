/**
 * @investigator/ai-flows — versioned prompt artifacts and the turn loop (ADR-0010).
 *
 * Playwright produces evidence. Deterministic software normalizes and measures evidence. DeepSeek interprets and prioritizes evidence. Humans authorize consequential transitions.
 *
 * This package contains NO prompt text. Prompts live in `/ai/flows/<id>/` as versioned files that
 * are content-hashed, so every model output traces to the exact bytes that produced it.
 */
export * from "./loader.js";
export * from "./runner.js";

export const PACKAGE_NAME = "@investigator/ai-flows";
