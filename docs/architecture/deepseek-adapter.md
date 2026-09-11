# DeepSeek Adapter Design

Status: M0 frozen candidate
Package: `packages/ai-gateway/src/providers/deepseek/`

## Governing principle

Playwright produces evidence. Deterministic software normalizes and measures evidence. DeepSeek interprets and prioritizes evidence. Humans authorize consequential transitions.

## Position

The adapter is the only file tree in the repository that may know:

- the wire format of an OpenAI-compatible chat completions request,
- provider-specific field names, error bodies, and header semantics,
- how `inferenceMode` maps onto request parameters.

Everything above it sees only `LlmRequest` / `LlmResponse` / `ModelCapabilities` and the typed
error taxonomy.

## Transport

- Plain `fetch` over HTTPS. No provider SDK dependency. Rationale: the surface we use is small,
  and an SDK would give us a second source of truth for capability assumptions we have committed to
  probing rather than assuming. See `docs/architecture/build-vs-buy.md`.
- `baseUrl` comes from config (`env:DEEPSEEK_BASE_URL`). The adapter appends the chat-completions
  path. It does not hard-code a host.
- API key is fetched per call through `SecretStore.reveal("DEEPSEEK_API_KEY")` and placed in the
  `Authorization` header. The `Secret` wrapper is unwrapped at the last possible moment, inside the
  header construction, and never assigned to a variable that outlives the call.
- Request timeout is enforced with `AbortController` using `LlmRequest.timeoutMs`.
- No streaming in MVP. Structured output plus one repair is simpler to validate deterministically.
  Streaming is a designed-later concern for latency, not correctness.

## Request mapping

| `LlmRequest` field | Wire mapping |
| --- | --- |
| `alias` | resolved to `model` via config; never sent as-is |
| `system` | first message with role `system` |
| `messages` | `messages[]` with roles `user` / `assistant` / `tool` |
| `responseSchema` | when `jsonMode === "supported"`, sent as the provider structured-output field; otherwise the schema is rendered into the system prompt as a contract and the field is omitted |
| `tools` | when `toolCalls === "supported"`, sent as `tools[]` with `type: "function"`; otherwise omitted and tool-using flows are refused upstream |
| `maxTokens` | `max_tokens`, clamped to `min(request, capability.maxOutputTokens, config.perCallTokens)` |
| `temperature` | `temperature` |
| `timeoutMs` | transport only, not sent |
| `requestId` | sent as a correlation header if accepted, and always recorded locally |

`inferenceMode` mapping is **config-declared, not inferred**. The adapter holds a small mapping
table from `inferenceMode` to the concrete parameters it will send, and records exactly what it
sent in `LlmResponse.inferenceMode` plus the params hash in the ledger. If the configured mode
cannot be expressed for the resolved model, the adapter emits an `INFERENCE_MODE_UNSUPPORTED`
warning and sends the neutral form. It does not silently switch models.

## Response mapping

1. Non-2xx: classify (below), throw typed error. Response body is captured for the ledger after
   redaction, truncated to a configured maximum.
2. 2xx: read the first choice. `rawText` is the message content. `finishReason` is the provider
   value, normalized to a small enum plus a `providerFinishReasonRaw` field in the ledger.
3. `toolCalls` are mapped to our `ToolCall` shape with argument strings parsed as JSON. A tool
   call whose arguments do not parse is an `INVALID_OUTPUT`, not a crash.
4. `usage` is copied. If the provider omits usage, the adapter estimates from a local tokenizer
   approximation and sets a `USAGE_ESTIMATED` warning. Estimated usage is never presented as
   measured.
5. `modelVersion` is populated from the provider response when present, otherwise left undefined.
   The adapter never fabricates a version string.
6. Reasoning/thinking content, when the provider returns it in a separate field, is captured into
   the ledger as a diagnostic payload and is **not** treated as part of the structured answer.
   Structured output is read from the content field only.

## Error classification

| Observation | Class |
| --- | --- |
| HTTP 401, 403; auth error body | `AUTH` |
| HTTP 429; rate-limit body; `Retry-After` present | `RATE_LIMIT` |
| `AbortError`, transport timeout | `TIMEOUT` |
| HTTP 5xx, DNS/connect/TLS error, malformed HTTP | `PROVIDER_UNAVAILABLE` |
| HTTP 400 with a context-length or token-limit signal | `PROVIDER_UNAVAILABLE` with a `CONTEXT_LENGTH` sub-reason; treated as non-retryable and surfaced so the flow can shrink its input |
| 2xx but content is not parseable JSON when JSON was required | `INVALID_OUTPUT` |
| Parseable but fails our schema | `SCHEMA_MISMATCH` |
| Schema-valid but references non-existent IDs | `REFERENCE_MISMATCH` |
| Budget check failed before dispatch | `COST_EXCEEDED` |

Classification is table-driven and unit-tested against recorded fixture responses so that a
provider wording change cannot silently reclassify an auth failure as a retryable one.

## Secret hygiene tests (required in M3, adapter present but unused in M1)

1. `Secret.toString()`, `JSON.stringify(secret)`, template interpolation, and
   `util.inspect(secret)` all yield `[redacted]`.
2. A recorded-request fixture test asserts the `Authorization` header value never appears in the
   ledger row, the log output, or any artifact written during the call.
3. A test asserts that an `AUTH` error message contains neither the key nor any substring of it
   longer than 4 characters.

## Offline mode

The adapter supports a `RecordedProvider` sibling that replays fixture responses from
`/eval/datasets/**/recorded/`. Used by the eval harness and by CI so that CI never requires a live
key. Selection is by an explicit test-only factory, not by config, so production paths cannot fall
back to replay.
