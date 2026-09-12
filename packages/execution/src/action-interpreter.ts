import type { Locator, Page } from "playwright";
import type { Rng } from "@investigator/core";
import { InvestigatorError, fail } from "@investigator/core";
import {
  canonicalSelector,
  canonicalizeDom,
  countDomNodes,
  domStructureHash,
  type AssertionOutcome,
  type DomNode,
} from "@investigator/evidence";
import type { Collector } from "./collector.js";
import { isOriginAllowed } from "./destructive-classifier.js";
import type { Redactor } from "@investigator/evidence";
import type {
  ActionSpec,
  AssertionSpec,
  DeclaredFactor,
  SelectorSpec,
  TestDataValue,
} from "./types.js";

/**
 * Deterministic action interpreter (ADR-0006).
 *
 * Executes a CLOSED vocabulary. No `eval`, no shell, and no `page.evaluate` with model-supplied
 * source. The two `page.evaluate` calls here run FIXED literal functions declared in this file;
 * neither takes source from any input.
 */

export interface InterpreterOptions {
  page: Page;
  collector: Collector;
  /** DOM snapshots carry page-authored text and must be redacted before persistence. */
  redactor: Redactor;
  rng: Rng;
  defaultTimeoutMs: number;
  allowedOrigins: readonly string[];
  baseUrl: string;
  domSnapshotOn: ReadonlyArray<"action" | "navigation" | "failure">;
  screenshotOn: ReadonlyArray<"action" | "navigation" | "failure">;
  domSnapshotMaxBytes: number;
  resolveUnknown?: (unknownId: string) => string | undefined;
  resolveSecret?: (envVar: string) => string | undefined;
  onScreenshot?: (bytes: Buffer, label: string) => Promise<string | undefined>;
  onDomSnapshot?: (json: string, label: string) => Promise<string | undefined>;
}

export interface InterpreterResult {
  assertionOutcomes: AssertionOutcome[];
  declaredFactors: DeclaredFactor[];
  automationFailure: { reason: string; actionId?: string } | null;
  actionsExecuted: number;
  snapshotSeqToArtifact: Map<number, string[]>;
}

/**
 * Words that name what KIND of control the reporter meant, mapped to an ARIA role.
 *
 * "the delete button" and "the phone field" each name a role and a label, in the order English
 * puts them. Reading that is not guessing; it is the reading a person does.
 */
const ROLE_NOUNS: ReadonlyArray<[RegExp, string]> = [
  [/\bbuttons?\b/i, "button"],
  [/\blinks?\b/i, "link"],
  [/\bcheck\s?box(es)?\b/i, "checkbox"],
  [/\bradio\b/i, "radio"],
  [/\btabs?\b/i, "tab"],
  [/\bmenus?\b/i, "menu"],
  [/\b(fields?|inputs?|text\s?box(es)?|boxes|box)\b/i, "textbox"],
  [/\bdrop\s?downs?\b|\bselects?\b/i, "combobox"],
  [/\bheadings?\b|\btitles?\b/i, "heading"],
  [/\bimages?\b|\bicons?\b/i, "img"],
];

/** Filler that carries no identifying information. Removing it widens a match, never narrows it. */
const FILLER =
  /\b(the|a|an|then|please|click|clicks|clicking|press|presses|pressing|tap|taps|type|types|typing|into|on|in|at|for|to|its|my|their|this|that|control|element|option|item|labelled|labeled|called|named)\b/gi;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface DescribedResolution {
  /** The ARIA role read out of the phrase, if it named one. */
  role: string | null;
  /** The identifying words, with filler and the role noun removed. */
  name: string;
}

/**
 * Read a reporter's phrase into a role and a name, deterministically.
 *
 * Exported so it can be tested directly: this is the one place where prose becomes something that
 * touches a real page, and the mapping must be inspectable rather than buried in a locator chain.
 */
