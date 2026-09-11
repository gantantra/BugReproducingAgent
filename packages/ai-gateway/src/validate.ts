import { schemaRegistry } from "@investigator/core";

/**
 * The validation pipeline every AI result passes, in order
 * (docs/architecture/llm-provider-contract.md, ADR-0012).
 *
 * Playwright produces evidence. Deterministic software normalizes and measures evidence. DeepSeek interprets and prioritizes evidence. Humans authorize consequential transitions.
 *
 *   parse -> schema -> unknown fields -> references -> unsupported actions -> one repair -> typed failure
 *
 * The order is the contract. Reference validation must not run against a document that failed
 * schema validation, because the reference fields themselves would be untrusted; and the repair
 * attempt must come last, because repairing a document whose references were never checked would
 * ask the model to fix the wrong thing.
 *
 * Nothing here persists anything. A result that fails is returned as a typed failure with its
 * report, and the caller persists no domain record — an invalid AI output leaves no trace in the
 * domain, only in the AI ledger.
 */

export interface ValidationIssue {
  /** `schema`, `unknown_field`, `reference`, `unsupported_action`. */
  kind: "schema" | "unknown_field" | "reference" | "unsupported_action";
  /** JSON pointer into the AI output. */
  path: string;
  message: string;
  /** Which reference check failed, when applicable (1..7). */
  check?: number;
}

export interface ValidationReport {
  ok: boolean;
  issues: ValidationIssue[];
}

export const OK: ValidationReport = { ok: true, issues: [] };

export function report(issues: ValidationIssue[]): ValidationReport {
  return { ok: issues.length === 0, issues };
}

/** Stage 1: parse. A model that returns prose around JSON has still failed to answer. */
export function parseStrictJson(
  raw: string
): { ok: true; value: unknown } | { ok: false; issue: ValidationIssue } {
  const trimmed = raw.trim();
  try {
    return { ok: true, value: JSON.parse(trimmed) };
  } catch {
    // Strict single-object extraction, used when JSON mode is unavailable. Only ONE balanced
    // object may be present: picking "the first" from several would be a guess about intent.
    const first = trimmed.indexOf("{");
    const last = trimmed.lastIndexOf("}");
    if (first >= 0 && last > first) {
      const candidate = trimmed.slice(first, last + 1);
      try {
        return { ok: true, value: JSON.parse(candidate) };
      } catch {
        /* fall through */
      }
    }
    return {
      ok: false,
      issue: {
        kind: "schema",
        path: "",
        message: "response is not parseable JSON, and no single JSON object could be extracted",
      },
    };
  }
}

/** Stage 2 and 3: schema validation, with unknown fields rejected by the schema itself. */
export function validateAgainstSchema(schemaName: string, value: unknown): ValidationReport {
  try {
    schemaRegistry().assert(schemaName, value, "AI output");
    return OK;
  } catch (e) {
    const err = e as { context?: Record<string, unknown>; message?: string };
    const ctx = err.context ?? {};
    return report([
      {
        kind: String(ctx["firstMessage"] ?? "").includes("additional propert")
          ? "unknown_field"
          : "schema",
        path: String(ctx["firstPath"] ?? ""),
        message: String(ctx["firstMessage"] ?? err.message ?? "schema validation failed"),
      },
    ]);
  }
}

// ---------------------------------------------------------------------------------------------
// Stage 4: reference validation — the seven checks
// ---------------------------------------------------------------------------------------------

export interface EvidenceReference {
  runId?: string;
  eventId?: string;
  artifactId?: string;
  statisticId?: string;
  /** JSON pointer into the normalized event or statistic payload. */
  field?: string;
  expectedValue?: unknown;
  claimCategory?: string;
}

/** What the validator may consult. Read-only: validation never reaches a browser or a provider. */
export interface ReferenceWorld {
  investigationExists(investigationId: string): boolean;
  runBelongsTo(runId: string, investigationId: string): boolean;
  eventBelongsTo(runId: string, eventId: string): boolean;
  artifactExists(artifactId: string): boolean;
  artifactKind(artifactId: string): string | null;
  /** Resolve a JSON pointer in the normalized event or statistic. `undefined` when absent. */
  resolveField(ref: EvidenceReference): { found: boolean; value: unknown };
  /** Categories that are missing or corrupted for a run, so a citation into them is not usable. */
  unusableCategories(runId: string): string[];
}

/** Check 5: which artifact kinds can support which claim. */
export const ARTIFACT_KINDS_FOR_CLAIM: Record<string, string[]> = {
  network: ["network-log", "trace"],
  console: ["console-log", "trace"],
  exception: ["console-log", "trace"],
  dom: ["dom-snapshot", "screenshot", "trace"],
  storage: ["storage-snapshot"],
  navigation: ["network-log", "trace"],
};

const REDACTION_PLACEHOLDERS = new Set(["[redacted]", "[REDACTED]", "***", null]);

/**
 * Strict deep equality. No coercion, no tolerance.
 *
 * A tolerance here would defeat the point: "RUN-17 returned 503" must be rejected when the run
 * actually returned 500, and `503 == "503"` must not pass either.
 */
function strictEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (typeof a !== "object") return false;
  return JSON.stringify(sortDeep(a)) === JSON.stringify(sortDeep(b));
}

function sortDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortDeep);
  if (v && typeof v === "object") {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>)
        .sort(([x], [y]) => x.localeCompare(y))
        .map(([k, val]) => [k, sortDeep(val)])
    );
  }
  return v;
}

export function validateReference(
  ref: EvidenceReference,
  investigationId: string,
  world: ReferenceWorld,
  path: string
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const add = (check: number, message: string): void => {
    issues.push({ kind: "reference", path, message, check });
  };

  // 1. The investigation exists.
  if (!world.investigationExists(investigationId)) {
    add(1, `investigation ${investigationId} does not exist`);
    return issues;
  }

  // 2. The run belongs to the investigation. A citation to another investigation's run is the
  //    shape a hallucinated id takes when it happens to be well-formed.
  if (ref.runId && !world.runBelongsTo(ref.runId, investigationId)) {
    add(2, `run ${ref.runId} does not belong to ${investigationId}`);
    return issues;
  }

  // 3. The event belongs to the run. Event ids are scoped per run, so an unscoped citation is
  //    ambiguous even when both ids exist.
  if (ref.eventId) {
    if (!ref.runId) add(3, `event ${ref.eventId} cited without a run; event ids are run-scoped`);
    else if (!world.eventBelongsTo(ref.runId, ref.eventId)) {
      add(3, `event ${ref.eventId} does not belong to run ${ref.runId}`);
    }
  }

  // 4. The artifact exists.
  if (ref.artifactId && !world.artifactExists(ref.artifactId)) {
    add(4, `artifact ${ref.artifactId} does not exist`);
    return issues;
  }

  // 5. The artifact kind can support this claim.
  if (ref.artifactId && ref.claimCategory) {
    const allowed = ARTIFACT_KINDS_FOR_CLAIM[ref.claimCategory];
    const kind = world.artifactKind(ref.artifactId);
    if (allowed && kind && !allowed.includes(kind)) {
      add(
        5,
        `a ${ref.claimCategory} claim cannot be supported by a ${kind} artifact (allowed: ${allowed.join(", ")})`
      );
    }
  }

  // 6. The cited field exists and matches EXACTLY. This is the anti-fabrication mechanism.
  if (ref.field !== undefined) {
    const resolved = world.resolveField(ref);
    if (!resolved.found) {
      add(6, `cited field ${ref.field} does not resolve`);
    } else if ("expectedValue" in ref) {
      if (!strictEqual(resolved.value, ref.expectedValue)) {
        add(
          6,
          `cited field ${ref.field} is ${JSON.stringify(resolved.value)}, not the claimed ${JSON.stringify(ref.expectedValue)}`
        );
      } else if (REDACTION_PLACEHOLDERS.has(resolved.value as string)) {
        // 7. A citation whose value is a redaction placeholder proves nothing.
        add(7, `cited field ${ref.field} resolves to redacted content and cannot support a claim`);
      }
    }
  }

  // 7. The source category must be usable for that run.
  if (ref.runId && ref.claimCategory) {
    const unusable = world.unusableCategories(ref.runId);
    if (unusable.includes(ref.claimCategory)) {
      add(
        7,
        `category ${ref.claimCategory} is missing or corrupted for run ${ref.runId}; a citation into it is not usable`
      );
    }
  }

  return issues;
}

export function validateReferences(
  refs: readonly EvidenceReference[],
  investigationId: string,
  world: ReferenceWorld,
  basePath = "/references"
): ValidationReport {
  const issues: ValidationIssue[] = [];
  refs.forEach((ref, i) => {
    issues.push(...validateReference(ref, investigationId, world, `${basePath}/${i}`));
  });
  return report(issues);
}

/**
 * A finding at `probable_trigger` or above needs at least one reference carrying BOTH a field and
 * an expected value.
 *
 * A purely existential citation ("see RUN-17") cannot support a causal-flavoured claim: it says
 * the run exists, not that it shows what the claim says it shows.
 */
export const LEVELS_REQUIRING_FIELD_MATCH = [
  "probable_trigger",
  "high_confidence_trigger",
  "confirmed_trigger",
  "root_cause_hypothesis",
  "confirmed_root_cause",
];

export function validateClaimSupport(
  level: string,
  refs: readonly EvidenceReference[],
  path = "/level"
): ValidationReport {
  if (!LEVELS_REQUIRING_FIELD_MATCH.includes(level)) return OK;
  const supported = refs.some((r) => r.field !== undefined && "expectedValue" in r);
  if (supported) return OK;
  return report([
    {
      kind: "unsupported_action",
      path,
      message:
        `a finding at level ${level} needs at least one reference with a field and an expectedValue; ` +
        `an existential citation cannot support a causal claim`,
    },
  ]);
}

/**
 * `confirmed_root_cause` requires approved direct evidence, and the MVP ships no command that
 * mints such an attestation. It is therefore unreachable BY DESIGN, and saying so plainly is the
 * point: the ladder's top rung is not something a model can talk its way onto.
 */
export function rejectUnreachableLevel(
  level: string,
  hasDirectEvidenceAttestation: boolean
): ValidationReport {
  if (level !== "confirmed_root_cause") return OK;
  if (hasDirectEvidenceAttestation) return OK;
  return report([
    {
      kind: "unsupported_action",
      path: "/level",
      message:
        "confirmed_root_cause requires an approved direct-evidence attestation. " +
        "No command mints one in this build, so this level is unreachable by design (ADR-0012).",
    },
  ]);
}
