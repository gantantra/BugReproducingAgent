import type { ActionSpec, SelectorSpec, TestDataValue } from "@investigator/execution";

/**
 * Translating an authoring session into the closed action vocabulary, so a measured run can
 * execute what the browser session proved (ADR-0027 authoring, ADR-0006 execution).
 *
 * WHY THIS EXISTS
 *
 * The authoring session emits raw Playwright statements — `AuthoredStep.code` is a string, not
 * structured data. That string is enough to hand a developer a runnable spec, but it is NOT
 * enough to measure: `investigate run` executes the effective proposal from the
 * `experiment_selection` gate, and that proposal is a list of `action.v1` actions. Without a
 * translation the two halves of the product stay parallel — the authored script runs in its own
 * folder recording video and nothing else, while the evidence pipeline, the lineage graph and
 * the analysis flow all sit on the other side reading runs that this script can never produce.
 *
 * WHY A PARSER RATHER THAN A PASSTHROUGH
 *
 * Executing the string itself is not available. ADR-0006 forbids shell execution or `evaluate`
 * derived from model output, and the reason is not ceremony: a statement that can run arbitrary
 * source can satisfy any assertion without the application doing anything. So the statement has
 * to be understood, reduced to declared vocabulary, and refused when it cannot be.
 *
 * WHY NOT THE TYPESCRIPT COMPILER API
 *
 * It would be the obvious parser, and `typescript` is present — but only as a devDependency.
 * Making the CLI depend on the compiler at runtime to read a handful of method chains is a large
 * dependency for a small grammar. The grammar here is narrow and fully known, so it is scanned
 * directly. What is NOT done directly is regex matching over the raw line: a selector legitimately
 * contains braces, quotes, commas and newlines, and a regex over `getByText('a, b) {c}')` mangles
 * exactly the interesting cases. Everything below is string-literal aware.
 *
 * WHY IT REFUSES SO READILY
 *
 * Every unrecognised form is a refusal naming the statement, never a best guess. A mistranslated
 * selector does not fail loudly — it silently measures a DIFFERENT flow than the one the human
 * approved by watching it work, and reports a pass rate for it. That is the most expensive wrong
 * answer this product can produce, because it looks like a result. A refusal is visible and
 * fixable; a quiet substitution is neither.
 */

/** One `action.v1` action plus the statement it came from, kept paired for the round-trip check. */
export interface TranslatedAction {
  action: ActionSpec;
  /** The original statement, normalized. Recorded so a reader can audit the translation. */
  statement: string;
}

export type TranslationResult =
  | { ok: true; actions: TranslatedAction[]; dropped: DroppedStatement[] }
  | { ok: false; reason: string; statement: string };

/** A statement deliberately not translated, with why. Surfaced rather than silently discarded. */
export interface DroppedStatement {
  statement: string;
  why: string;
}

export interface TranslateOptions {
  /**
   * Credential values the operator supplied, mapped to the environment variable NAME that holds
   * them. A `fill` whose value matches one is emitted as a `secretRef` carrying the name, so the
   * secret itself never reaches a persisted proposal. This is also why the translator needs the
   * values at all: it is the only point that can tell `TestPass123` the literal apart from
   * `TestPass123` the password, and `action.v1` rejects a literal that looks like a credential.
   */
  secretsByValue?: ReadonlyMap<string, string>;
}

// ---------------------------------------------------------------------------
// Scanning
// ---------------------------------------------------------------------------

type Token =
  | { kind: "id"; value: string }
  | { kind: "str"; value: string }
  | { kind: "num"; value: number }
  | { kind: "punct"; value: string };

/**
 * Strip `//` line comments that are not inside a string.
 *
 * Playwright MCP prefixes its screenshot statements with a comment naming the absolute path it
 * wrote to. Those paths point inside the session workspace, so carrying them into a proposal
 * would put machine-local paths into a persisted, content-hashed artifact.
 */
function stripLineComments(src: string): string {
  let out = "";
  let quote: string | null = null;
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (quote) {
      out += c;
      if (c === "\\") {
        if (i + 1 < src.length) out += src[++i]!;
        continue;
      }
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === "`") {
      quote = c;
      out += c;
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      out += "\n";
      continue;
    }
    out += c;
  }
  return out;
}

