import { describe, it, expect } from "vitest";
import { SeededRng } from "@investigator/core";
import { classifyProviderFailure, MAX_ATTEMPTS } from "./errors.js";
import { CircuitBreaker, backoffMs, nextDelay } from "./retry.js";
import { BudgetTracker, estimateCost, preflight, ZERO_SPEND, type BudgetLimits } from "./budget.js";
import { scrubBody } from "./deepseek.js";
import {
  ARTIFACT_KINDS_FOR_CLAIM,
  parseStrictJson,
  rejectUnreachableLevel,
  validateClaimSupport,
  validateReference,
  type EvidenceReference,
  type ReferenceWorld,
} from "./validate.js";

/**
 * M3 acceptance tests for the gateway.
 *
 * Playwright produces evidence. Deterministic software normalizes and measures evidence. DeepSeek interprets and prioritizes evidence. Humans authorize consequential transitions.
 *
 * These cover the parts where a plausible-looking shortcut would be actively dangerous: retrying
 * an auth failure, trusting a status code over a body, inventing a price, or accepting a citation
 * that names a real run but misstates what it shows.
 */

describe("M3-AT-1: error classification", () => {
  it("classifies transport, rate limit, timeout and 5xx as retryable", () => {
    expect(classifyProviderFailure({ status: 0, code: "ECONNREFUSED" })).toMatchObject({
      errorClass: "PROVIDER_UNAVAILABLE",
      retryable: true,
    });
    expect(classifyProviderFailure({ status: 0, code: "ABORT_ERR" })).toMatchObject({
      errorClass: "TIMEOUT",
      retryable: true,
    });
    expect(classifyProviderFailure({ status: 429, body: "" })).toMatchObject({
      errorClass: "RATE_LIMIT",
      retryable: true,
    });
    expect(classifyProviderFailure({ status: 503, body: "" })).toMatchObject({
      errorClass: "PROVIDER_UNAVAILABLE",
      retryable: true,
    });
  });

  it("never classifies an auth failure as retryable, even when it arrives with HTTP 200", () => {
    // Providers do return auth errors in a 200 body. Retrying an auth failure is how a key gets
    // locked out, so the body is authoritative here, not the status.
    const in200 = classifyProviderFailure({
      status: 200,
      body: '{"error":{"message":"Invalid API key provided","type":"invalid_request_error"}}',
    });
    expect(in200.errorClass).toBe("AUTH");
    expect(in200.retryable).toBe(false);

    expect(classifyProviderFailure({ status: 401, body: "" })).toMatchObject({
      errorClass: "AUTH",
      retryable: false,
    });
    expect(MAX_ATTEMPTS["AUTH"]).toBe(1);
  });

  it("treats a context-length 400 as a permanent input problem, not a transport hiccup", () => {
    const c = classifyProviderFailure({
      status: 400,
      body: '{"error":{"message":"This model\'s maximum context length is 65536 tokens","code":"context_length_exceeded"}}',
    });
    expect(c.errorClass).toBe("SCHEMA_MISMATCH");
    expect(c.retryable).toBe(false);
    expect(c.permanentInputProblem).toBe(true);
  });

  it("reads Retry-After in both seconds and HTTP-date form", () => {
    expect(
      classifyProviderFailure({ status: 429, headers: { "retry-after": "30" } }).retryAfterSeconds
    ).toBe(30);
    const future = new Date(Date.now() + 45_000).toUTCString();
    const seconds = classifyProviderFailure({
      status: 429,
      headers: { "retry-after": future },
    }).retryAfterSeconds;
    expect(seconds).toBeGreaterThan(40);
    expect(seconds).toBeLessThanOrEqual(46);
  });

  it("classifies an unrecognised response as unavailable rather than silently succeeding", () => {
    const c = classifyProviderFailure({ status: 218, body: "?" });
    expect(c.errorClass).toBe("PROVIDER_UNAVAILABLE");
    expect(c.detail).toContain("unrecognised");
  });
});

