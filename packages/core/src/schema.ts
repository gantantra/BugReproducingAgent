import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import type { ErrorObject, ValidateFunction } from "ajv";
import addFormats from "ajv-formats";
import { fail, InvestigatorError } from "./errors.js";

/**
 * Schema registry. Every persisted record and every AI output is validated strictly, with unknown
 * fields rejected (ADR-0015). A validation failure is an error, never a warning: a silently
 * ignored field is indistinguishable from a field the producer believed it was setting.
 *
 * Schemas are loaded from the repository `schemas/` directory. In M1 they are hand-authored; from
 * M1 onward they are also the emission target of the Zod authoring layer (ADR-0020), and CI fails
 * if regeneration produces a diff.
 */

export interface ValidationFailure {
  instancePath: string;
  schemaPath: string;
  keyword: string;
  message: string;
  params: Record<string, unknown>;
}

export interface ValidationResult<T> {
  ok: boolean;
  value?: T;
  errors: ValidationFailure[];
}

function toFailures(errors: ErrorObject[] | null | undefined): ValidationFailure[] {
  if (!errors) return [];
  return errors.map((e) => ({
    instancePath: e.instancePath,
    schemaPath: e.schemaPath,
    keyword: e.keyword,
    message: e.message ?? "",
    params: (e.params ?? {}) as Record<string, unknown>,
  }));
}

/** Walk upward for the repository `schemas/` directory so tests and the CLI both find it. */
export function findSchemasDir(startDir: string = __dirname): string {
  let dir = resolve(startDir);
  for (let i = 0; i < 12; i++) {
    const candidate = join(dir, "schemas", "common.v1.json");
    if (existsSync(candidate)) return join(dir, "schemas");
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  fail("CONFIG_INVALID", "Could not locate the repository schemas directory", {
    context: { startDir },
  });
}

export class SchemaRegistry {
  private readonly ajv: Ajv2020;
  private readonly loaded = new Set<string>();
  readonly schemasDir: string;

  constructor(schemasDir?: string) {
    this.schemasDir = schemasDir ?? findSchemasDir();
    this.ajv = new Ajv2020({
      strict: true,
      // `allErrors` gives the repair call a complete, machine-generated error list rather than
      // just the first problem (ADR-0009).
      allErrors: true,
      allowUnionTypes: true,
      validateFormats: true,
      // Cross-file $refs are relative filenames; resolve them from disk on demand.
      loadSchema: undefined,
    });
    addFormats(this.ajv as never);
    this.loadAll();
  }

  private loadAll(): void {
    const files = readdirSync(this.schemasDir).filter((f) => f.endsWith(".json"));
    // Two passes: register every schema by $id and by filename, then compile lazily. Registering
    // first means relative $refs between schemas resolve regardless of file order.
    for (const file of files) {
      const raw = readFileSync(join(this.schemasDir, file), "utf8");
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(raw) as Record<string, unknown>;
      } catch (e) {
        throw new InvestigatorError("CONFIG_INVALID", `Schema ${file} is not valid JSON`, {
          context: { file },
          cause: e,
        });
      }
      // Register under the bare filename too, since $refs in these schemas are written as
      // `common.v1.json#/$defs/runId`.
      this.ajv.addSchema(parsed, file);
      this.loaded.add(file);
    }
  }

  has(name: string): boolean {
    return this.loaded.has(name);
  }

  list(): string[] {
    return [...this.loaded].sort();
  }

  private compiled = new Map<string, ValidateFunction>();

  private getValidator(name: string): ValidateFunction {
    const cached = this.compiled.get(name);
    if (cached) return cached;
    if (!this.loaded.has(name)) {
      fail("CONFIG_INVALID", `Unknown schema: ${name}`, { context: { name } });
    }
    let fn: ValidateFunction;
    try {
      fn = this.ajv.getSchema(name) as ValidateFunction;
      if (!fn) throw new Error("getSchema returned undefined");
    } catch (e) {
      throw new InvestigatorError("CONFIG_INVALID", `Schema ${name} failed to compile`, {
        context: { name },
        cause: e,
      });
    }
    this.compiled.set(name, fn);
    return fn;
  }

  /** Non-throwing validation. Use where the caller needs the error list (AI outputs, repair). */
  check<T>(name: string, data: unknown): ValidationResult<T> {
    const fn = this.getValidator(name);
    const ok = fn(data) as boolean;
    return ok
      ? { ok: true, value: data as T, errors: [] }
      : { ok: false, errors: toFailures(fn.errors) };
  }

  /** Throwing validation. Use at persistence boundaries, where a failure must stop the write. */
  assert<T>(name: string, data: unknown, what = "record"): T {
    const result = this.check<T>(name, data);
    if (!result.ok) {
      const first = result.errors[0];
      throw new InvestigatorError("INPUT_INVALID", `Invalid ${what} against ${name}`, {
        subReason: first ? `${first.instancePath || "/"} ${first.message}` : undefined,
        context: {
          schema: name,
          errorCount: result.errors.length,
          firstPath: first?.instancePath ?? null,
          firstMessage: first?.message ?? null,
        },
      });
    }
    return result.value as T;
  }

  /** Render failures as a compact, secret-free list suitable for a log line or a repair prompt. */
  static formatErrors(errors: ValidationFailure[], limit = 20): string {
    return errors
      .slice(0, limit)
      .map((e) => `${e.instancePath || "/"}: ${e.message} (${e.keyword})`)
      .join("; ");
  }
}

let singleton: SchemaRegistry | undefined;

export function schemaRegistry(schemasDir?: string): SchemaRegistry {
  if (!singleton || schemasDir) {
    const created = new SchemaRegistry(schemasDir);
    if (!schemasDir) singleton = created;
    return created;
  }
  return singleton;
}