export function readDescribedSelector(phrase: string): DescribedResolution {
  const raw = (phrase ?? "").trim();
  let role: string | null = null;
  let rest = raw;

  for (const [pattern, mapped] of ROLE_NOUNS) {
    if (pattern.test(rest)) {
      role = mapped;
      rest = rest.replace(pattern, " ");
      break;
    }
  }

  const name = rest.replace(FILLER, " ").replace(/\s+/g, " ").trim();
  // If stripping left nothing the phrase was all filler and role noun ("the button"), and the
  // role is then the only information there is.
  return { role, name };
}

/**
 * Locate a control the reporter described in their own words.
 *
 * This was a hard refusal, on the reasoning that treating a phrase as a selector would sometimes
 * work and that was the danger: the run would pass or fail for reasons nobody chose.
 *
 * The reasoning was wrong about where the risk sits. A person handed "click the delete button"
 * finds it by reading the page, and so does Playwright — role and accessible name are not a guess,
 * they are the same information a user acts on. What made the refusal feel safe was not that it
 * avoided a wrong click but that it avoided ALL clicks, which is not a safety property. An
 * investigator that stops at every control it was not handed a CSS selector for cannot
 * investigate anything a reporter described in words, which is every real bug report.
 *
 * What is kept is the part that actually mattered: `describedResolutionFactor` records what the
 * phrase resolved to as a declared factor on the run, so a human reading the evidence sees that
 * the click came from prose and what it matched. Visible rather than silent is the property the
 * refusal was really protecting.
 *
 * Candidates form one `or` chain in a fixed order, most specific first, so the same page and the
 * same phrase always produce the same element.
 */
function describedLocator(page: Page, phrase: string): Locator {
  const { role, name } = readDescribedSelector(phrase);
  const needle = name.length > 0 ? new RegExp(escapeRegExp(name), "i") : /./;

  const candidates: Locator[] = [];
  if (role) {
    candidates.push(page.getByRole(role as Parameters<Page["getByRole"]>[0], { name: needle }));
  }
  if (name.length > 0) {
    candidates.push(page.getByLabel(needle));
    candidates.push(page.getByPlaceholder(needle));
    candidates.push(page.getByRole("button", { name: needle }));
    candidates.push(page.getByRole("link", { name: needle }));
    candidates.push(page.locator(`[aria-label*="${name.replace(/"/g, '\\"')}" i]`));
    candidates.push(page.getByText(needle));
  }
  if (candidates.length === 0) {
    // Nothing identifying at all. Refusing is right here: no reading of "" names a control, and
    // clicking the first thing on the page would be an invention rather than an interpretation.
    fail("EXEC_VALUE_UNRESOLVED", `Described selector carries no identifying words ("${phrase}")`, {
      context: { described: phrase },
    });
  }

  let locator = candidates[0]!;
  for (const next of candidates.slice(1)) locator = locator.or(next);
  return locator;
}

/** What a described phrase resolved to, for the run manifest. */
export function describedResolutionFactor(phrase: string): string {
  const { role, name } = readDescribedSelector(phrase);
  return `"${phrase}" -> ${role ? `role=${role}` : "any role"}, name~="${name}"`;
}

function locatorFor(page: Page, sel: SelectorSpec): Locator {
  if (sel.strategy === "described") return describedLocator(page, sel.value ?? "");
  switch (sel.strategy) {
    case "testid":
      return page.getByTestId(sel.value ?? "");
    case "role":
      return page.getByRole((sel.role ?? "button") as Parameters<Page["getByRole"]>[0], {
        ...(sel.name !== undefined ? { name: sel.name } : {}),
        ...(sel.exact !== undefined ? { exact: sel.exact } : {}),
      });
    case "label":
      return page.getByLabel(sel.value ?? "", sel.exact !== undefined ? { exact: sel.exact } : {});
    case "placeholder":
      return page.getByPlaceholder(
        sel.value ?? "",
        sel.exact !== undefined ? { exact: sel.exact } : {}
      );
    case "text":
      return page.getByText(sel.value ?? "", sel.exact !== undefined ? { exact: sel.exact } : {});
    case "css":
      return page.locator(sel.value ?? "");
    case "xpath":
      return page.locator(`xpath=${sel.value ?? ""}`);
  }
}

