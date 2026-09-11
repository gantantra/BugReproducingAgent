import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import type { RedactionStamp } from "@investigator/core";
import { InvestigatorError, fail, sha256Prefixed, schemaRegistry } from "@investigator/core";

/**
 * Redaction engine (ADR-0008, docs/security/redaction-policy.md).
 *
 * Properties that matter:
 *  - Pure. Every rule is a function of the field value plus declared metadata. No time, no
 *    randomness, no network, so redaction is byte-identical across platforms and runs.
 *  - Strict by default. A field the policy cannot classify is treated as sensitive.
 *  - Bounded. Patterns are linear-time-linted at load and applied under a per-field byte cap, so
 *    a large response body cannot cause pathological backtracking.
 *  - Accountable. Every result carries a stamp naming the policy, its hash, and which rules fired.
 */

export const REDACTED = "[redacted]";

export type RedactionAction =
  "keep" | "mask-value" | "mask-match" | "drop-value" | "names-only" | "hash-value";

export type FieldScope =
  | "network.url"
  | "network.requestHeaders"
  | "network.responseHeaders"
  | "network.responseBody"
  | "network.requestBody"
  | "navigation.url"
  | "action.url"
  | "action.inputValue"
  | "console.text"
  | "exception.message"
  | "dom.text"
  | "dom.attributes"
  | "storage.cookies"
  | "storage.localStorage"
  | "storage.sessionStorage"
  | "storage.indexedDb"
  | "storage.values";

export interface RedactionMatch {
  any?: true;
  headerNameIn?: string[];
  queryKeyMatches?: string;
  keyMatches?: string;
  valueMatches?: string;
  contentTypeIn?: string[];
  inputTypeIn?: string[];
  luhnCandidate?: boolean;
  digitsBetween?: [number, number];
  entropyBitsPerCharAtLeast?: number;
  minLength?: number;
  charsetIn?: Array<"base64" | "base64url" | "hex" | "alphanumeric">;
}

export interface RedactionRule {
  id: string;
  appliesTo: FieldScope[];
  match: RedactionMatch;
  action: RedactionAction;
  keepName?: boolean;
  keepMetadata?: string[];
  exceptions?: { domainIn?: string[]; keyIn?: string[] };
  unless?: { contentTypeIn?: string[]; andOptIn?: string };
  stage?: "collection" | "normalization";
  note?: string;
}

export interface RedactionPolicy {
  policyId: string;
  policyVersion: string;
  mode: "strict" | "permissive";
  defaults: {
    unknownFieldAction: RedactionAction;
    valueReplacement: string;
    shapeDescriptor?: boolean;
    maxFieldBytesScanned?: number;
  };
  rules: RedactionRule[];
}

export interface ValueShape {
  type: string;
  length: number;
  sha256Prefix: string;
}

export interface RedactionOutcome {
  /** The redacted value, or undefined when the rule dropped it. */
  value: string | undefined;
  action: RedactionAction;
  ruleId: string | null;
  shape?: ValueShape;
  changed: boolean;
}

/** Compiled once at load. `(?i)` prefix is supported for readability in the YAML. */
interface CompiledRule extends RedactionRule {
  compiledValue?: RegExp;
  compiledQueryKey?: RegExp;
  compiledKey?: RegExp;
}

/**
 * Reject patterns whose worst case is superlinear. Not a proof of safety, but it catches the
 * nested-quantifier shapes that actually cause trouble, and the per-field byte cap bounds the rest.
 */
export function lintPattern(pattern: string): string | null {
  const body = pattern.startsWith("(?i)") ? pattern.slice(4) : pattern;
  if (/\([^)]*[+*]\)[+*]/.test(body)) return "nested quantifier over a group";
  if (/\([^)]*\|[^)]*\)[+*]/.test(body) && /[+*]/.test(body.replace(/\([^)]*\)/g, ""))) {
    return "alternation under a quantifier with adjacent quantifiers";
  }
  if (/(\[[^\]]*\][+*]){3,}/.test(body)) return "three or more adjacent quantified classes";
  try {
    new RegExp(body);
  } catch (e) {
    return `not a valid regular expression: ${e instanceof Error ? e.message : String(e)}`;
  }
  return null;
}