describe("M3-AT-2 and AT-4: retry policy", () => {
  const rng = (): SeededRng => new SeededRng(42);
  const base = { deadlineMs: Number.MAX_SAFE_INTEGER, nowMs: 0 };

  it("honours Retry-After when it is longer than the computed backoff", () => {
    const d = nextDelay({
      ...base,
      attempt: 1,
      rng: rng(),
      classification: classifyProviderFailure({ status: 429, headers: { "retry-after": "25" } }),
    });
    expect(d.shouldRetry).toBe(true);
    expect(d.delayMs).toBe(25_000);
    expect(d.reason).toContain("Retry-After");
  });

  it("never retries AUTH", () => {
    const d = nextDelay({
      ...base,
      attempt: 1,
      rng: rng(),
      classification: classifyProviderFailure({ status: 401 }),
    });
    expect(d.shouldRetry).toBe(false);
    expect(d.reason).toContain("not retryable");
  });

  it("stops at the per-class attempt ceiling", () => {
    const c = classifyProviderFailure({ status: 408 });
    expect(nextDelay({ ...base, attempt: 1, rng: rng(), classification: c }).shouldRetry).toBe(
      true
    );
    // TIMEOUT allows 2 attempts, so the 2nd failure must not schedule a 3rd.
    expect(nextDelay({ ...base, attempt: 2, rng: rng(), classification: c }).shouldRetry).toBe(
      false
    );
  });

  it("M3-AT-4: a retry that would land past the flow deadline is not attempted", () => {
    const d = nextDelay({
      attempt: 1,
      nowMs: 1_000,
      deadlineMs: 1_500,
      rng: rng(),
      classification: classifyProviderFailure({ status: 429, headers: { "retry-after": "30" } }),
    });
    expect(d.shouldRetry).toBe(false);
    expect(d.reason).toContain("wall-clock deadline");
  });

  it("backoff is bounded by the cap and jittered", () => {
    const values = new Set<number>();
    for (let seed = 0; seed < 20; seed++) {
      values.add(backoffMs(5, new SeededRng(seed)));
    }
    expect(values.size, "full jitter must not produce one fixed delay").toBeGreaterThan(5);
    for (const v of values) expect(v).toBeLessThanOrEqual(30_000);
  });
});

describe("M3-AT-3: circuit breaker", () => {
  it("opens after 5 consecutive retryable failures, half-opens, and re-opens doubled", () => {
    const b = new CircuitBreaker();
    const key = "deepseek:m";
    for (let i = 0; i < 5; i++) b.onFailure(key, "PROVIDER_UNAVAILABLE", true, 1000);

    const closed = b.check(key, 1000);
    expect(closed.allowed).toBe(false);
    expect(closed.state).toBe("open");

    // After 60s it half-opens and allows exactly one trial.
    const trial = b.check(key, 1000 + 60_000);
    expect(trial.allowed).toBe(true);
    expect(trial.state).toBe("half-open");

    // The trial fails: re-open with the cooldown doubled.
    b.onFailure(key, "PROVIDER_UNAVAILABLE", true, 61_000);
    expect(b.check(key, 61_000 + 60_000).allowed, "60s is no longer enough").toBe(false);
    expect(b.check(key, 61_000 + 120_001).allowed).toBe(true);
  });

  it("opens after 3 consecutive AUTH failures", () => {
    const b = new CircuitBreaker();
    for (let i = 0; i < 3; i++) b.onFailure("k", "AUTH", false, 0);
    expect(b.check("k", 0).allowed).toBe(false);
  });

  it("a permanent input problem does not trip the breaker", () => {
    // One malformed request must not block every later call: it says nothing about provider health.
    const b = new CircuitBreaker();
    for (let i = 0; i < 10; i++) b.onFailure("k", "SCHEMA_MISMATCH", false, 0);
    expect(b.check("k", 0).allowed).toBe(true);
  });

  it("is per model, so one failing model does not fast-fail another", () => {
    const b = new CircuitBreaker();
    for (let i = 0; i < 5; i++) b.onFailure("deepseek:reasoner", "TIMEOUT", true, 0);
    expect(b.check("deepseek:reasoner", 0).allowed).toBe(false);
    expect(b.check("deepseek:chat", 0).allowed).toBe(true);
  });

  it("a success closes the breaker and resets the cooldown", () => {
    const b = new CircuitBreaker();
    for (let i = 0; i < 5; i++) b.onFailure("k", "TIMEOUT", true, 0);
    b.onSuccess("k");
    expect(b.check("k", 0)).toMatchObject({ allowed: true, state: "closed" });
  });
});

