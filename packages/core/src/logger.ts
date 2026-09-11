import { isSecret, REDACTED, type Secret } from "./secret.js";
import { isInvestigatorError } from "./errors.js";
import type { JsonPrimitive } from "./types.js";

/**
 * Redaction-first logger.
 *
 * `logging.redactLogs` cannot be disabled (the config loader rejects `false`), and `--verbose`
 * increases *structure*, never sensitivity (ADR-0008). Fields accept only JSON primitives, the
 * same restriction as `InvestigatorError.context`, so a buffer, a header map, or a provider
 * response cannot reach a log line through this path.
 */

export const LOG_LEVELS = ["error", "warn", "info", "debug"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const RANK: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 };

export type LogFields = Record<string, JsonPrimitive | undefined>;

export interface LogSink {
  write(line: string): void;
}

export class StderrSink implements LogSink {
  write(line: string): void {
    // Human output goes to stderr so stdout stays clean for --json.
    process.stderr.write(line + "\n");
  }
}

export class MemorySink implements LogSink {
  readonly lines: string[] = [];
  write(line: string): void {
    this.lines.push(line);
  }
  text(): string {
    return this.lines.join("\n");
  }
  clear(): void {
    this.lines.length = 0;
  }
}

/**
 * Patterns applied to every rendered field value. This is a backstop, not the primary defence:
 * the primary defence is that secret plaintexts and raw evidence never enter a log call.
 */
const BACKSTOP_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi, label: "bearer" },
  { re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, label: "jwt" },
  { re: /\b(sk|pk|api|key|token|secret)[-_][A-Za-z0-9]{16,}/gi, label: "keyish" },
];

function scrubValue(value: JsonPrimitive | undefined, secrets: readonly Secret[]): JsonPrimitive {
  if (value === undefined) return null;
  if (typeof value !== "string") return value;
  let out = value;
  for (const s of secrets) {
    const plain = s.reveal();
    if (plain.length >= 4) out = out.split(plain).join(REDACTED);
  }
  for (const { re } of BACKSTOP_PATTERNS) out = out.replace(re, REDACTED);
  return out;
}

export interface LoggerOptions {
  level?: LogLevel;
  sink?: LogSink;
  json?: boolean;
  /** Registered secrets are scrubbed from every rendered value as a backstop. */
  secrets?: readonly Secret[];
  base?: LogFields;
}

export class Logger {
  private readonly level: LogLevel;
  private readonly sink: LogSink;
  private readonly json: boolean;
  private readonly secrets: readonly Secret[];
  private readonly base: LogFields;

  constructor(opts: LoggerOptions = {}) {
    this.level = opts.level ?? "info";
    this.sink = opts.sink ?? new StderrSink();
    this.json = opts.json ?? false;
    this.secrets = opts.secrets ?? [];
    this.base = opts.base ?? {};
  }

  child(fields: LogFields): Logger {
    return new Logger({
      level: this.level,
      sink: this.sink,
      json: this.json,
      secrets: this.secrets,
      base: { ...this.base, ...fields },
    });
  }

  withSecret(secret: Secret): Logger {
    return new Logger({
      level: this.level,
      sink: this.sink,
      json: this.json,
      secrets: [...this.secrets, secret],
      base: this.base,
    });
  }

  private emit(level: LogLevel, message: string, fields: LogFields): void {
    if (RANK[level] > RANK[this.level]) return;

    const merged: Record<string, JsonPrimitive> = {};
    for (const [k, v] of Object.entries({ ...this.base, ...fields })) {
      if (isSecret(v)) {
        merged[k] = REDACTED;
        continue;
      }
      merged[k] = scrubValue(v as JsonPrimitive | undefined, this.secrets);
    }
    const safeMessage = scrubValue(message, this.secrets) as string;

    if (this.json) {
      this.sink.write(JSON.stringify({ level, message: safeMessage, ...merged }));
      return;
    }
    const rendered = Object.entries(merged)
      .filter(([, v]) => v !== null)
      .map(([k, v]) => `${k}=${typeof v === "string" ? v : String(v)}`)
      .join(" ");
    this.sink.write(
      `${level.toUpperCase().padEnd(5)} ${safeMessage}${rendered ? "  " + rendered : ""}`
    );
  }

  error(message: string, fields: LogFields = {}): void {
    this.emit("error", message, fields);
  }
  warn(message: string, fields: LogFields = {}): void {
    this.emit("warn", message, fields);
  }
  info(message: string, fields: LogFields = {}): void {
    this.emit("info", message, fields);
  }
  debug(message: string, fields: LogFields = {}): void {
    this.emit("debug", message, fields);
  }

  /** Log a typed error without ever touching its `cause` chain, which is not primitives-only. */
  failure(e: unknown, fields: LogFields = {}): void {
    if (isInvestigatorError(e)) {
      this.emit("error", e.message, {
        ...fields,
        ...e.context,
        code: e.code,
        subReason: e.subReason ?? null,
        exitCode: e.exitCode,
        retryable: e.retryable,
      });
      return;
    }
    this.emit("error", e instanceof Error ? e.message : String(e), { ...fields, code: "INTERNAL" });
  }
}

/**
 * Startup safety check: Node can be told to persist unredacted in-process state, which would
 * defeat the whole redaction boundary. We cannot unset these for the current process, so we
 * detect and report them (ADR-0008).
 */
export interface UnsafeDiagnosticsReport {
  unsafe: boolean;
  findings: string[];
}

export function detectUnsafeDiagnostics(
  env: NodeJS.ProcessEnv = process.env
): UnsafeDiagnosticsReport {
  const findings: string[] = [];
  const nodeOptions = env["NODE_OPTIONS"] ?? "";
  const dangerous = [
    "--report-on-fatalerror",
    "--report-on-signal",
    "--report-uncaught-exception",
    "--heapsnapshot-near-heap-limit",
    "--heapsnapshot-signal",
    "--cpu-prof",
    "--heap-prof",
    "--diagnostic-dir",
  ];
  for (const flag of dangerous) {
    if (nodeOptions.includes(flag)) {
      findings.push(
        `NODE_OPTIONS contains ${flag}, which can persist unredacted in-process data to disk`
      );
    }
  }
  const debugValue = env["DEBUG"] ?? "";
  if (/(^|[,\s])pw(:|\*)/.test(debugValue) || debugValue === "*") {
    findings.push(
      `DEBUG=${debugValue} enables Playwright protocol logging, which emits unredacted network and DOM content`
    );
  }
  return { unsafe: findings.length > 0, findings };
}
