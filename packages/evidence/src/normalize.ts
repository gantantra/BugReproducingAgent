import { sha256Prefixed } from "@investigator/core";

/**
 * Canonicalisation (ADR-0007, stage 2).
 *
 * Everything here is a pure function of its input. The purpose is to make cross-run comparison
 * mean something: without it, every comparison is dominated by volatile IDs, bundle hashes,
 * attribute ordering, and absolute timestamps, and the model would faithfully find patterns in
 * that noise.
 *
 * Where canonicalisation could hide a real difference, the original is retained alongside the
 * normalized form wherever the redaction policy permits, and durations are reported both raw and
 * bucketed.
 */

/** Path segments that are clearly identifiers become typed placeholders. */
const SEGMENT_RULES: Array<{ re: RegExp; token: string }> = [
  { re: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, token: "{uuid}" },
  { re: /^\d+$/, token: "{int}" },
  { re: /^[0-9a-f]{16,}$/i, token: "{hex}" },
  { re: /^[A-Za-z0-9_-]{22,}$/, token: "{b64url}" },
];

export function normalizePathTemplate(path: string): string {
  return path
    .split("/")
    .map((seg) => {
      if (!seg) return seg;
      for (const { re, token } of SEGMENT_RULES) {
        if (re.test(seg)) return token;
      }
      return seg;
    })
    .join("/");
}

/**
 * A stable key for a network request across runs. Method plus origin plus path template: enough
 * to line up "the same request" in two runs, without the volatile parts that would split it.
 */
export function requestKey(method: string, origin: string, path: string): string {
  return `${method.toUpperCase()} ${origin}${normalizePathTemplate(path)}`;
}

/** Whitespace, quote style, and attribute order made canonical so two selectors compare equal. */
export function canonicalSelector(input: {
  strategy: string;
  value?: string;
  role?: string;
  name?: string;
  exact?: boolean;
  nth?: number;
}): string {
  const parts: string[] = [input.strategy];
  if (input.role) parts.push(`role=${input.role}`);
  if (input.name !== undefined)
    parts.push(`name=${JSON.stringify(collapseWhitespace(input.name))}`);
  if (input.value !== undefined)
    parts.push(`value=${JSON.stringify(collapseWhitespace(input.value))}`);
  if (input.exact !== undefined) parts.push(`exact=${input.exact}`);
  if (input.nth !== undefined) parts.push(`nth=${input.nth}`);
  return parts.join("|");
}

export function collapseWhitespace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/**
 * Replace volatile substrings in console and exception text so a fingerprint is stable across
 * runs. The ORIGINAL text is kept on the event (subject to redaction); this output is only used
 * for fingerprinting and grouping.
 */
const VOLATILE_RULES: Array<{ re: RegExp; token: string }> = [
  { re: /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?\b/g, token: "{ts}" },
  { re: /\b\d{13}\b/g, token: "{epoch_ms}" },
  { re: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, token: "{uuid}" },
  { re: /\b0x[0-9a-f]{6,}\b/gi, token: "{addr}" },
  { re: /:\d{2,5}\b/g, token: ":{port}" },
  { re: /\b[0-9a-f]{32,}\b/gi, token: "{hash}" },
  { re: /:\d+:\d+\b/g, token: ":{line}:{col}" },
  { re: /\b\d+(\.\d+)?ms\b/g, token: "{dur}" },
  { re: /\b\d{6,}\b/g, token: "{bignum}" },
];

export function normalizeMessageText(text: string): string {
  let out = collapseWhitespace(text);
  for (const { re, token } of VOLATILE_RULES) out = out.replace(re, token);
  return out;
}

export function textFingerprint(text: string): string {
  return `cf_${sha256Prefixed(normalizeMessageText(text)).slice(7, 15)}`;
}

export interface NormalizedFrame {
  function: string;
  file: string;
  line: number;
  column: number | null;
}

/**
 * Normalize a stack trace. Bundle hashes and query strings are stripped from file URLs, because
 * `app.4f3a91.js` and `app.9c2b17.js` are the same file across two deploys and splitting them
 * would split every fingerprint.
 */
export function normalizeStack(stack: string | undefined): NormalizedFrame[] {
  if (!stack) return [];
  const frames: NormalizedFrame[] = [];
  for (const rawLine of stack.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("Error") || line.startsWith("TypeError")) continue;
    // `at fn (url:line:col)` and bare `at url:line:col`
    const m =
      /^at\s+(.+?)\s+\((.+?):(\d+):(\d+)\)$/.exec(line) ?? /^at\s+(.+?):(\d+):(\d+)$/.exec(line);
    if (!m) continue;
    if (m.length === 5) {
      frames.push({
        function: m[1] ?? "<anonymous>",
        file: normalizeScriptUrl(m[2] ?? ""),
        line: Number.parseInt(m[3] ?? "0", 10),
        column: Number.parseInt(m[4] ?? "0", 10),
      });
    } else {
      frames.push({
        function: "<anonymous>",
        file: normalizeScriptUrl(m[1] ?? ""),
        line: Number.parseInt(m[2] ?? "0", 10),
        column: Number.parseInt(m[3] ?? "0", 10),
      });
    }
  }
  return frames;
}

