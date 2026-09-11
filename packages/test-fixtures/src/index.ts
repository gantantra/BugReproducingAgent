/**
 * @investigator/test-fixtures
 *
 * Five deterministic fixture apps plus the fixture experiments the reliability gate runs
 * against. Imports no AI code and reaches no public network (ADR-0006).
 */

export * from "./fixture-server.js";
export * from "./experiments.js";
