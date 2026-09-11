/**
 * @investigator/core
 *
 * IDs, typed errors, injected Clock, seeded Rng, canonical JSON and hashing, the schema registry,
 * the redaction-first logger, the Secret wrapper, and the config loader.
 *
 * This package performs no I/O beyond reading schema and config files, and it imports nothing from
 * any other workspace package.
 */

export * from "./types.js";
export * from "./errors.js";
export * from "./clock.js";
export * from "./rng.js";
export * from "./hash.js";
export * from "./ids.js";
export * from "./secret.js";
export * from "./logger.js";
export * from "./schema.js";
export * from "./config.js";

/** Bumped when the collector changes what or how it captures. Recorded in every manifest. */
export const COLLECTOR_VERSION = "0.1.0";
/** Bumped when normalization changes. Invalidates cached derived data (ADR-0007). */
export const NORMALIZER_VERSION = "0.1.0";
/** Bumped when feature extraction changes. */
export const EXTRACTOR_VERSION = "0.1.0";

export const GOVERNING_PRINCIPLE =
  "Playwright produces evidence. Deterministic software normalizes and measures evidence. " +
  "DeepSeek interprets and prioritizes evidence. Humans authorize consequential transitions.";
