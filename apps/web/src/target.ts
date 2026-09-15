import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { parseDocument, isCollection, type Document } from "yaml";

import { ParamError } from "./actions.js";

/**
 * Record a target from the conversation, so the operator never has to leave the page to hand-edit
 * `config.yaml`.
 *
 * This writes CONFIGURATION, not pipeline behaviour. Execution, approval gates, redaction and the
 * key all stay inside the CLI process; what this does is capture a decision the human just made in
 * the UI and put it where the CLI reads decisions from.
 *
 * What is decided, and by whom:
 *
 *  - **Classification.** There is deliberately no `production`. A target taken from the operator's
 *    own report is recorded as `test` (see `targetFromReport`): sending a report about a site is the
 *    operator naming that site as one they act on, and `test` and `staging` change nothing the run
 *    does, so asking which one repeated a decision already made.
 *  - **Allowed origins.** A navigation outside the list aborts the run. The baseUrl's origin is
 *    added because the schema requires every target origin to appear, and nothing else is.
 *  - **Destructive actions** are not decided here at all. `blockDestructiveActions` is a workspace
 *    policy, not a property of a target, and writing it while recording one would override the
 *    operator's setting behind their back.
 */

export const CLASSIFICATIONS = ["fixture", "test", "staging"] as const;
export type Classification = (typeof CLASSIFICATIONS)[number];

const TARGET_NAME = /^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$/;

export interface TargetRequest {
  name: string;
  baseUrl: string;
  classification: Classification;
}

export interface TargetWritten {
  name: string;
  baseUrl: string;
  origin: string;
  classification: Classification;
  configPath: string;
  allowedOrigins: string[];
}

/** Validate a request from the browser. Throws ParamError, which the server renders as a 400. */
export function validateTargetRequest(body: unknown): TargetRequest {
  const b = (body ?? {}) as Record<string, unknown>;

  const name = String(b["name"] ?? "").trim();
  if (!TARGET_NAME.test(name)) {
    throw new ParamError("name", "name must be lowercase letters, digits and dashes (2-40 chars)");
  }

  const raw = String(b["baseUrl"] ?? "").trim();
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ParamError(
      "baseUrl",
      "baseUrl must be an absolute URL, for example https://staging.example.com"
    );
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ParamError("baseUrl", "baseUrl must be http or https");
  }

  const classification = String(b["classification"] ?? "") as Classification;
  if (!CLASSIFICATIONS.includes(classification)) {
    // `production` lands here, which is the point: it is not a member of the enum, and a target
    // declaring it is rejected at load anyway. Saying so plainly beats a schema error later.
    throw new ParamError(
      "classification",
      `classification must be one of ${CLASSIFICATIONS.join(", ")}. There is deliberately no "production": declaring a target asserts you are authorised to act on it`
    );
  }

  return { name, baseUrl: url.toString().replace(/\/$/, ""), classification };
}

/**
 * The target named in the report itself, or null when the report names no web address.
 *
 * The operator already gave the site: it is in the report they just sent. The page used to ask
 * them to type it again, then to pick an environment label that changed nothing the run does,
 * and answering re-opened the investigation a second time.
 *
 * The first http(s) address wins, trimmed of the punctuation a sentence puts after it. Only its
 * origin becomes the base URL; the page the report mentions stays in the report for the session.
 * The name is the host, readable (`www.99acres.com` → `99acres-com`), so a later target for a
 * different site does not overwrite this one.
 */
export function targetFromReport(text: string): TargetRequest | null {
  const match = /\bhttps?:\/\/[^\s<>"'`]+/i.exec(text ?? "");
  if (!match) return null;
  const raw = match[0].replace(/[).,;:!?\]}]+$/, "");

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }

  const slug = url.hostname
    .toLowerCase()
    .replace(/^www\./, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  const name = TARGET_NAME.test(slug) ? slug : "target-test";

  try {
    return validateTargetRequest({ name, baseUrl: url.origin, classification: "test" });
  } catch {
    // An address that fails the same validation a typed one would is not a target to run on.
    return null;
  }
}

/**
 * Merge the target into the workspace config. Everything else in the file is preserved: this is a
 * read-modify-write of a document a human also edits by hand.
 */
export function writeTarget(workspace: string, req: TargetRequest): TargetWritten {
  const configPath = join(workspace, ".investigator", "config.yaml");

  /*
   * `parseDocument` rather than `parse`, because this file belongs to a person.
   *
   * A parse/stringify round trip discards every comment and re-emits each scalar in the library's
   * preferred style. Both matter here: the file explains itself in comments, and `video: "on"` is
   * quoted on purpose -- bare `on` is boolean true under YAML 1.1, so dropping the quotes leaves a
   * value that reads correctly today and silently flips under a different parser. Editing the
   * document in place preserves comments, ordering and quoting, and touches only what changed.
   */
  const doc: Document = parseDocument(readFileSync(configPath, "utf8"));

  // Block style, not flow style. `setIn` with a plain object emits `{ a: 1, b: 2 }`, which is
  // valid YAML and wrong for a file a person reads and edits alongside hand-written entries.
  const targetNode = doc.createNode({
    baseUrl: req.baseUrl,
    classification: req.classification,
    // The safest of the reset strategies, and the only one that needs nothing else configured:
    // a fresh BrowserContext per run, which the executor does regardless (ADR-0025).
    resetStrategy: "fresh-context",
  });
  blockStyle(targetNode);
  doc.setIn(["execution", "targets", req.name], targetNode);
  // `setIn` creates any missing parent, and an auto-created map is flow style. Re-assert block
  // style from the parent down, or the first target added to an empty workspace arrives as
  // `targets: { name: { ... } }` in a file that is block style everywhere else.
  blockStyle(doc.getIn(["execution", "targets"], true));
  blockStyle(doc.getIn(["execution"], true));

  const origin = new URL(req.baseUrl).origin;
  const current = doc.getIn(["safety", "allowedOrigins"]);
  const existing =
    current && typeof (current as { toJSON?: unknown }).toJSON === "function"
      ? ((current as { toJSON: () => unknown }).toJSON() as string[])
      : [];
  const origins = [...new Set([...(Array.isArray(existing) ? existing : []), origin])];
  const originsNode = doc.createNode(origins);
  blockStyle(originsNode);
  doc.setIn(["safety", "allowedOrigins"], originsNode);

  // Nothing is written for blockDestructiveActions. Recording a target is not the place to decide
  // it, and writing the old default here silently re-armed the guard on every workspace configured
  // through this page, overriding the loaded default. An absent key means "take the default".

  writeFileSync(configPath, doc.toString(), "utf8");

  return {
    name: req.name,
    baseUrl: req.baseUrl,
    origin,
    classification: req.classification,
    configPath,
    allowedOrigins: [...origins],
  };
}

/** Force block style on a node and everything under it. */
function blockStyle(node: unknown): void {
  if (!isCollection(node)) return;
  node.flow = false;
  for (const item of node.items as unknown[]) {
    const value = (item as { value?: unknown }).value;
    blockStyle(value === undefined ? item : value);
  }
}

/** What is already configured, so the UI can ask only for what is missing. */
export function readTargets(workspace: string): Array<{ name: string; baseUrl: string }> {
  const configPath = join(workspace, ".investigator", "config.yaml");
  try {
    const doc = parseDocument(readFileSync(configPath, "utf8")).toJS() as {
      execution?: { targets?: Record<string, { baseUrl?: string }> };
    };
    const targets = doc.execution?.targets ?? {};
    return Object.entries(targets).map(([name, t]) => ({ name, baseUrl: t?.baseUrl ?? "" }));
  } catch {
    return [];
  }
}