function resolveLocator(page: Page, sel: SelectorSpec): Locator {
  const base = locatorFor(page, sel);
  if (sel.nth !== undefined) return base.nth(sel.nth);
  // A described phrase can legitimately match more than one element — "Delete" on a row button
  // and again in the confirmation dialog. Taking the first in DOM order is what a person clicking
  // the thing in front of them does, and it is deterministic. Explicit strategies keep
  // Playwright's strict mode, where an ambiguous selector the model DID choose is a real error.
  return sel.strategy === "described" ? base.first() : base;
}

/**
 * Test data resolution. The model may never invent a value: literals are used as written,
 * generators are a closed set seeded from the run seed, secretRefs resolve through SecretStore,
 * and an unresolved `unknown` refuses to run rather than guessing.
 */
function resolveValue(
  value: TestDataValue | undefined,
  opts: InterpreterOptions,
  actionId: string
): string {
  if (!value) return "";
  switch (value.kind) {
    case "literal":
      return value.literal;
    case "generated": {
      const n = opts.rng.nextInt(100000, 999999);
      switch (value.generator) {
        case "seededEmail":
          return `user+${n}@example.invalid`;
        case "seededUsername":
          return `user_${n}`;
        case "seededNumber":
          return String(n);
        case "seededUuid":
          return `${opts.rng.nextHex(8)}-${opts.rng.nextHex(4)}-${opts.rng.nextHex(4)}-${opts.rng.nextHex(4)}-${opts.rng.nextHex(12)}`;
        case "seededString":
          return opts.rng.nextHex(12);
        default:
          return fail("EXEC_ACTION_FAILED", "Unknown test-data generator", {
            context: { actionId, generator: value.generator },
          });
      }
    }
    case "secretRef": {
      const plain = opts.resolveSecret?.(value.envVar);
      if (plain === undefined) {
        return fail("EXEC_ACTION_FAILED", "Referenced secret is not available", {
          context: { actionId, variable: value.envVar },
        });
      }
      return plain;
    }
    case "unknown": {
      const filled = opts.resolveUnknown?.(value.unknownId);
      if (filled === undefined) {
        return fail("EXEC_ACTION_FAILED", "Action references an unresolved flow unknown", {
          context: { actionId, unknownId: value.unknownId },
        });
      }
      return filled;
    }
  }
}

/**
 * Transport-layer failures, as distinct from anything the page did. Matching these before the
 * first successful navigation is what separates rule 2 from rule 3.
 */
const TRANSPORT_ERROR =
  /net::ERR_|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|ERR_EMPTY_RESPONSE|ERR_CONNECTION|ERR_SOCKET|ERR_ADDRESS|ERR_NAME_NOT_RESOLVED|socket hang up|Connection closed/i;

/** FIXED in-page storage reader. Literal source, no parameters. */
const STORAGE_READER = (): {
  local: Array<{ k: string; v: string }>;
  session: Array<{ k: string; v: string }>;
} => {
  const dump = (store: Storage): Array<{ k: string; v: string }> => {
    const out: Array<{ k: string; v: string }> = [];
    for (let i = 0; i < store.length; i++) {
      const k = store.key(i);
      if (k !== null) out.push({ k, v: store.getItem(k) ?? "" });
    }
    return out;
  };
  return { local: dump(window.localStorage), session: dump(window.sessionStorage) };
};