describe("M3-AT-12 and AT-13: budgets and cost", () => {
  const limits: BudgetLimits = {
    maxTotalTokens: 10_000,
    maxUsd: 1.0,
    maxTurns: 5,
    maxWallClockMs: 60_000,
    maxToolCalls: 8,
    maxRepairs: 1,
  };
  const prices = { m1: { inputUsdPerMillionTokens: 100, outputUsdPerMillionTokens: 200 } };

  it("refuses pre-dispatch when the worst case would cross the cost ceiling", () => {
    const r = preflight({
      limits,
      spent: { ...ZERO_SPEND, usd: 0.99 },
      // Within the TOKEN budget, so the cost dimension is the one under test. Tokens are checked
      // first by design: the cheaper check should refuse first.
      plannedPromptTokens: 5_000,
      plannedMaxOutputTokens: 1_000,
      modelId: "m1",
      prices,
    });
    expect(r.allowed).toBe(false);
    expect(r.stopReason).toBe("BUDGET_COST");
  });

  it("the investigation ceiling outranks the flow budget", () => {
    const r = preflight({
      limits,
      spent: ZERO_SPEND,
      plannedPromptTokens: 1000,
      plannedMaxOutputTokens: 1000,
      modelId: "m1",
      prices,
      investigationUsdSpent: 4.999,
      investigationUsdCeiling: 5,
    });
    expect(r.allowed).toBe(false);
    expect(r.detail).toContain("INVESTIGATION ceiling");
  });

  it("M3-AT-13: an unpriced model warns and falls back to token ceilings, never a guessed price", () => {
    const cost = estimateCost("unknown-model", 1000, 1000, prices);
    expect(cost.usd).toBeNull();
    expect(cost.warning).toBe("UNPRICED_MODEL");

    const ok = preflight({
      limits,
      spent: ZERO_SPEND,
      plannedPromptTokens: 100,
      plannedMaxOutputTokens: 100,
      modelId: "unknown-model",
      prices,
    });
    expect(ok.allowed, "an unpriced model is not blocked, it is bounded by tokens").toBe(true);
    expect(ok.warnings).toContain("UNPRICED_MODEL");

    const overToken = preflight({
      limits,
      spent: ZERO_SPEND,
      plannedPromptTokens: 9_000,
      plannedMaxOutputTokens: 9_000,
      modelId: "unknown-model",
      prices,
    });
    expect(overToken.allowed).toBe(false);
    expect(overToken.stopReason).toBe("BUDGET_TOKENS");
  });

  it("reports the exhausted dimension by name, in every dimension", () => {
    const t = new BudgetTracker(limits, 0);
    expect(t.exhausted(0)).toBeNull();
    for (let i = 0; i < 5; i++) t.chargeCall({ totalTokens: 1, usd: 0, nowMs: 0 });
    expect(t.exhausted(0)).toBe("BUDGET_TURNS");

    const t2 = new BudgetTracker(limits, 0);
    expect(t2.exhausted(60_001)).toBe("BUDGET_WALLCLOCK");

    const t3 = new BudgetTracker(limits, 0);
    for (let i = 0; i < 8; i++) t3.chargeToolCall(0);
    expect(t3.exhausted(0)).toBe("BUDGET_TOOL_CALLS");
  });

  it("charges a refused tool call, so the allowlist cannot be probed for free", () => {
    const t = new BudgetTracker(limits, 0);
    t.chargeToolCall(0);
    expect(t.spent.toolCalls).toBe(1);
  });

  it("every retry shares the flow deadline", () => {
    const t = new BudgetTracker(limits, 1_000);
    expect(t.deadlineMs()).toBe(61_000);
  });
});

describe("secret hygiene", () => {
  it("scrubs anything key-shaped out of a quoted provider body", () => {
    const body =
      '{"error":"bad key sk-abcdef0123456789abcdef","headers":{"authorization":"Bearer eyJhbGciOiJIUzI1NiJ9.abc"}}';
    const scrubbed = scrubBody(body);
    expect(scrubbed).not.toContain("sk-abcdef0123456789abcdef");
    expect(scrubbed).not.toContain("eyJhbGciOiJIUzI1NiJ9.abc");
    expect(scrubbed).toContain("[redacted]");
  });

  it("truncates a long body rather than quoting it whole", () => {
    expect(scrubBody("x".repeat(5000)).length).toBeLessThanOrEqual(600);
  });
});

describe("validation pipeline", () => {
  it("parses strict JSON and extracts a single object when JSON mode is unavailable", () => {
    expect(parseStrictJson('{"a":1}')).toMatchObject({ ok: true });
    expect(parseStrictJson('Here you go:\n{"a":1}\nHope that helps')).toMatchObject({ ok: true });
    expect(parseStrictJson("not json at all")).toMatchObject({ ok: false });
  });
});

