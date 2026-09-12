/**
 * The allowlist. This file is the security boundary of the web UI.
 *
 * The browser never sends a command line. It sends an action id and a flat bag of parameters, and
 * this module is the only thing that turns those into argv. An action that is not listed here
 * cannot run, and a parameter that does not pass its validator does not reach a process.
 *
 * The reason for the indirection: the server spawns a real binary. If the browser could influence
 * argv freely, a page open in the operator's browser would be a shell. Every value below is either
 * a fixed literal or a string that matched a narrow pattern.
 *
 * The UI drives the SAME `investigate` binary a human uses at a terminal. It holds no copy of the
 * pipeline, so it cannot approve a gate the CLI would refuse, skip redaction, or read the API key
 * — the CLI does all of that in its own process, and the answer comes back as JSON.
 */

export class ParamError extends Error {
  constructor(
    readonly param: string,
    message: string
  ) {
    super(message);
    this.name = "ParamError";
  }
}

export type Params = Record<string, unknown>;

function str(params: Params, name: string, pattern: RegExp, hint: string): string {
  const raw = params[name];
  if (typeof raw !== "string" || raw.length === 0) {
    throw new ParamError(name, `${name} is required and must be a non-empty string`);
  }
  if (!pattern.test(raw)) throw new ParamError(name, `${name} must be ${hint}`);
  return raw;
}

function optionalStr(params: Params, name: string, pattern: RegExp, hint: string): string | null {
  const raw = params[name];
  if (raw === undefined || raw === null || raw === "") return null;
  return str(params, name, pattern, hint);
}

function int(params: Params, name: string, min: number, max: number): number {
  const raw = params[name];
  const n = typeof raw === "number" ? raw : Number.parseInt(String(raw ?? ""), 10);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new ParamError(name, `${name} must be a whole number between ${min} and ${max}`);
  }
  return n;
}

function flag(params: Params, name: string): boolean {
  return params[name] === true || params[name] === "true";
}

// Narrow, deliberately boring patterns. Anything richer belongs in a file the CLI reads, not argv.
const ID = /^[A-Z]+-\d{1,6}$/;
const GATE = /^(experiment_selection|target_failure|final_reproduction)$/;
/** Bare hex, as an artifact is addressed on disk: `<kind>/<first two hex>/<sha>.<ext>`. */
const SHA256 = /^[0-9a-f]{64}$/;
/**
 * A proposal checksum, which the CLI prints and compares in its PREFIXED form.
 *
 * These two are not interchangeable and treating them as one thing broke approval outright.
 * `checksumOfBytes` returns `sha256:<hex>`, so `approve` compares the flag against that; the
 * allowlist accepted only bare hex, so the page stripped the prefix to get through, and the CLI
 * then compared bare hex against a prefixed string. Every one-click approval failed with
 * GATE_CHECKSUM_MISMATCH, and the mismatch was between two spellings of the same hash.
 */
const PROPOSAL_CHECKSUM = /^sha256:[0-9a-f]{64}$/;
/** A workspace-relative path with no traversal, no absolute root, no drive letter. */
const REL_PATH = /^(?!\/|[A-Za-z]:)(?!.*\.\.)[A-Za-z0-9._\-/]{1,200}$/;
const NAME = /^[A-Za-z0-9 ._\-()]{1,120}$/;
const ARTIFACT_KIND = /^[a-z0-9-]{1,40}$/;
/** A gate name, artifact id or node id: the positional subject of `show` and `lineage`. */
const SUBJECT = /^[A-Za-z0-9:_-]{1,100}$/;

/**
 * Supplied by the server. Paths the browser sends are workspace-relative by contract, but the CLI
 * runs from the operator's launch directory (so it finds `.env` exactly as it would in a terminal),
 * so the two have to be reconciled here rather than by hoping the two directories coincide.
 */
export interface BuildContext {
  /** Resolve a validated workspace-relative path to absolute, refusing anything that escapes. */
  inWorkspace(rel: string): string;
}

export interface ActionDef {
  /** Stable id the browser sends. */
  id: string;
  /** One line, shown in the UI's action log so the operator sees what ran. */
  summary: string;
  /**
   * Long-running actions become a job with a streamed log rather than a blocking request.
   * `run` drives a real browser for as long as the batch takes.
   */
  streams: boolean;
  build(params: Params, ctx: BuildContext): string[];
}

function def(
  id: string,
  summary: string,
  streams: boolean,
  build: (p: Params, ctx: BuildContext) => string[]
): ActionDef {
  return { id, summary, streams, build };
}

/** `--investigation <id>`, required by most commands. */
function inv(p: Params): string[] {
  return ["--investigation", str(p, "investigation", ID, "an id like INV-001")];
}