/** FIXED in-page serialiser. Source is literal; nothing about it is parameterised by input. */
const DOM_SERIALIZER = (): string => {
  const walk = (node: Element): unknown => {
    const attrs: Record<string, string> = {};
    for (const a of Array.from(node.attributes)) attrs[a.name] = a.value;
    const children: unknown[] = [];
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === 1) children.push(walk(child as Element));
      else if (child.nodeType === 3) {
        const text = (child.textContent ?? "").trim();
        if (text) children.push({ tag: "#text", text });
      }
    }
    return {
      tag: node.tagName.toLowerCase(),
      ...(Object.keys(attrs).length ? { attrs } : {}),
      ...(children.length ? { children } : {}),
    };
  };
  return JSON.stringify(walk(document.documentElement));
};

/**
 * Redact a canonicalised DOM tree in place-by-copy.
 *
 * Without this a snapshot is persisted under a RedactionStamp that claims redaction ran when it
 * did not — the exact false-assurance failure ADR-0008 exists to prevent. Script and style text
 * is dropped outright: it is page source, never evidence about product behaviour, and it is the
 * most likely place for an inline credential to sit.
 */
function redactDomTree(node: DomNode, redactor: Redactor): DomNode {
  const out: DomNode = { tag: node.tag };

  if (node.attrs) {
    const attrs: Record<string, string> = {};
    for (const [k, v] of Object.entries(node.attrs)) {
      const outcome = redactor.redactField("dom.attributes", v, { key: k });
      attrs[k] = outcome.value ?? "[redacted]";
    }
    out.attrs = attrs;
  }

  if (node.text !== undefined) {
    const outcome = redactor.redactField("dom.text", node.text);
    if (outcome.value !== undefined) out.text = outcome.value;
  }

  if (node.children?.length) {
    const kids: DomNode[] = [];
    for (const child of node.children) {
      // Script and style bodies are source, not evidence. Keep the element, drop the body.
      if (child.tag === "script" || child.tag === "style") {
        kids.push({ tag: child.tag, ...(child.attrs ? { attrs: child.attrs } : {}) });
        continue;
      }
      kids.push(redactDomTree(child, redactor));
    }
    out.children = kids;
  }

  return out;
}

export class ActionInterpreter {
  private readonly assertionOutcomes: AssertionOutcome[] = [];
  private readonly declaredFactors: DeclaredFactor[] = [];
  private readonly snapshotSeqToArtifact = new Map<number, string[]>();
  private snapshotCounter = 0;
  private actionsExecuted = 0;
  /** Rule 2 vs rule 3 turns on whether the target was ever reachable. */
  private navigatedSuccessfully = false;

  constructor(private readonly opts: InterpreterOptions) {}