function compile(pattern: string, ruleId: string, field: string): RegExp {
  const problem = lintPattern(pattern);
  if (problem) {
    fail("REDACTION_POLICY_MISSING", `Rule ${ruleId} ${field} pattern rejected: ${problem}`, {
      context: { ruleId, field },
    });
  }
  const ci = pattern.startsWith("(?i)");
  const body = ci ? pattern.slice(4) : pattern;
  return new RegExp(body, ci ? "gi" : "g");
}

function shannonBitsPerChar(s: string): number {
  if (!s.length) return 0;
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  for (const c of counts.values()) {
    const p = c / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

function looksLikeCharset(s: string, sets: readonly string[]): boolean {
  for (const set of sets) {
    if (set === "hex" && /^[0-9a-fA-F]+$/.test(s)) return true;
    if (set === "base64" && /^[A-Za-z0-9+/=]+$/.test(s)) return true;
    if (set === "base64url" && /^[A-Za-z0-9_-]+$/.test(s)) return true;
    if (set === "alphanumeric" && /^[A-Za-z0-9]+$/.test(s)) return true;
  }
  return false;
}

function passesLuhn(digits: string): boolean {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (d < 0 || d > 9) return false;
    if (alt) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    alt = !alt;
  }
  return sum % 10 === 0;
}

function shapeOf(value: string): ValueShape {
  return {
    type: typeof value,
    length: value.length,
    sha256Prefix: sha256Prefixed(value).slice(7, 19),
  };
}

export class Redactor {
  readonly policy: RedactionPolicy;
  readonly policyHash: string;
  private readonly byScope = new Map<FieldScope, CompiledRule[]>();
  private readonly maxBytes: number;
  private readonly applied = new Map<string, number>();

  constructor(policy: RedactionPolicy, policyHash: string) {
    this.policy = policy;
    this.policyHash = policyHash;
    this.maxBytes = policy.defaults.maxFieldBytesScanned ?? 1_048_576;

    for (const rule of policy.rules) {
      const compiled: CompiledRule = { ...rule };
      if (rule.match.valueMatches) {
        compiled.compiledValue = compile(rule.match.valueMatches, rule.id, "valueMatches");
      }
      if (rule.match.queryKeyMatches) {
        compiled.compiledQueryKey = compile(rule.match.queryKeyMatches, rule.id, "queryKeyMatches");
      }
      if (rule.match.keyMatches) {
        compiled.compiledKey = compile(rule.match.keyMatches, rule.id, "keyMatches");
      }
      for (const scope of rule.appliesTo) {
        const list = this.byScope.get(scope) ?? [];
        list.push(compiled);
        this.byScope.set(scope, list);
      }
    }
  }

  static fromFile(path: string): Redactor {
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch (e) {
      throw new InvestigatorError("REDACTION_POLICY_MISSING", "Cannot read redaction policy", {
        context: { path },
        cause: e,
      });
    }
    return Redactor.fromString(text);
  }

  static fromString(text: string): Redactor {
    let parsed: unknown;
    try {
      parsed = parseYaml(text);
    } catch (e) {
      throw new InvestigatorError(
        "REDACTION_POLICY_MISSING",
        "Redaction policy is not valid YAML",
        {
          cause: e,
        }
      );
    }
    const registry = schemaRegistry();
    const policy = registry.assert<RedactionPolicy>(
      "redaction-policy.v1.json",
      parsed,
      "redaction policy"
    );
    // The hash is over the exact file bytes, so a stamp identifies the policy unambiguously.
    return new Redactor(policy, sha256Prefixed(text));
  }

  /** Counter of rule hits, used to build the stamp. */
  private note(ruleId: string): void {
    this.applied.set(ruleId, (this.applied.get(ruleId) ?? 0) + 1);
  }

  resetCounters(): void {
    this.applied.clear();
  }

  /**
   * Policy identity without occurrence counts. Embedded per event, because counts are a running
   * total and would make otherwise-identical events differ between the original run and a
   * replay, breaking the pure-function property (ADR-0007).
   */
  policyStamp(): RedactionStamp {
    return {
      policyId: this.policy.policyId,
      policyVersion: this.policy.policyVersion,
      policyHash: this.policyHash,
      mode: this.policy.mode,
      appliedRules: [],
    };
  }

  /** Full stamp including occurrence counts. For CaptureStatus and artifact refs. */
  stamp(): RedactionStamp {
    return {
      policyId: this.policy.policyId,
      policyVersion: this.policy.policyVersion,
      policyHash: this.policyHash,
      mode: this.policy.mode,
      appliedRules: [...this.applied.entries()]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([ruleId, occurrences]) => ({ ruleId, occurrences })),
    };
  }

  private matches(
    rule: CompiledRule,
    value: string,
    ctx: { key?: string; headerName?: string; contentType?: string; inputType?: string }
  ): boolean {
    const m = rule.match;

    if (m.headerNameIn) {
      if (!ctx.headerName) return false;
      if (!m.headerNameIn.some((h) => h.toLowerCase() === ctx.headerName!.toLowerCase()))
        return false;
    }
    if (m.contentTypeIn) {
      if (!ctx.contentType) return false;
      if (
        !m.contentTypeIn.some((c) => ctx.contentType!.toLowerCase().startsWith(c.toLowerCase()))
      ) {
        return false;
      }
    }
    if (m.inputTypeIn) {
      if (!ctx.inputType) return false;
      if (!m.inputTypeIn.includes(ctx.inputType)) return false;
    }
    if (rule.compiledKey) {
      if (!ctx.key) return false;
      rule.compiledKey.lastIndex = 0;
      if (!rule.compiledKey.test(ctx.key)) return false;
    }
    if (m.minLength !== undefined && value.length < m.minLength) return false;
    if (m.charsetIn && !looksLikeCharset(value, m.charsetIn)) return false;
    if (m.entropyBitsPerCharAtLeast !== undefined) {
      if (shannonBitsPerChar(value) < m.entropyBitsPerCharAtLeast) return false;
    }
    if (m.digitsBetween) {
      const digits = value.replace(/\D/g, "");
      const [lo, hi] = m.digitsBetween;
      if (digits.length < lo || digits.length > hi) return false;
      if (m.luhnCandidate && !passesLuhn(digits)) return false;
    } else if (m.luhnCandidate) {
      const digits = value.replace(/\D/g, "");
      if (digits.length < 13 || digits.length > 19 || !passesLuhn(digits)) return false;
    }
    if (rule.compiledValue) {
      rule.compiledValue.lastIndex = 0;
      if (!rule.compiledValue.test(value)) return false;
    }
    if (m.any) return true;

    // A rule with no positive term is a configuration mistake, not a match-everything rule.
    return Boolean(
      m.headerNameIn ||
      m.contentTypeIn ||
      m.inputTypeIn ||
      rule.compiledKey ||
      rule.compiledValue ||
      m.luhnCandidate ||
      m.entropyBitsPerCharAtLeast !== undefined
    );
  }

  private excepted(rule: CompiledRule, value: string, key?: string): boolean {
    if (!rule.exceptions) return false;
    if (rule.exceptions.keyIn && key && rule.exceptions.keyIn.includes(key)) return true;
    if (rule.exceptions.domainIn) {
      for (const d of rule.exceptions.domainIn) {
        if (value.toLowerCase().includes(`@${d.toLowerCase()}`)) return true;
        if (value.toLowerCase().endsWith(d.toLowerCase())) return true;
      }
    }
    return false;
  }

  /**
   * Redact one field value. Returns the value plus which rule fired, so the caller can record
   * `redactedFields` on the event and the caller never has to guess whether anything happened.
   */
  redactField(
    scope: FieldScope,
    value: string | undefined | null,
    ctx: {
      key?: string;
      headerName?: string;
      contentType?: string;
      inputType?: string;
      optIns?: ReadonlySet<string>;
    } = {}
  ): RedactionOutcome {
    if (value === undefined || value === null) {
      return { value: undefined, action: "keep", ruleId: null, changed: false };
    }
    // Bound the work. Beyond the cap we do not scan; we mask, which fails safe.
    if (Buffer.byteLength(value, "utf8") > this.maxBytes) {
      this.note("oversize-field-masked");
      return {
        value: this.policy.defaults.valueReplacement,
        action: "mask-value",
        ruleId: "oversize-field-masked",
        shape: shapeOf(value),
        changed: true,
      };
    }

    const rules = this.byScope.get(scope) ?? [];

    // `mask-match` rules COMPOSE; terminal actions short-circuit.
    //
    // Returning on the first match was a false-assurance bug: one body can contain a JWT, an
    // API key, an email, a phone number, a card, and a government id, and masking only the
    // first one still produced a RedactionStamp claiming the field was handled. Declaration
    // order is preserved, and each rule is matched against the PROGRESSIVELY masked value so
    // already-redacted content is not rescanned.
    let working = value;
    const composed: string[] = [];

    for (const rule of rules) {
      if (rule.unless?.contentTypeIn && ctx.contentType) {
        const typeExempt = rule.unless.contentTypeIn.some((c) =>
          ctx.contentType!.toLowerCase().startsWith(c.toLowerCase())
        );
        const optIn = rule.unless.andOptIn ? ctx.optIns?.has(rule.unless.andOptIn) === true : true;
        if (typeExempt && optIn) continue;
      }
      if (!this.matches(rule, working, ctx)) continue;
      if (this.excepted(rule, working, ctx.key)) continue;

      if (rule.action === "mask-match") {
        this.note(rule.id);
        let out: string;
        if (rule.compiledValue) {
          rule.compiledValue.lastIndex = 0;
          out = working.replace(rule.compiledValue, this.policy.defaults.valueReplacement);
        } else {
          // A mask-match rule with no pattern cannot know what to replace, so it masks the
          // whole value. Failing safe is correct; a rule author wanting surgical masking must
          // supply valueMatches.
          out = this.policy.defaults.valueReplacement;
        }
        if (out !== working) {
          working = out;
          composed.push(rule.id);
        }
        continue;
      }

      this.note(rule.id);
      switch (rule.action) {
        case "keep":
          // An explicit keep ends the scan, but anything already masked stays masked.
          return composed.length
            ? { value: working, action: "mask-match", ruleId: composed.join("+"), changed: true }
            : { value: working, action: "keep", ruleId: rule.id, changed: false };
        case "mask-value":
          return {
            value: this.policy.defaults.valueReplacement,
            action: rule.action,
            ruleId: rule.id,
            ...(this.policy.defaults.shapeDescriptor !== false ? { shape: shapeOf(value) } : {}),
            changed: true,
          };
        case "drop-value":
        case "names-only":
          return { value: undefined, action: rule.action, ruleId: rule.id, changed: true };
        case "hash-value":
          // Preserves cross-run comparability without disclosure: two runs can be shown to
          // have used different tokens without revealing either.
          return {
            value: `sha256:${shapeOf(value).sha256Prefix}`,
            action: rule.action,
            ruleId: rule.id,
            changed: true,
          };
      }
    }

    if (composed.length) {
      return { value: working, action: "mask-match", ruleId: composed.join("+"), changed: true };
    }

    // Strict mode: anything the policy could not classify is sensitive.
    if (this.policy.mode === "strict" && this.policy.defaults.unknownFieldAction !== "keep") {
      const scopesWithRules = this.byScope.has(scope);
      if (!scopesWithRules) {
        this.note("unknown-field-default");
        return {
          value:
            this.policy.defaults.unknownFieldAction === "drop-value"
              ? undefined
              : this.policy.defaults.valueReplacement,
          action: this.policy.defaults.unknownFieldAction,
          ruleId: "unknown-field-default",
          shape: shapeOf(value),
          changed: true,
        };
      }
    }

    return { value, action: "keep", ruleId: null, changed: false };
  }

  /**
   * Reassemble a URL with its query values redacted, for storage at COLLECTION time.
   *
   * The raw event log is persisted, so a URL buffered verbatim puts `?access_token=...` on disk
   * no matter what normalization does later. The policy marks `url-query-secrets` as a
   * collection-stage rule precisely so this never happens. Idempotent: re-running it over an
   * already-masked URL is a no-op.
   */
  redactUrlString(scope: "network.url" | "navigation.url" | "action.url", rawUrl: string): string {
    const parts = this.redactUrl(scope, rawUrl);
    if (!parts.origin) return parts.path;
    const query = parts.queryKeys
      .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(parts.query[k] ?? "")}`)
      .join("&");
    return `${parts.origin}${parts.path}${query ? `?${query}` : ""}`;
  }

  /** Redact a header map, retaining names and dropping or masking values per policy. */
  redactHeaders(
    scope: "network.requestHeaders" | "network.responseHeaders",
    headers: Record<string, string>
  ): { headerNames: string[]; values: Record<string, string>; redactedNames: string[] } {
    const names = Object.keys(headers).sort();
    const values: Record<string, string> = {};
    const redactedNames: string[] = [];
    for (const name of names) {
      const raw = headers[name] as string;
      const outcome = this.redactField(scope, raw, { headerName: name, key: name });
      if (outcome.value === undefined) {
        redactedNames.push(name);
        continue;
      }
      if (outcome.changed) redactedNames.push(name);
      values[name] = outcome.value;
    }
    return { headerNames: names, values, redactedNames };
  }

  /**
   * Redact a URL into normalized parts. Origin and path survive; query values are decided per key
   * so `?q=laptop` stays readable while `?access_token=...` does not.
   */
  redactUrl(
    scope: "network.url" | "navigation.url" | "action.url",
    rawUrl: string
  ): {
    origin: string;
    path: string;
    queryKeys: string[];
    query: Record<string, string | null>;
    fragmentPresent: boolean;
    redactedKeys: string[];
  } {
    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch {
      const outcome = this.redactField(scope, rawUrl);
      return {
        origin: "",
        path: outcome.value ?? REDACTED,
        queryKeys: [],
        query: {},
        fragmentPresent: false,
        redactedKeys: [],
      };
    }

    const queryKeys = [...parsed.searchParams.keys()].sort();
    const query: Record<string, string | null> = {};
    const redactedKeys: string[] = [];

    for (const key of queryKeys) {
      const raw = parsed.searchParams.get(key) ?? "";
      // Query-key rules are expressed as queryKeyMatches, which `matches` reads via keyMatches
      // semantics, so pass the key in both slots.
      let hit: RedactionOutcome = { value: raw, action: "keep", ruleId: null, changed: false };
      for (const rule of this.byScope.get(scope) ?? []) {
        if (rule.compiledQueryKey) {
          rule.compiledQueryKey.lastIndex = 0;
          if (!rule.compiledQueryKey.test(key)) continue;
          this.note(rule.id);
          hit =
            rule.action === "drop-value"
              ? { value: undefined, action: rule.action, ruleId: rule.id, changed: true }
              : {
                  value: this.policy.defaults.valueReplacement,
                  action: rule.action,
                  ruleId: rule.id,
                  changed: true,
                };
          break;
        }
      }
      if (!hit.changed) {
        hit = this.redactField(scope, raw, { key });
      }
      if (hit.changed || hit.value === undefined) redactedKeys.push(key);
      query[key] = hit.value ?? null;
    }

    return {
      origin: parsed.origin,
      path: parsed.pathname,
      queryKeys,
      query,
      fragmentPresent: parsed.hash.length > 0,
      redactedKeys,
    };
  }
}

/**
 * Detection-only verification. Used before provider transmission and before export: a hit means
 * an earlier stage has a bug, so it is an error rather than a silent fix (ADR-0008).
 */
export interface ResidueFinding {
  pattern: string;
  count: number;
  firstIndex: number;
}

const RESIDUE_PATTERNS: Array<{ label: string; re: RegExp }> = [
  { label: "bearer", re: /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi },
  { label: "jwt", re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
  { label: "set-cookie", re: /\bset-cookie\s*:\s*\S+=\S+/gi },
  { label: "authorization-header", re: /\bauthorization\s*:\s*\S{12,}/gi },
  {
    label: "token-query",
    re: /[?&](access_token|id_token|refresh_token|api_key|apikey)=[^&\s"]{8,}/gi,
  },
  { label: "private-key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
];

export function scanForResidue(
  text: string,
  extraLiterals: readonly string[] = []
): ResidueFinding[] {
  const findings: ResidueFinding[] = [];
  for (const { label, re } of RESIDUE_PATTERNS) {
    re.lastIndex = 0;
    const matches = [...text.matchAll(re)];
    if (matches.length) {
      findings.push({
        pattern: label,
        count: matches.length,
        firstIndex: matches[0]?.index ?? -1,
      });
    }
  }
  for (const literal of extraLiterals) {
    if (literal.length < 4) continue;
    let count = 0;
    let idx = text.indexOf(literal);
    const first = idx;
    while (idx !== -1) {
      count++;
      idx = text.indexOf(literal, idx + literal.length);
    }
    if (count) findings.push({ pattern: "known-literal", count, firstIndex: first });
  }
  return findings;
}
