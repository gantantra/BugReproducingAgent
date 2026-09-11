import { createHash } from "node:crypto";

/**
 * Canonical JSON and hashing.
 *
 * Canonicalisation is load-bearing twice over: gate proposals are checksum-bound to their exact
 * bytes (ADR-0013), and the Normalization Plane must produce byte-identical output for identical
 * inputs (ADR-0007). Both need one agreed serialisation.
 *
 * Canonical form: object keys sorted lexicographically by UTF-16 code unit, two-space indentation,
 * LF line endings, UTF-8 without BOM, trailing newline.
 */

export type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };

function sortValue(value: unknown): JsonValue {
  if (value === null) return null;
  if (Array.isArray(value)) return value.map(sortValue);
  if (typeof value === "object") {
    const src = value as Record<string, unknown>;
    const out: Record<string, JsonValue> = {};
    for (const key of Object.keys(src).sort()) {
      const v = src[key];
      // Drop undefined rather than emitting it: JSON has no undefined, and silently
      // stringifying it to null would change the hash for a semantically identical record.
      if (v === undefined) continue;
      out[key] = sortValue(v);
    }
    return out;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`canonicalJson: non-finite number cannot be canonicalised (${String(value)})`);
    }
    return value;
  }
  if (typeof value === "string" || typeof value === "boolean") return value;
  throw new Error(`canonicalJson: unsupported value of type ${typeof value}`);
}

/** Canonical pretty form, with a trailing newline. This is what gets written to disk and hashed. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value), null, 2) + "\n";
}

/** Canonical compact form. For hashing where no human reads the bytes. */
export function canonicalCompactJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Prefixed form used in every schema: `sha256:<64 hex>`. */
export function sha256Prefixed(data: string | Uint8Array): string {
  return `sha256:${sha256Hex(data)}`;
}

/** Hash of the canonical pretty form. Matches what a reader would get by hashing the file. */
export function hashCanonical(value: unknown): string {
  return sha256Prefixed(canonicalJson(value));
}

/** Hash of the canonical compact form. */
export function hashCanonicalCompact(value: unknown): string {
  return sha256Prefixed(canonicalCompactJson(value));
}

/**
 * Seal a record: hash every field except the seal field itself, so the seal covers the whole
 * recorded content including the artifact digest list (ADR-0004).
 */
export function computeSealHash<T extends Record<string, unknown>>(
  record: T,
  sealField: keyof T & string
): string {
  const { [sealField]: _omitted, ...rest } = record;
  return hashCanonicalCompact(rest);
}

export function verifySealHash<T extends Record<string, unknown>>(
  record: T,
  sealField: keyof T & string
): { ok: boolean; expected: string; actual: unknown } {
  const expected = computeSealHash(record, sealField);
  const actual = record[sealField];
  return { ok: actual === expected, expected, actual };
}

/**
 * Chain link for lineage: sha256(canonical(record without recordHash) || prevRecordHash).
 * Makes a rewrite of history detectable, which is the honest guarantee for a local tool.
 */
export function computeChainHash(
  record: Record<string, unknown>,
  prevRecordHash: string | null
): string {
  const { recordHash: _omit, ...rest } = record;
  return sha256Prefixed(canonicalCompactJson(rest) + (prevRecordHash ?? ""));
}

export function shortSha(prefixedOrHex: string, length = 12): string {
  const hex = prefixedOrHex.startsWith("sha256:") ? prefixedOrHex.slice(7) : prefixedOrHex;
  return hex.slice(0, length);
}