  async run(
    actions: readonly ActionSpec[],
    assertions: readonly AssertionSpec[]
  ): Promise<InterpreterResult> {
    const inlineIds = new Set(
      actions.filter((a) => a.type === "assert" && a.assertion).map((a) => a.assertion!.assertionId)
    );

    for (const action of actions) {
      const canonical = action.selector ? canonicalSelector(action.selector) : null;

      // A click that came from the reporter's prose is recorded as a declared factor.
      //
      // This is the condition on which the `described` refusal was removed: the resolution is
      // visible in the evidence rather than silent, so a human reading a manifest can see that
      // the element was found by role and accessible name from a phrase, and which phrase. It is
      // declared BEFORE the action runs, so it is present even when the action then fails.
      if (action.selector?.strategy === "described") {
        this.declaredFactors.push({
          kind: "describedSelectorResolved",
          value: describedResolutionFactor(action.selector.value ?? ""),
          actionId: action.actionId,
        });
      }

      this.opts.collector.actionStart(action.actionId, action.type, canonical);
      try {
        await this.execute(action);
        this.actionsExecuted++;
        this.opts.collector.actionEnd(action.actionId, action.type, "ok", null);
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        const isTimeout = /Timeout|timed out/i.test(reason);
        this.opts.collector.actionEnd(
          action.actionId,
          action.type,
          isTimeout ? "timeout" : "failed",
          reason
        );
        await this.captureOnFailure(action.actionId);

        // An infrastructure-class error propagates so the worker can classify it by rule 2.
        // Everything else is an automation failure by rule 3: our instructions did not work
        // against the application, which is never reported as a product defect.
        const code = e instanceof InvestigatorError ? e.code : null;
        if (code === "EXEC_TARGET_UNREACHABLE" || code === "EXEC_BROWSER_LAUNCH_FAILED") throw e;

        for (const a of assertions) {
          if (!this.assertionOutcomes.some((o) => o.assertionId === a.assertionId)) {
            this.assertionOutcomes.push({
              assertionId: a.assertionId,
              actionId: null,
              result: "not-evaluated",
              isFailurePredicate: a.isFailurePredicate === true,
              detail: "run stopped before this assertion was evaluated",
            });
          }
        }
        // Capture storage even on the failure path: a failed run's client state is evidence,
        // and losing it silently would make the run less diagnosable than it needs to be.
        await this.captureStorage();

        return {
          assertionOutcomes: this.assertionOutcomes,
          declaredFactors: this.declaredFactors,
          automationFailure: { reason: reason.slice(0, 300), actionId: action.actionId },
          actionsExecuted: this.actionsExecuted,
          snapshotSeqToArtifact: this.snapshotSeqToArtifact,
        };
      }

      if (this.opts.domSnapshotOn.includes("action")) await this.captureDomSnapshot("action");
      if (this.opts.screenshotOn.includes("action"))
        await this.captureScreenshot(`action-${action.actionId}`);
    }

    for (const a of assertions) {
      if (inlineIds.has(a.assertionId)) continue;
      if (this.assertionOutcomes.some((o) => o.assertionId === a.assertionId)) continue;
      await this.evaluateAssertion(a, null);
    }

    await this.captureStorage();

    return {
      assertionOutcomes: this.assertionOutcomes,
      declaredFactors: this.declaredFactors,
      automationFailure: null,
      actionsExecuted: this.actionsExecuted,
      snapshotSeqToArtifact: this.snapshotSeqToArtifact,
    };
  }

  private timeout(action: ActionSpec): number {
    return action.timeoutMs ?? this.opts.defaultTimeoutMs;
  }

