# LlmProvider Contract

Status: M0 frozen candidate
Package: `packages/ai-gateway`

## Governing principle

Playwright produces evidence. Deterministic software normalizes and measures evidence. DeepSeek interprets and prioritizes evidence. Humans authorize consequential transitions.

## Interface

```ts
interface LlmProvider {
  complete(req: LlmRequest): Promise<LlmResponse>;
  capabilities(alias: ModelAlias): Promise<ModelCapabilities>;
}

type ModelAlias = "FAST_MODEL" | "REASONING_MODEL" | "FALLBACK_MODEL";

interface LlmRequest {
  alias: ModelAlias;
  system: string;
  messages: LlmMessage[];
  responseSchema?: JsonSchema;
  tools?: ToolSpec[];
  maxTokens: number;
  temperature: number;
  timeoutMs: number;
  requestId: string;
}

interface LlmResponse {
  rawText: string;
  parsed?: unknown;
  toolCalls?: ToolCall[];
  usage: { promptTokens: number; completionTokens: number; totalTokens: number };
  provider: string;
  modelId: string;
  modelVersion?: string;
  inferenceMode?: string;
  latencyMs: number;
  finishReason: string;
  warnings: string[];
}

interface ModelCapabilities {
  jsonMode: CapabilitySupport;
  toolCalls: CapabilitySupport;
  thinkingMode: CapabilitySupport;
  contextWindow: number;
  maxOutputTokens: number;
}

type CapabilitySupport = "supported" | "unsupported" | "unknown";
```

## Rules

1. Model aliases are config-driven. Never guess. Never silently substitute.
2. Do not assume the provider exposes a model catalog.
3. Run bounded startup probes. Record observed behavior. Disable unsupported functionality.
4. Record provider, model ID, model version, inference mode, prompt version, params, usage,
   latency, and warnings for every call.
5. Provider-specific response shapes never leak past the adapter.
6. Provider unavailability must not corrupt deterministic execution evidence.
7. Error taxonomy: `AUTH`, `RATE_LIMIT`, `TIMEOUT`, `INVALID_OUTPUT`, `SCHEMA_MISMATCH`,
   `REFERENCE_MISMATCH`, `PROVIDER_UNAVAILABLE`, `COST_EXCEEDED`.
8. Retry, backoff, and circuit-breaker policy must be explicit.

## Alias resolution

```
alias -> config.llm.aliases[alias].modelId -> (env: resolution) -> concrete model ID
```

Failure to resolve is a load-time `USAGE` error. There is no fallback chain that silently swaps
`REASONING_MODEL` for `FAST_MODEL`. `FALLBACK_MODEL` is used **only** when a flow explicitly
declares `fallbackAlias: FALLBACK_MODEL` in its `flow.yaml`, and every fallback use is recorded as
a warning on the flow result and in the AI call ledger.

## Capability probing

`capabilities(alias)` returns a `ModelCapabilities` assembled from three sources, in order:

1. **Cached probe result** for `(provider, modelId, inferenceMode, adapterVersion)` if within
   `capabilitiesCacheTtlSeconds`. Cache lives in the metadata store, not in memory only, so a
   fresh process does not re-probe unnecessarily.
2. **Bounded startup probe**, run at most once per cache miss, per capability:
   - `jsonMode`: one minimal request with a two-field response schema and `maxTokens: 64`.
   - `toolCalls`: one minimal request with a single no-op tool spec and `maxTokens: 64`.
   - `thinkingMode`: one minimal request in the configured inference mode, `maxTokens: 64`.
   Each probe has a hard timeout of 15s and one retry. A probe that fails with `TIMEOUT`,
   `RATE_LIMIT`, or `PROVIDER_UNAVAILABLE` yields `unknown`, not `unsupported`.
3. **Config declaration**, if present, which may only *narrow* an observed capability, never widen
   it. A config claim of `supported` against an observed `unsupported` is rejected with a clear
   error rather than trusted.

`contextWindow` and `maxOutputTokens` are not probeable safely. They come from config when
declared; otherwise the adapter uses conservative documented-unknown defaults and marks the flow
result with a `CAPABILITY_UNKNOWN` warning. Budgets are then enforced by token accounting on our
side rather than by trusting a limit we did not verify.

Probe results are recorded verbatim (request shape, response shape summary, error class) so that a
later behaviour change is diagnosable.

### Degradation matrix