describe("M3-AT-5 and AT-6: reference validation", () => {
  const INV = "INV-001";

  const world = (over: Partial<ReferenceWorld> = {}): ReferenceWorld => ({
    investigationExists: (id) => id === INV,
    runBelongsTo: (runId, inv) => runId === "RUN-001" && inv === INV,
    eventBelongsTo: (runId, eventId) => runId === "RUN-001" && eventId === "EV-007",
    artifactExists: (id) => id === "NETWORK-1" || id === "SHOT-1",
    artifactKind: (id) => (id === "NETWORK-1" ? "network-log" : "screenshot"),
    resolveField: () => ({ found: true, value: 500 }),
    unusableCategories: () => [],
    ...over,
  });

  const check = (ref: EvidenceReference, w = world()): number[] =>
    validateReference(ref, INV, w, "/r").map((i) => i.check!);

  it("check 1: a missing investigation blocks everything", () => {
    expect(check({ runId: "RUN-001" }, world({ investigationExists: () => false }))).toEqual([1]);
  });

  it("check 2: a run from another investigation is rejected", () => {
    expect(check({ runId: "RUN-999" })).toEqual([2]);
  });

  it("check 3: an event must be scoped to its run", () => {
    expect(check({ runId: "RUN-001", eventId: "EV-999" })).toEqual([3]);
    // Event ids are run-scoped, so citing one without a run is ambiguous even if it exists.
    expect(check({ eventId: "EV-007" })).toEqual([3]);
  });

  it("check 4: a fabricated artifact id is rejected", () => {
    expect(check({ artifactId: "TRACE-nope" })).toEqual([4]);
  });

  it("check 5: an artifact kind that cannot support the claim is rejected", () => {
    // A screenshot cannot establish an HTTP status.
    expect(check({ artifactId: "SHOT-1", claimCategory: "network" })).toEqual([5]);
    expect(check({ artifactId: "NETWORK-1", claimCategory: "network" })).toEqual([]);
    expect(ARTIFACT_KINDS_FOR_CLAIM["storage"]).toEqual(["storage-snapshot"]);
  });

  it("M3-AT-6: a correctly shaped citation with the WRONG value is rejected", () => {
    // The anti-fabrication mechanism: the run exists, the field resolves, and the claim is still
    // false. This must be an error, not a warning.
    const issues = validateReference(
      { runId: "RUN-001", field: "/response/status", expectedValue: 503 },
      INV,
      world(),
      "/r"
    );
    expect(issues.map((i) => i.check)).toEqual([6]);
    expect(issues[0]?.message).toContain("not the claimed");
  });

  it("check 6: exact match only — no coercion", () => {
    expect(check({ runId: "RUN-001", field: "/s", expectedValue: "500" })).toEqual([6]);
    expect(check({ runId: "RUN-001", field: "/s", expectedValue: 500 })).toEqual([]);
  });

  it("check 6: an unresolvable field is rejected", () => {
    expect(
      check(
        { runId: "RUN-001", field: "/nope" },
        world({ resolveField: () => ({ found: false, value: undefined }) })
      )
    ).toEqual([6]);
  });

  it("check 7: a citation into redacted content cannot support a claim", () => {
    const issues = check(
      { runId: "RUN-001", field: "/h", expectedValue: "[redacted]" },
      world({ resolveField: () => ({ found: true, value: "[redacted]" }) })
    );
    expect(issues).toEqual([7]);
  });

  it("check 7: a citation into a missing or corrupted category is rejected", () => {
    expect(
      check(
        { runId: "RUN-001", claimCategory: "network" },
        world({ unusableCategories: () => ["network"] })
      )
    ).toEqual([7]);
  });

  it("a fully valid reference produces no issues", () => {
    expect(
      check({
        runId: "RUN-001",
        eventId: "EV-007",
        artifactId: "NETWORK-1",
        claimCategory: "network",
        field: "/response/status",
        expectedValue: 500,
      })
    ).toEqual([]);
  });
});

describe("claim support and the level ladder", () => {
  it("a causal-flavoured claim needs a field-and-value citation, not an existential one", () => {
    const existential = [{ runId: "RUN-001" }];
    expect(validateClaimSupport("probable_trigger", existential).ok).toBe(false);
    expect(validateClaimSupport("correlated", existential).ok, "lower levels are unaffected").toBe(
      true
    );

    const grounded = [{ runId: "RUN-001", field: "/response/status", expectedValue: 500 }];
    expect(validateClaimSupport("confirmed_trigger", grounded).ok).toBe(true);
  });

  it("confirmed_root_cause is unreachable without an approved attestation, by design", () => {
    const r = rejectUnreachableLevel("confirmed_root_cause", false);
    expect(r.ok).toBe(false);
    expect(r.issues[0]?.message).toContain("unreachable by design");
    expect(rejectUnreachableLevel("confirmed_root_cause", true).ok).toBe(true);
    expect(rejectUnreachableLevel("root_cause_hypothesis", false).ok).toBe(true);
  });
});
