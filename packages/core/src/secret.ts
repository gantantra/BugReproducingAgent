import { inspect } from "node:util";

/**
 * A secret value that refuses to serialise itself.
 *
 * This is the single place credential leakage is prevented structurally rather than by discipline
 * (ADR-0008, frozen decision 6). Every path by which a value normally escapes into a log line, an
 * error message, or an artifact is overridden:
 *
 *   String(secret)            -> "[redacted]"
 *   `${secret}`               -> "[redacted]"
 *   secret + ""               -> "[redacted]"
 *   JSON.stringify(secret)    -> "\"[redacted]\""
 *   console.log(secret)       -> "[redacted]"     (via util.inspect.custom)
 *   util.inspect(secret)      -> "[redacted]"
 *   JSON.stringify({ secret}) -> "{\"secret\":\"[redacted]\"}"
 *
 * `reveal()` is the only way to the plaintext, is deliberately verbose to read at a call site, and
 * is expected to appear exactly once in the codebase: inside the provider adapter, at header
 * construction, never assigned to a variable that outlives the call.
 */

export const REDACTED = "[redacted]";

/**
 * Module-private storage. The plaintext is deliberately NOT an own property of the instance, so
 * it cannot be reached by spread, `Object.keys`, `Object.getOwnPropertyNames`,
 * `Object.getOwnPropertySymbols`, `structuredClone`, or a debugger walking the object graph.
 * Only code inside this module can read it.
 */
const PLAINTEXT = new WeakMap<Secret, string>();

function plaintextOf(secret: Secret): string {
  const v = PLAINTEXT.get(secret);
  if (v === undefined) throw new Error("Secret has no bound value");
  return v;
}

export class Secret {
  readonly name: string;

  constructor(name: string, plaintext: string) {
    this.name = name;
    PLAINTEXT.set(this, plaintext);
  }

  /**
   * Yield the plaintext. Callers must not log, store, serialise, or place the result in an object.
   * Prefer `use()` where the value is needed only for the duration of one expression.
   */
  reveal(): string {
    return plaintextOf(this);
  }

  /** Scoped access, so the plaintext never needs a named binding at the call site. */
  use<T>(fn: (plaintext: string) => T): T {
    return fn(plaintextOf(this));
  }

  get length(): number {
    return plaintextOf(this).length;
  }

  /** Constant-time-ish comparison, for tests that must confirm a value without printing it. */
  equalsPlaintext(candidate: string): boolean {
    const a = plaintextOf(this);
    if (a.length !== candidate.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ candidate.charCodeAt(i);
    return diff === 0;
  }

  toString(): string {
    return REDACTED;
  }

  toJSON(): string {
    return REDACTED;
  }

  valueOf(): string {
    return REDACTED;
  }

  [Symbol.toPrimitive](): string {
    return REDACTED;
  }

  [inspect.custom](): string {
    return REDACTED;
  }

  get [Symbol.toStringTag](): string {
    return "Secret";
  }
}

export function isSecret(v: unknown): v is Secret {
  return v instanceof Secret;
}

/**
 * Scrub a string that may contain known secret plaintexts. Defence in depth for the logger: the
 * primary mechanism is that plaintexts never enter a loggable object at all.
 */
export function scrubKnownSecrets(text: string, secrets: readonly Secret[]): string {
  let out = text;
  for (const s of secrets) {
    const plain = s.reveal();
    if (plain.length >= 4) out = out.split(plain).join(REDACTED);
  }
  return out;
}