/** Split on top-level `;`, ignoring separators inside strings or brackets. */
function splitStatements(src: string): string[] {
  const out: string[] = [];
  let buf = "";
  let quote: string | null = null;
  let depth = 0;
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (quote) {
      buf += c;
      if (c === "\\") {
        if (i + 1 < src.length) buf += src[++i]!;
        continue;
      }
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === "`") {
      quote = c;
      buf += c;
      continue;
    }
    if (c === "(" || c === "[" || c === "{") depth++;
    if (c === ")" || c === "]" || c === "}") depth--;
    if (c === ";" && depth === 0) {
      // The terminator is kept. `TranslatedAction.statement` is shown to whoever reviews the
      // proposal at the gate, and a statement displayed without its `;` reads as truncated.
      out.push(buf.trim() + ";");
      buf = "";
      continue;
    }
    buf += c;
  }
  if (buf.trim()) out.push(buf.trim());
  return out.filter((s) => s.length > 0);
}

function tokenize(src: string): Token[] | null {
  const tokens: Token[] = [];
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (/\s/.test(c)) continue;
    if (c === "'" || c === '"' || c === "`") {
      const quote = c;
      let value = "";
      i++;
      let closed = false;
      for (; i < src.length; i++) {
        const d = src[i]!;
        if (d === "\\") {
          const next = src[++i];
          if (next === undefined) return null;
          value += next === "n" ? "\n" : next === "t" ? "\t" : next;
          continue;
        }
        if (d === quote) {
          closed = true;
          break;
        }
        value += d;
      }
      if (!closed) return null;
      tokens.push({ kind: "str", value });
      continue;
    }
    if (/[0-9]/.test(c)) {
      let value = "";
      while (i < src.length && /[0-9._]/.test(src[i]!)) value += src[i++]!;
      i--;
      const n = Number(value.replace(/_/g, ""));
      if (!Number.isFinite(n)) return null;
      tokens.push({ kind: "num", value: n });
      continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      let value = "";
      while (i < src.length && /[A-Za-z0-9_$]/.test(src[i]!)) value += src[i++]!;
      i--;
      tokens.push({ kind: "id", value });
      continue;
    }
    if (src.startsWith("=>", i)) {
      tokens.push({ kind: "punct", value: "=>" });
      i++;
      continue;
    }
    tokens.push({ kind: "punct", value: c });
  }
  return tokens;
}

// ---------------------------------------------------------------------------
// Parsing a chain
// ---------------------------------------------------------------------------

interface CallSegment {
  name: string;
  args: ArgValue[];
}

type ArgValue =
  | { kind: "string"; value: string }
  | { kind: "number"; value: number }
  | { kind: "object"; value: Record<string, ArgValue> }
  | { kind: "other" };

class Cursor {
  private i = 0;
  constructor(private readonly tokens: readonly Token[]) {}
  peek(): Token | undefined {
    return this.tokens[this.i];
  }
  next(): Token | undefined {
    return this.tokens[this.i++];
  }
  eatPunct(v: string): boolean {
    const t = this.peek();
    if (t && t.kind === "punct" && t.value === v) {
      this.i++;
      return true;
    }
    return false;
  }
  eatId(v: string): boolean {
    const t = this.peek();
    if (t && t.kind === "id" && t.value === v) {
      this.i++;
      return true;
    }
    return false;
  }
  done(): boolean {
    return this.i >= this.tokens.length;
  }
}

function parseArgs(c: Cursor): ArgValue[] | null {
  if (!c.eatPunct("(")) return null;
  const args: ArgValue[] = [];
  if (c.eatPunct(")")) return args;
  for (;;) {
    const v = parseValue(c);
    if (!v) return null;
    args.push(v);
    if (c.eatPunct(",")) {
      // A trailing comma before `)` is legal and carries no argument.
      if (c.eatPunct(")")) return args;
      continue;
    }
    if (c.eatPunct(")")) return args;
    return null;
  }
}