  private async execute(action: ActionSpec): Promise<void> {
    const page = this.opts.page;
    const timeout = this.timeout(action);

    switch (action.type) {
      case "goto": {
        // A null url means the reporter never gave a path and the interpretation refused to
        // invent one. `?? ""` would resolve it to the target root and navigate somewhere nobody
        // chose, then measure whatever happened to be there — a wrong answer that looks like a
        // real one. Refusing keeps it an automation failure, which is what it is.
        if (action.url === null || action.url === undefined || action.url === "") {
          fail(
            "EXEC_VALUE_UNRESOLVED",
            `Navigation has no URL: it is still pending the unresolved value ${action.unknownRef ?? "(unnamed)"}`,
            { context: { actionId: action.actionId, unknownRef: action.unknownRef ?? "" } }
          );
        }
        const url = new URL(action.url, this.opts.baseUrl).toString();
        if (!isOriginAllowed(url, this.opts.allowedOrigins)) {
          fail("EXEC_ORIGIN_NOT_ALLOWED", "Navigation target is not in safety.allowedOrigins", {
            context: { actionId: action.actionId, origin: new URL(url).origin },
          });
        }
        try {
          await page.goto(url, { timeout, waitUntil: action.waitUntil ?? "load" });
          this.navigatedSuccessfully = true;
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          // Boundary rule (ADR-0005): a transport-layer failure before the first successful
          // navigation is the environment, not our instructions. Misfiling it as automation
          // would be wrong; misfiling it as a product defect would be worse.
          if (!this.navigatedSuccessfully && TRANSPORT_ERROR.test(msg)) {
            fail("EXEC_TARGET_UNREACHABLE", "Target was unreachable at the network layer", {
              context: { actionId: action.actionId, detail: msg.slice(0, 200) },
            });
          }
          throw e;
        }
        break;
      }
      case "click":
        await resolveLocator(page, action.selector!).click({ timeout });
        break;
      case "dblclick":
        await resolveLocator(page, action.selector!).dblclick({ timeout });
        break;
      case "fill":
        await resolveLocator(page, action.selector!).fill(
          resolveValue(action.value, this.opts, action.actionId),
          { timeout }
        );
        break;
      case "select":
        await resolveLocator(page, action.selector!).selectOption(action.option ?? "", { timeout });
        break;
      case "check":
        await resolveLocator(page, action.selector!).check({ timeout });
        break;
      case "uncheck":
        await resolveLocator(page, action.selector!).uncheck({ timeout });
        break;
      case "press":
        if (action.selector)
          await resolveLocator(page, action.selector).press(action.key ?? "Enter", { timeout });
        else await page.keyboard.press(action.key ?? "Enter");
        break;
      case "hover":
        await resolveLocator(page, action.selector!).hover({ timeout });
        break;
      case "scroll":
        await page.mouse.wheel(action.deltaX ?? 0, action.deltaY ?? 0);
        break;
      case "waitFor":
        await this.waitFor(action);
        break;
      case "waitForTimeout":
        // A fixed delay is a DECLARED timing factor recorded in the manifest, not a quiet
        // stabilisation hack (ADR-0014).
        this.declaredFactors.push({
          kind: "fixedActionDelayMs",
          value: action.ms ?? 0,
          actionId: action.actionId,
        });
        await page.waitForTimeout(action.ms ?? 0);
        break;
      case "assert":
        await this.evaluateAssertion(action.assertion!, action.actionId);
        break;
      case "screenshot":
        await this.captureScreenshot(`explicit-${action.actionId}`);
        break;
      case "setStorage":
        await page.evaluate(
          (args: { area: string; key: string; value: string }) => {
            const store =
              args.area === "sessionStorage" ? window.sessionStorage : window.localStorage;
            store.setItem(args.key, args.value);
          },
          {
            area: action.area ?? "localStorage",
            key: action.key ?? "",
            value: resolveValue(action.value, this.opts, action.actionId),
          }
        );
        break;
      case "clearStorage": {
        const areas = action.areas ?? ["localStorage", "sessionStorage"];
        if (areas.includes("localStorage") || areas.includes("sessionStorage")) {
          await page.evaluate((list: string[]) => {
            if (list.includes("localStorage")) window.localStorage.clear();
            if (list.includes("sessionStorage")) window.sessionStorage.clear();
          }, areas as string[]);
        }
        if (areas.includes("cookies")) await page.context().clearCookies();
        break;
      }
      case "setEmulation":
        this.declaredFactors.push({
          kind: "midRunEmulationProfile",
          value: action.profileName ?? null,
          actionId: action.actionId,
        });
        break;
      case "reload":
        await page.reload({ timeout, waitUntil: action.waitUntil ?? "load" });
        break;
      case "goBack":
        await page.goBack({ timeout });
        break;
      case "goForward":
        await page.goForward({ timeout });
        break;
    }
  }

  private async waitFor(action: ActionSpec): Promise<void> {
    const page = this.opts.page;
    const timeout = this.timeout(action);
    switch (action.condition) {
      case "commit":
        // Playwright exposes no "commit" load state; the earliest observable equivalent is
        // domcontentloaded. Recorded here rather than silently accepted as identical.
        await page.waitForLoadState("domcontentloaded", { timeout });
        break;
      case "domcontentloaded":
      case "load":
      case "networkidle":
        await page.waitForLoadState(action.condition, { timeout });
        break;
      case "selectorVisible":
        await resolveLocator(page, action.selector!).waitFor({ state: "visible", timeout });
        break;
      case "selectorHidden":
        await resolveLocator(page, action.selector!).waitFor({ state: "hidden", timeout });
        break;
      case "selectorAttached":
        await resolveLocator(page, action.selector!).waitFor({ state: "attached", timeout });
        break;
      case "selectorDetached":
        await resolveLocator(page, action.selector!).waitFor({ state: "detached", timeout });
        break;
      default:
        await page.waitForLoadState("load", { timeout });
    }
  }