export function normalizeScriptUrl(url: string): string {
  let out = url.split("?")[0] ?? url;
  // Strip content hashes in filenames: app.4f3a91.js -> app.{hash}.js
  out = out.replace(/\.[0-9a-f]{6,}(\.\w+)$/i, ".{hash}$1");
  out = out.replace(/-[0-9a-f]{8,}(\.\w+)$/i, "-{hash}$1");
  return out;
}

/**
 * Exception fingerprint over the normalized message plus the top N normalized frames. N is
 * configurable because too many frames splits a single defect across call paths, and too few
 * merges distinct defects.
 */
export function exceptionFingerprint(
  message: string,
  frames: readonly NormalizedFrame[],
  topN = 5
): string {
  const material = [
    normalizeMessageText(message),
    ...frames.slice(0, topN).map((f) => `${f.function}@${f.file}:${f.line}`),
  ].join("\n");
  return `ex_${sha256Prefixed(material).slice(7, 15)}`;
}

/**
 * Duration buckets, reported alongside the raw value. Comparison uses buckets so a 3ms jitter is
 * not a "difference", while the raw number stays available for a finding that needs it.
 */
const BUCKET_EDGES = [10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000];

export function durationBucket(ms: number): string {
  if (ms < 0) return "invalid";
  let lower = 0;
  for (const edge of BUCKET_EDGES) {
    if (ms < edge) return `${lower}-${edge}ms`;
    lower = edge;
  }
  return `${lower}ms+`;
}

/**
 * Canonical DOM serialisation: attributes sorted, whitespace-only text nodes collapsed, and
 * configured volatile attributes masked. Operates on the serialized shape the collector produces
 * in-page, so this module needs no DOM.
 */
export interface DomNode {
  tag: string;
  attrs?: Record<string, string>;
  text?: string;
  children?: DomNode[];
}

const VOLATILE_ATTR_PATTERNS = [
  /^data-reactid$/i,
  /^data-react-/i,
  /^data-v-[0-9a-f]+$/i,
  /^aria-owns$/i,
  /^aria-activedescendant$/i,
];

const VOLATILE_ID_VALUE = /^(?:[0-9a-f]{8,}|.*[-_](?:[0-9a-f]{8,}|\d{6,})$)/i;

export interface CanonicalDomOptions {
  maskInlineStyle?: boolean;
  extraVolatileAttrs?: readonly string[];
}

export function canonicalizeDom(node: DomNode, opts: CanonicalDomOptions = {}): DomNode {
  const out: DomNode = { tag: node.tag.toLowerCase() };

  if (node.attrs) {
    const attrs: Record<string, string> = {};
    for (const key of Object.keys(node.attrs).sort()) {
      const lower = key.toLowerCase();
      const value = node.attrs[key] as string;

      if (VOLATILE_ATTR_PATTERNS.some((re) => re.test(lower))) {
        attrs[lower] = "{volatile}";
        continue;
      }
      if (opts.extraVolatileAttrs?.some((a) => a.toLowerCase() === lower)) {
        attrs[lower] = "{volatile}";
        continue;
      }
      if (lower === "style" && opts.maskInlineStyle) {
        attrs[lower] = "{style}";
        continue;
      }
      if (lower === "id" && VOLATILE_ID_VALUE.test(value)) {
        attrs[lower] = "{volatile-id}";
        continue;
      }
      if (lower === "class") {
        // Sort class tokens: order is not semantic and reorderings are pure noise.
        attrs[lower] = value.split(/\s+/).filter(Boolean).sort().join(" ");
        continue;
      }
      attrs[lower] = collapseWhitespace(value);
    }
    if (Object.keys(attrs).length) out.attrs = attrs;
  }

  if (node.text !== undefined) {
    const collapsed = collapseWhitespace(node.text);
    if (collapsed) out.text = collapsed;
  }

  if (node.children?.length) {
    const kids = node.children
      .map((c) => canonicalizeDom(c, opts))
      // Drop nodes that became empty: a whitespace-only text node is not structure.
      .filter((c) => c.tag !== "#text" || c.text !== undefined);
    if (kids.length) out.children = kids;
  }

  return out;
}

export function domStructureHash(node: DomNode): string {
  // Structure only: tags, attribute names, and nesting. Text is deliberately excluded so a
  // content change does not register as a structural change.
  const walk = (n: DomNode): string => {
    const attrNames = n.attrs ? Object.keys(n.attrs).sort().join(",") : "";
    const kids = (n.children ?? []).map(walk).join("");
    return `<${n.tag}[${attrNames}]${kids}>`;
  };
  return sha256Prefixed(walk(node)).slice(7);
}

export function countDomNodes(node: DomNode): number {
  return 1 + (node.children ?? []).reduce((acc, c) => acc + countDomNodes(c), 0);
}