| `jsonMode` | `toolCalls` | Behaviour |
| --- | --- | --- |
| supported | supported | Full path: structured output plus tool loop |
| supported | unsupported/unknown | Tool-using flows are disabled; flows with `maxToolCalls: 0` proceed. Tool-using flows return typed `AI_CAPABILITY_MISSING` |
| unsupported/unknown | any | Structured output requested via prompt contract only; response is extracted with a strict single-JSON-object extractor, then schema-validated as usual. A `JSON_MODE_UNAVAILABLE` warning is attached |
| unsupported | unsupported | Only `intake_to_flow`-class single-shot flows are attempted; all others return `AI_CAPABILITY_MISSING` |

Disabling is explicit and visible. The agent never pretends a capability exists.

## Validation pipeline (mandatory, in order)

For every AI result:

1. Parse.
2. Validate against the versioned application schema.
3. Reject unknown fields where appropriate.
4. Validate every reference against actual IDs in the input.
5. Reject unsupported actions or fabricated evidence references.
6. Attempt one bounded repair call.
7. On failure, return typed `AI_INVALID_OUTPUT`.
8. Never silently substitute guessed values.

JSON mode only guarantees parseable JSON where supported. It does not replace application-side
schema validation.

### Repair call

One attempt, and only one, per flow turn. The repair request contains:

- the original system prompt (unchanged),
- the original user content (unchanged),
- the invalid output verbatim,
- the *machine-generated* validation error list (schema paths plus reference-check failures),
- an instruction to return only corrected JSON.

The repair call uses the same alias, the same schema, and `temperature: 0`. It is charged to the
flow budget. If the repair also fails, the gateway returns `AI_INVALID_OUTPUT` with both failure
reports attached. Neither the invalid output nor the repair output is persisted as a domain record;
both are retained in the AI call ledger as diagnostic payloads subject to redaction.

## Retry, backoff, circuit breaker

| Error class | Retryable | Policy |
| --- | --- | --- |
| `AUTH` | no | Fail immediately. Do not retry, do not log the key |
| `RATE_LIMIT` | yes | Up to 4 attempts, exponential backoff base 1s, factor 2, full jitter, cap 30s. Honour `Retry-After` when present and larger than the computed delay |
| `TIMEOUT` | yes | Up to 2 attempts, then fail |
| `PROVIDER_UNAVAILABLE` (5xx, connect error) | yes | Up to 3 attempts, same backoff as `RATE_LIMIT` |
| `INVALID_OUTPUT` / `SCHEMA_MISMATCH` / `REFERENCE_MISMATCH` | one repair only | Not a transport retry |
| `COST_EXCEEDED` | no | Typed partial or inconclusive result |

Circuit breaker, per `(provider, modelId)`:

- Opens after 5 consecutive retryable transport failures or 3 consecutive `AUTH` failures.
- Open for 60s, then half-open: one trial request. Success closes it; failure re-opens with the
  duration doubled, capped at 10 minutes.
- While open, calls fail fast with `PROVIDER_UNAVAILABLE` and the remaining cooldown.
- Breaker state is per-process and is reported by `investigate doctor`.

All retries share one wall-clock deadline derived from the flow budget
(`budget.maxWallClockMs`). Retries never extend a flow past its budget.

## Idempotency and the ledger

Every call carries a `requestId` that is deterministic in
`(investigationId, flowId, flowVersion, turnIndex, inputContentHash, attemptIndex)`. The ledger
row is written **before** the request is dispatched (state `IN_FLIGHT`) and updated to `COMPLETE`
or `FAILED` after. A crash therefore leaves an auditable `IN_FLIGHT` row rather than an invisible
spend.

`AiCallRecord` fields: `requestId`, `investigationId`, `flowId`, `flowVersion`, `promptVersion`,
`alias`, `provider`, `modelId`, `modelVersion`, `inferenceMode`, `paramsJson`, `promptTokens`,
`completionTokens`, `totalTokens`, `estimatedUsd`, `latencyMs`, `finishReason`, `attemptIndex`,
`state`, `errorClass`, `warningsJson`, `requestContentHash`, `responseContentHash`.

## Cost accounting

Cost is computed from a config-declared price table keyed by `modelId`. If no price is declared for
the model in use, cost is recorded as `null` with an `UNPRICED_MODEL` warning, and budget
enforcement falls back to token ceilings. The agent never invents a price.

`perInvestigationUsd` is checked before each call using committed spend plus the worst-case cost of
the call about to be made. Exceeding it yields `COST_EXCEEDED` and a typed partial result.

## Isolation from execution

`ai-gateway` is not importable from `execution` or `evidence`. Provider unavailability therefore
cannot change what a run captured. If the provider is down mid-investigation, `investigate run`,
`investigate frequency run`, and `investigate revalidate` continue to work; only interpretation
steps are blocked, and they are blocked with a typed error rather than a degraded guess.