  /** An assertion that could not be evaluated is `not-evaluated`, never `pass`. */
  private async evaluateAssertion(a: AssertionSpec, actionId: string | null): Promise<void> {
    const page = this.opts.page;
    const timeout = a.timeoutMs ?? this.opts.defaultTimeoutMs;
    let result: "pass" | "fail" | "not-evaluated" = "not-evaluated";
    let detail: string | null = null;

    try {
      switch (a.kind) {
        case "elementCountAtLeast": {
          const loc = locatorFor(page, a.selector!);
          const min = a.min ?? 1;
          await loc
            .first()
            .waitFor({ state: "attached", timeout })
            .catch(() => undefined);
          const n = await loc.count();
          result = n >= min ? "pass" : "fail";
          detail = `count=${n} min=${min}`;
          break;
        }
        case "elementCountEquals": {
          const n = await locatorFor(page, a.selector!).count();
          result = n === (a.count ?? 0) ? "pass" : "fail";
          detail = `count=${n} expected=${a.count}`;
          break;
        }
        case "elementVisible": {
          const visible = await resolveLocator(page, a.selector!)
            .isVisible({ timeout })
            .catch(() => false);
          result = visible ? "pass" : "fail";
          detail = `visible=${visible}`;
          break;
        }
        case "elementHidden": {
          const visible = await resolveLocator(page, a.selector!)
            .isVisible({ timeout })
            .catch(() => false);
          result = visible ? "fail" : "pass";
          detail = `visible=${visible}`;
          break;
        }
        case "textContains": {
          const text = (await resolveLocator(page, a.selector!).textContent({ timeout })) ?? "";
          result = text.includes(a.text ?? "") ? "pass" : "fail";
          detail = `matched=${result === "pass"}`;
          break;
        }
        case "textEquals": {
          const text = (
            (await resolveLocator(page, a.selector!).textContent({ timeout })) ?? ""
          ).trim();
          result = text === (a.text ?? "") ? "pass" : "fail";
          detail = `matched=${result === "pass"}`;
          break;
        }
        case "attributeEquals": {
          const v = await resolveLocator(page, a.selector!).getAttribute(a.attribute ?? "", {
            timeout,
          });
          result = v === a.expected ? "pass" : "fail";
          detail = `matched=${result === "pass"}`;
          break;
        }
        case "urlMatches":
          result = new RegExp(a.urlPattern ?? ".*").test(page.url()) ? "pass" : "fail";
          detail = `url matched=${result === "pass"}`;
          break;
        case "storageKeyPresent":
        case "storageKeyAbsent": {
          const present = await page.evaluate(
            (args: { area: string; key: string }) => {
              const store =
                args.area === "sessionStorage" ? window.sessionStorage : window.localStorage;
              return store.getItem(args.key) !== null;
            },
            { area: a.storageArea ?? "localStorage", key: a.storageKey ?? "" }
          );
          result = present === (a.kind === "storageKeyPresent") ? "pass" : "fail";
          detail = `present=${present}`;
          break;
        }
        case "noConsoleErrors":
        case "noUncaughtExceptions":
        case "responseStatusIn":
          // These are decided by the extractor over collected evidence, not against the live
          // page, so they are filled in after the plane runs.
          result = "not-evaluated";
          detail = "deferred to extraction";
          break;
      }
    } catch (e) {
      result = "fail";
      detail = (e instanceof Error ? e.message : String(e)).slice(0, 200);
    }

    this.assertionOutcomes.push({
      assertionId: a.assertionId,
      actionId,
      result,
      isFailurePredicate: a.isFailurePredicate === true,
      detail,
    });

    if (result === "fail") {
      if (this.opts.domSnapshotOn.includes("failure")) await this.captureDomSnapshot("failure");
      if (this.opts.screenshotOn.includes("failure"))
        await this.captureScreenshot(`assert-${a.assertionId}`);
    }
  }