function parseValue(c: Cursor): ArgValue | null {
  const t = c.peek();
  if (!t) return null;
  if (t.kind === "str") {
    c.next();
    return { kind: "string", value: t.value };
  }
  if (t.kind === "num") {
    c.next();
    return { kind: "number", value: t.value };
  }
  if (t.kind === "id" && (t.value === "true" || t.value === "false")) {
    c.next();
    return { kind: "other" };
  }
  if (t.kind === "punct" && t.value === "{") {
    c.next();
    const obj: Record<string, ArgValue> = {};
    if (c.eatPunct("}")) return { kind: "object", value: obj };
    for (;;) {
      const k = c.next();
      if (!k || (k.kind !== "id" && k.kind !== "str")) return null;
      if (!c.eatPunct(":")) return null;
      const boolTok = c.peek();
      let v: ArgValue | null;
      if (
        boolTok &&
        boolTok.kind === "id" &&
        (boolTok.value === "true" || boolTok.value === "false")
      ) {
        c.next();
        v = { kind: "string", value: boolTok.value };
      } else {
        v = parseValue(c);
      }
      if (!v) return null;
      obj[String(k.value)] = v;
      if (c.eatPunct(",")) {
        if (c.eatPunct("}")) return { kind: "object", value: obj };
        continue;
      }
      if (c.eatPunct("}")) return { kind: "object", value: obj };
      return null;
    }
  }
  // Anything else (identifier, arrow function, arithmetic) is not a value this grammar models.
  return null;
}

/** `await page.a(...).b(...)` -> the ordered segments, or null when the shape does not match. */
function parseChain(statement: string): CallSegment[] | null {
  const tokens = tokenize(statement);
  if (!tokens) return null;
  const c = new Cursor(tokens);
  if (!c.eatId("await")) return null;
  if (!c.eatId("page")) return null;
  const segments: CallSegment[] = [];
  while (c.eatPunct(".")) {
    const name = c.next();
    if (!name || name.kind !== "id") return null;
    const args = parseArgs(c);
    if (!args) return null;
    segments.push({ name: name.value, args });
  }
  c.eatPunct(";");
  if (!c.done()) return null;
  return segments.length > 0 ? segments : null;
}

// ---------------------------------------------------------------------------
// Mapping to the closed vocabulary
// ---------------------------------------------------------------------------

const FACTORY_STRATEGY: Record<string, SelectorSpec["strategy"]> = {
  getByTestId: "testid",
  getByRole: "role",
  getByLabel: "label",
  getByPlaceholder: "placeholder",
  getByText: "text",
  locator: "css",
};

function str(a: ArgValue | undefined): string | null {
  return a && a.kind === "string" ? a.value : null;
}

function selectorFromFactory(seg: CallSegment): SelectorSpec | null {
  const strategy = FACTORY_STRATEGY[seg.name];
  if (!strategy) return null;
  const first = str(seg.args[0]);
  if (first === null) return null;

  const opts = seg.args[1];
  const optObj = opts && opts.kind === "object" ? opts.value : undefined;
  const exactRaw = optObj?.["exact"];
  const exact =
    exactRaw &&
    exactRaw.kind === "string" &&
    (exactRaw.value === "true" || exactRaw.value === "false")
      ? exactRaw.value === "true"
      : undefined;

  if (strategy === "role") {
    const nameRaw = optObj?.["name"];
    const name = nameRaw && nameRaw.kind === "string" ? nameRaw.value : undefined;
    // `name` is the only role option modelled. An unmodelled option (`checked`, `level`,
    // `pressed`) changes which element matches, so accepting it silently would be a
    // mistranslation of exactly the kind this module exists to prevent.
    for (const key of Object.keys(optObj ?? {})) {
      if (key !== "name" && key !== "exact") return null;
    }
    return {
      strategy: "role",
      role: first,
      ...(name !== undefined ? { name } : {}),
      ...(exact !== undefined ? { exact } : {}),
    };
  }

  if (optObj) {
    for (const key of Object.keys(optObj)) {
      if (key !== "exact") return null;
    }
  }
  return {
    strategy,
    value: first,
    ...(exact !== undefined ? { exact } : {}),
  };
}

/** Apply `.filter(...)` / `.nth(...)` onto a selector, in Playwright's own order. */
function applyModifier(sel: SelectorSpec, seg: CallSegment): SelectorSpec | null {
  if (seg.name === "filter") {
    const arg = seg.args[0];
    if (!arg || arg.kind !== "object") return null;
    const keys = Object.keys(arg.value);
    if (keys.length === 0) return null;
    const out: SelectorSpec = { ...sel };
    for (const k of keys) {
      const v = str(arg.value[k]);
      if (v === null) return null;
      if (k === "hasText") out.filterHasText = v;
      else if (k === "hasNotText") out.filterHasNotText = v;
      // `has:`/`hasNot:` take a Locator, not text. There is no way to carry a nested locator in
      // the selector vocabulary, so it is refused rather than approximated.
      else return null;
    }
    return out;
  }
  if (seg.name === "nth") {
    const arg = seg.args[0];
    if (!arg || arg.kind !== "number" || !Number.isInteger(arg.value) || arg.value < 0) return null;
    return { ...sel, nth: arg.value };
  }
  return null;
}