export const ACTIONS: readonly ActionDef[] = [
  def("doctor", "check configuration and provider readiness", false, () => ["doctor"]),

  def("init", "create the workspace", false, () => ["init"]),

  def("status", "investigation status", false, (p) => ["status", ...inv(p)]),

  def("intake", "interpret the report into a Flow", false, (p, ctx) => {
    const argv = [
      "intake",
      "--from",
      ctx.inWorkspace(str(p, "from", REL_PATH, "a workspace-relative file path")),
    ];
    const title = optionalStr(p, "title", NAME, "a short plain title");
    if (title) argv.push("--title", title);
    const env = optionalStr(p, "env", NAME, "a target name");
    if (env) argv.push("--env", env);
    if (flag(p, "ai")) argv.push("--ai");
    return argv;
  }),

  def("plan", "render a gate proposal", false, (p, ctx) => {
    const argv = ["plan", ...inv(p)];
    const gate = optionalStr(p, "gate", GATE, "a known gate");
    if (gate) argv.push("--gate", gate);
    const from = optionalStr(p, "from", REL_PATH, "a workspace-relative file path");
    if (from) argv.push("--from", ctx.inWorkspace(from));
    if (flag(p, "ai")) argv.push("--ai");
    return argv;
  }),

  // `approve` takes the gate POSITIONALLY: `investigate approve <gate> --investigation <id> ...`.
  def("approve-scaffold", "write a pre-filled approval file (approves nothing)", false, (p) => {
    const argv = ["approve", str(p, "gate", GATE, "a known gate"), ...inv(p), "--scaffold"];
    const approver = optionalStr(p, "approver", NAME, "a person's name");
    if (approver) argv.push("--approver", approver);
    return argv;
  }),

  /**
   * Records a human decision the operator already made in the UI. It carries the checksum of the
   * exact proposal bytes; the CLI re-computes and refuses on any mismatch. There is no path here
   * that approves without a checksum, which is what keeps "no silent auto-approval" true.
   */
  def("approve", "record an approval against the proposal checksum", false, (p, ctx) => [
    "approve",
    str(p, "gate", GATE, "a known gate"),
    ...inv(p),
    "--checksum",
    str(p, "checksum", PROPOSAL_CHECKSUM, "a checksum of the form sha256:<64 hex>"),
    "--from",
    ctx.inWorkspace(str(p, "from", REL_PATH, "a workspace-relative approval file")),
  ]),

  def("run", "execute approved experiments in Chromium", true, (p) => {
    const argv = ["run", ...inv(p), "--repeat", String(int(p, "repeat", 1, 100))];
    if (p["maxParallel"] !== undefined) {
      argv.push("--max-parallel", String(int(p, "maxParallel", 1, 16)));
    }
    if (p["stopAfterFailures"] !== undefined) {
      argv.push("--stop-after-failures", String(int(p, "stopAfterFailures", 1, 100)));
    }
    return argv;
  }),

  def("analyze", "contrast failing against passing runs", true, (p) => {
    const argv = ["analyze", ...inv(p)];
    if (flag(p, "ai")) argv.push("--ai");
    return argv;
  }),

  // `show` and `lineage` take their subject POSITIONALLY, and there is no `inspect` command.
  def("show", "print a rendered proposal or an artifact", false, (p) => [
    "show",
    str(p, "what", SUBJECT, "a gate name or an artifact id"),
    ...inv(p),
  ]),

  def("lineage", "ancestors and descendants of a node", false, (p) => [
    "lineage",
    str(p, "nodeId", SUBJECT, "a node id"),
    ...inv(p),
  ]),

  def("suite-generate", "emit a deterministic Playwright suite", false, (p, ctx) => {
    const argv = ["suite", "generate", ...inv(p)];
    const out = optionalStr(p, "out", REL_PATH, "a workspace-relative directory");
    if (out) argv.push("--out", ctx.inWorkspace(out));
    return argv;
  }),

  // Registered in the CLI's frozen command contract but not implemented until M4-M8. They are
  // exposed deliberately: the UI shows the typed NOT_IMPLEMENTED answer and the milestone that
  // will bring each one, rather than hiding a step of the pipeline and implying it does not exist.
  def("classify", "classify run outcomes (M4)", false, (p) => ["classify", ...inv(p)]),
  def("frequency", "measure failure frequency (M5)", true, (p) => [
    "frequency",
    "run",
    ...inv(p),
    "--repeat",
    String(int(p, "repeat", 1, 100)),
  ]),
  def("minimize", "minimize the reproduction (M6)", true, (p) => ["minimize", ...inv(p)]),
  def("revalidate", "revalidate the minimized reproduction (M6)", true, (p) => [
    "revalidate",
    ...inv(p),
  ]),
  def("report", "render the Jira-ready report (M7)", false, (p) => ["report", ...inv(p)]),
  def("export", "package reproducer, report and artifacts (M7)", false, (p) => [
    "export",
    ...inv(p),
  ]),
] as const;

const BY_ID = new Map(ACTIONS.map((a) => [a.id, a]));

export function findAction(id: unknown): ActionDef | undefined {
  return typeof id === "string" ? BY_ID.get(id) : undefined;
}

/** Validate an artifact request. Separate from actions: it reads a file, it does not run one. */
export function artifactRequest(query: URLSearchParams): {
  investigation: string;
  kind: string;
  sha: string;
} {
  const p: Params = {
    investigation: query.get("investigation") ?? "",
    kind: query.get("kind") ?? "",
    sha: query.get("sha") ?? "",
  };
  return {
    investigation: str(p, "investigation", ID, "an id like INV-001"),
    kind: str(p, "kind", ARTIFACT_KIND, "a lowercase artifact kind"),
    sha: str(p, "sha", SHA256, "a 64-character sha256"),
  };
}