  private async captureOnFailure(actionId: string): Promise<void> {
    if (this.opts.domSnapshotOn.includes("failure")) await this.captureDomSnapshot("failure");
    if (this.opts.screenshotOn.includes("failure"))
      await this.captureScreenshot(`fail-${actionId}`);
  }

  private async captureDomSnapshot(
    trigger: "action" | "navigation" | "failure" | "manual"
  ): Promise<void> {
    try {
      const json = await this.opts.page.evaluate(DOM_SERIALIZER);
      if (json.length > this.opts.domSnapshotMaxBytes) {
        this.opts.collector.note({
          category: "domSnapshots",
          code: "SIZE_LIMIT",
          limitBytes: this.opts.domSnapshotMaxBytes,
        });
        return;
      }
      // Canonicalise, then redact. Order matters: canonicalisation makes the tree comparable,
      // redaction makes it safe to persist.
      const canonical = redactDomTree(
        canonicalizeDom(JSON.parse(json) as DomNode, { maskInlineStyle: true }),
        this.opts.redactor
      );
      const snapshotId = `S${++this.snapshotCounter}`;
      const seq = this.opts.collector.domSnapshot({
        snapshotId,
        trigger,
        nodeCount: countDomNodes(canonical),
        structureHash: domStructureHash(canonical),
      });
      const artifactId = await this.opts.onDomSnapshot?.(JSON.stringify(canonical), snapshotId);
      if (artifactId) {
        this.snapshotSeqToArtifact.set(seq, [artifactId]);
        // Also bind it into the raw log, so an offline rebuild recovers the same association.
        this.opts.collector.attachArtifact(seq, artifactId);
      }
    } catch {
      this.opts.collector.note({ category: "domSnapshots", code: "TARGET_DETACHED" });
    }
  }

  /**
   * Web storage and cookie snapshot. Values go through the redactor in the collector, which
   * hashes session-shaped keys so two runs remain comparable without either value being
   * disclosed.
   */
  private async captureStorage(): Promise<void> {
    try {
      const web = await this.opts.page.evaluate(STORAGE_READER);
      this.opts.collector.storageSnapshot(
        "localStorage",
        web.local.map((e) => ({ key: e.k, rawValue: e.v }))
      );
      this.opts.collector.storageSnapshot(
        "sessionStorage",
        web.session.map((e) => ({ key: e.k, rawValue: e.v }))
      );

      const cookies = await this.opts.page.context().cookies();
      this.opts.collector.storageSnapshot(
        "cookies",
        cookies.map((c) => ({
          key: c.name,
          rawValue: c.value,
          metadata: {
            domain: c.domain,
            path: c.path,
            httpOnly: c.httpOnly,
            secure: c.secure,
            sameSite: c.sameSite ?? null,
          },
        }))
      );
    } catch {
      this.opts.collector.note({ category: "storage", code: "TARGET_DETACHED" });
    }
  }

  private async captureScreenshot(label: string): Promise<void> {
    try {
      const bytes = await this.opts.page.screenshot({ fullPage: false });
      const seq = this.opts.collector.artifact("screenshot");
      const artifactId = await this.opts.onScreenshot?.(bytes, label);
      if (artifactId) {
        this.snapshotSeqToArtifact.set(seq, [artifactId]);
        // Also bind it into the raw log, so an offline rebuild recovers the same association.
        this.opts.collector.attachArtifact(seq, artifactId);
      }
    } catch {
      this.opts.collector.note({ category: "screenshots", code: "TARGET_DETACHED" });
    }
  }
}