function actionId(index: number): string {
  return `A${index}`;
}

function valueFor(raw: string, opts: TranslateOptions): TestDataValue {
  const envVar = opts.secretsByValue?.get(raw);
  if (envVar) return { kind: "secretRef", envVar };
  return { kind: "literal", literal: raw };
}

interface MappedAction {
  action: Omit<ActionSpec, "actionId">;
}

/** The verb at the end of the chain, given the selector the earlier segments built. */
function actionForVerb(
  verb: CallSegment,
  selector: SelectorSpec | null,
  opts: TranslateOptions
): MappedAction | null {
  const withSel = <T extends object>(extra: T) => (selector ? { selector, ...extra } : null);

  switch (verb.name) {
    case "goto": {
      const url = str(verb.args[0]);
      if (url === null || selector) return null;
      return { action: { type: "goto", url } as unknown as Omit<ActionSpec, "actionId"> };
    }
    case "reload":
    case "goBack":
    case "goForward": {
      if (verb.args.length > 0 || selector) return null;
      return { action: { type: verb.name } as unknown as Omit<ActionSpec, "actionId"> };
    }
    case "click":
    case "dblclick":
    case "hover":
    case "check":
    case "uncheck": {
      if (verb.args.length > 0) return null;
      const a = withSel({ type: verb.name });
      return a ? { action: a as unknown as Omit<ActionSpec, "actionId"> } : null;
    }
    case "fill": {
      const v = str(verb.args[0]);
      if (v === null || verb.args.length !== 1) return null;
      const a = withSel({ type: "fill", value: valueFor(v, opts) });
      return a ? { action: a as unknown as Omit<ActionSpec, "actionId"> } : null;
    }
    case "selectOption": {
      const v = str(verb.args[0]);
      if (v === null || verb.args.length !== 1) return null;
      const a = withSel({ type: "select", option: v });
      return a ? { action: a as unknown as Omit<ActionSpec, "actionId"> } : null;
    }
    case "press": {
      const key = str(verb.args[0]);
      if (key === null || verb.args.length !== 1) return null;
      const a = withSel({ type: "press", key });
      return a ? { action: a as unknown as Omit<ActionSpec, "actionId"> } : null;
    }
    case "waitFor": {
      const arg = verb.args[0];
      if (!arg || arg.kind !== "object" || !selector) return null;
      const keys = Object.keys(arg.value);
      if (keys.length !== 1 || keys[0] !== "state") return null;
      const state = str(arg.value["state"]);
      const condition =
        state === "visible"
          ? "selectorVisible"
          : state === "hidden"
            ? "selectorHidden"
            : state === "attached"
              ? "selectorAttached"
              : state === "detached"
                ? "selectorDetached"
                : null;
      if (!condition) return null;
      return {
        action: { type: "waitFor", condition, selector } as unknown as Omit<ActionSpec, "actionId">,
      };
    }
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Rendering back, for the round trip
// ---------------------------------------------------------------------------

function q(s: string): string {
  return `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\n/g, "\\n")}'`;
}

function renderSelector(sel: SelectorSpec): string {
  let out: string;
  switch (sel.strategy) {
    case "role": {
      const opts: string[] = [];
      if (sel.name !== undefined) opts.push(`name: ${q(sel.name)}`);
      if (sel.exact !== undefined) opts.push(`exact: ${String(sel.exact)}`);
      out = `getByRole(${q(sel.role ?? "")}${opts.length ? `, { ${opts.join(", ")} }` : ""})`;
      break;
    }
    case "testid":
      out = `getByTestId(${q(sel.value ?? "")})`;
      break;
    case "label":
    case "placeholder":
    case "text": {
      const fn =
        sel.strategy === "label"
          ? "getByLabel"
          : sel.strategy === "placeholder"
            ? "getByPlaceholder"
            : "getByText";
      out = `${fn}(${q(sel.value ?? "")}${sel.exact !== undefined ? `, { exact: ${String(sel.exact)} }` : ""})`;
      break;
    }
    case "css":
      out = `locator(${q(sel.value ?? "")})`;
      break;
    default:
      // `xpath` and `described` are never produced by this translator: MCP does not emit them,
      // and inventing one would be a guess about an element nobody pointed at.
      return "";
  }
  const filters: string[] = [];
  if (sel.filterHasText !== undefined) filters.push(`hasText: ${q(sel.filterHasText)}`);
  if (sel.filterHasNotText !== undefined) filters.push(`hasNotText: ${q(sel.filterHasNotText)}`);
  if (filters.length) out += `.filter({ ${filters.join(", ")} })`;
  if (sel.nth !== undefined) out += `.nth(${sel.nth})`;
  return out;
}

/**
 * Render an action back into the Playwright statement it came from.
 *
 * This is the other half of the round trip. It is deliberately a separate function from the
 * parser rather than the parser run backwards, so that a bug in one does not cancel out in the
 * other and produce a false match.
 */
export function renderActionStatement(action: ActionSpec): string {
  const a = action as unknown as Record<string, unknown>;
  const sel = a["selector"] as SelectorSpec | undefined;
  const base = sel ? `await page.${renderSelector(sel)}` : "await page";
  switch (action.type) {
    case "goto":
      return `${base}.goto(${q(String(a["url"] ?? ""))});`;
    case "reload":
    case "goBack":
    case "goForward":
      return `${base}.${action.type}();`;
    case "click":
    case "dblclick":
    case "hover":
    case "check":
    case "uncheck":
      return `${base}.${action.type}();`;
    case "fill": {
      const v = a["value"] as TestDataValue | undefined;
      const literal =
        v && v.kind === "literal" ? v.literal : v && v.kind === "secretRef" ? SECRET_SENTINEL : "";
      return `${base}.fill(${q(literal)});`;
    }
    case "select":
      return `${base}.selectOption(${q(String(a["option"] ?? ""))});`;
    case "press":
      return `${base}.press(${q(String(a["key"] ?? ""))});`;
    case "waitFor": {
      const cond = String(a["condition"] ?? "");
      const state =
        cond === "selectorVisible"
          ? "visible"
          : cond === "selectorHidden"
            ? "hidden"
            : cond === "selectorAttached"
              ? "attached"
              : "detached";
      return `${base}.waitFor({ state: ${q(state)} });`;
    }
    case "waitForTimeout":
      return `await page.waitForTimeout(${String(a["ms"] ?? 0)});`;
    default:
      return "";
  }
}

/**
 * Stands in for a secret during the round trip.
 *
 * A `fill` whose value was recognised as a supplied credential becomes a `secretRef`, which by
 * design no longer carries the value — so rendering it back can never reproduce the original
 * statement. Comparing both sides with the same sentinel checks everything else about the
 * statement (selector, verb, shape) while leaving the redaction itself out of the comparison,
 * which is the one difference that is supposed to be there.
 */
const SECRET_SENTINEL = " secret ";

function normalizeForCompare(statement: string, opts: TranslateOptions): string {
  let s = statement;
  for (const value of opts.secretsByValue?.keys() ?? []) {
    if (value.length > 0) s = s.split(value).join(SECRET_SENTINEL);
  }
  // Quote style, inter-token spacing and the statement terminator are not semantic; the
  // tokenizer already read through them, and `splitStatements` consumes the `;` it splits on
  // while the renderer emits a complete statement. Normalizing both sides the same way keeps
  // the comparison about meaning rather than punctuation.
  return s.replace(/\s+/g, " ").replace(/"/g, "'").trim().replace(/;$/, "").trim();
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * The statement as it is safe to persist: every supplied credential value replaced by the NAME
 * of the variable holding it.
 *
 * Without this the action would correctly carry a `secretRef` while the audit trail beside it
 * still spelled the password out — the proposal is written to disk, content-hashed, and read
 * back at the approval gate, so a secret in that string is a secret at rest.
 */
function redactStatement(statement: string, opts: TranslateOptions): string {
  let out = statement;
  for (const [value, envVar] of opts.secretsByValue ?? new Map<string, string>()) {
    if (value.length > 0) out = out.split(value).join(`<${envVar}>`);
  }
  return out;
}

/** Statements that are MCP's own bookkeeping rather than part of the reproduced flow. */
function droppedReason(statement: string, segments: CallSegment[] | null): string | null {
  if (segments && segments.length === 1 && segments[0]!.name === "screenshot") {
    return "a screenshot the authoring tool took for its own transcript; the measured run captures evidence under its own policy";
  }
  if (/^\s*$/.test(statement)) return "blank";
  return null;
}

/**
 * Translate an authoring session's statements into executable actions, or refuse.
 *
 * The round trip is the guarantee. Every action produced is rendered back into a statement and
 * compared with the one it came from; a mismatch refuses the whole translation rather than the
 * offending step, because a proposal missing one step in the middle is not a smaller version of
 * the flow, it is a different flow.
 */
export function translateAuthoredSteps(
  statements: readonly string[],
  opts: TranslateOptions = {}
): TranslationResult {
  const actions: TranslatedAction[] = [];
  const dropped: DroppedStatement[] = [];
  // Local, not module-level: two translations running in one process must not share a counter,
  // and action ids are part of what gets hashed into an approval.
  let nextActionNumber = 0;

  for (const raw of statements) {
    for (const statement of splitStatements(stripLineComments(raw))) {
      const segments = parseChain(statement);

      const drop = droppedReason(statement, segments);
      if (drop) {
        if (drop !== "blank") dropped.push({ statement, why: drop });
        continue;
      }

      // The sleep idiom MCP emits for `browser_wait_for` with `time`. It is not a page call, so
      // it never parses as a chain, but it IS in the vocabulary as `waitForTimeout`.
      const sleep =
        /^await\s+new\s+Promise\(\s*\w+\s*=>\s*setTimeout\(\s*\w+\s*,\s*([0-9*\s.]+)\)\s*\);?$/.exec(
          statement
        );
      if (sleep) {
        const ms = evalMsExpression(sleep[1]!);
        if (ms === null) {
          return {
            ok: false,
            reason: "a sleep whose duration is not a constant",
            statement: redactStatement(statement, opts),
          };
        }
        const action = {
          actionId: actionId(nextActionNumber++),
          type: "waitForTimeout",
          ms,
        } as unknown as ActionSpec;
        actions.push({ action, statement: redactStatement(statement, opts) });
        continue;
      }

      if (!segments) {
        return {
          ok: false,
          reason:
            "this is not a form the action vocabulary models. Only `await page.<locator>.<verb>(...)` chains and the sleep idiom are understood",
          statement: redactStatement(statement, opts),
        };
      }

      const verb = segments[segments.length - 1]!;
      let selector: SelectorSpec | null = null;
      if (segments.length > 1) {
        const built = selectorFromFactory(segments[0]!);
        if (!built) {
          return {
            ok: false,
            reason: `\`${segments[0]!.name}\` is not a selector strategy this vocabulary declares, or it carried an option that changes which element matches`,
            statement: redactStatement(statement, opts),
          };
        }
        selector = built;
        for (const seg of segments.slice(1, -1)) {
          const next = applyModifier(selector, seg);
          if (!next) {
            return {
              ok: false,
              reason: `\`.${seg.name}(...)\` cannot be expressed as a selector, so the element it picks cannot be reproduced exactly`,
              statement,
            };
          }
          selector = next;
        }
      }

      const mapped = actionForVerb(verb, selector, opts);
      if (!mapped) {
        return {
          ok: false,
          reason: `\`.${verb.name}(...)\` is not an action this vocabulary declares, or its arguments are not constants`,
          statement: redactStatement(statement, opts),
        };
      }

      const action = {
        actionId: actionId(nextActionNumber++),
        ...mapped.action,
      } as unknown as ActionSpec;

      const rendered = renderActionStatement(action);
      if (normalizeForCompare(rendered, opts) !== normalizeForCompare(statement, opts)) {
        return {
          ok: false,
          reason: `translation did not round-trip. It became \`${rendered}\`, which is not the same statement, so measuring it would measure a different flow than the one approved`,
          statement: redactStatement(statement, opts),
        };
      }

      actions.push({ action, statement: redactStatement(statement, opts) });
    }
  }

  if (actions.length === 0) {
    return {
      ok: false,
      reason: "no executable statement survived translation",
      statement: "",
    };
  }
  return { ok: true, actions, dropped };
}

/** `3 * 1000` and `2500` are constants; anything with an identifier in it is not. */
function evalMsExpression(src: string): number | null {
  const parts = src.split("*").map((p) => p.trim());
  let total = 1;
  for (const p of parts) {
    if (!/^[0-9]+(\.[0-9]+)?$/.test(p)) return null;
    total *= Number(p);
  }
  return Number.isFinite(total) && total >= 0 ? Math.round(total) : null;
}
