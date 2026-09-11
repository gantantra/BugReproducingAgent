# Redaction Policy

Status: M0 frozen candidate
Default policy file: `policies/default.yaml` (resolved relative to the workspace)
Schema: `schemas/redaction-policy.v1.json`

## Governing principle

Playwright produces evidence. Deterministic software normalizes and measures evidence. DeepSeek interprets and prioritizes evidence. Humans authorize consequential transitions.

## Design goals, in priority order

1. Never persist or transmit a secret or PII.
2. Preserve enough structure that the evidence is still diagnostically useful.
3. Be deterministic, versioned, and auditable, so two runs redact identically and any output can be
   traced to the exact policy bytes that produced it.
4. Fail closed on anything it cannot classify.

Goal 1 outranks goal 2. Where they conflict, the value is removed and the category is marked
`redacted`, which caps dependent findings at `correlated`.

## Policy structure

```yaml
policyId: default
policyVersion: 1.0.0
mode: strict            # strict | permissive
defaults:
  unknownFieldAction: mask-value      # strict mode; permissive uses `keep`
  valueReplacement: "[redacted]"
  shapeDescriptor: true               # emit {type, length, sha256Prefix} alongside the mask

rules:
  - id: http-auth-headers
    appliesTo: [network.requestHeaders, network.responseHeaders]
    match: { headerNameIn: [authorization, proxy-authorization, cookie, set-cookie, x-api-key,
                            x-auth-token, x-csrf-token, x-xsrf-token] }
    action: mask-value
    keepName: true

  - id: cookie-values
    appliesTo: [storage.cookies]
    match: { any: true }
    action: mask-value
    keepName: true
    keepMetadata: [domain, path, expires, httpOnly, secure, sameSite, size]

  - id: url-query-secrets
    appliesTo: [network.url, navigation.url, action.url]
    match: { queryKeyMatches: "(?i)(token|access_token|id_token|refresh_token|code|state|nonce|
                                signature|sig|key|apikey|api_key|password|passwd|pwd|secret|
                                session|sid|sessionid|auth|otp|jwt)" }
    action: mask-value
    keepName: true

  - id: bearer-and-jwt-anywhere
    appliesTo: [console.text, network.responseBody, dom.text, storage.values, exception.message]
    match: { valueMatches: "(?i)bearer\\s+[A-Za-z0-9._~+/=-]{16,}|eyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}" }
    action: mask-match

  - id: pii-email
    appliesTo: [console.text, network.responseBody, dom.text, storage.values, network.url,
                exception.message]
    match: { valueMatches: "[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,255}\\.[A-Za-z]{2,24}" }
    action: mask-match
    exceptions: { domainIn: [example.invalid, example.test, test.invalid] }

  - id: pii-phone-in
    appliesTo: [console.text, network.responseBody, dom.text, storage.values]
    match: { valueMatches: "(?<!\\d)(?:\\+91[- ]?)?[6-9]\\d{9}(?!\\d)" }
    action: mask-match

  - id: pii-card
    appliesTo: [console.text, network.responseBody, dom.text, storage.values, action.inputValue]
    match: { luhnCandidate: true, digitsBetween: [13, 19] }
    action: mask-match

  - id: pii-govt-id-in
    appliesTo: [console.text, network.responseBody, dom.text, storage.values]
    match: { valueMatches: "(?<![A-Z0-9])[A-Z]{5}\\d{4}[A-Z](?![A-Z0-9])|(?<!\\d)\\d{4}\\s?\\d{4}\\s?\\d{4}(?!\\d)" }
    action: mask-match
    note: "PAN-shaped and Aadhaar-shaped tokens. Deliberately broad."

  - id: generic-high-entropy
    appliesTo: [network.url, storage.values, console.text]
    match: { entropyBitsPerCharAtLeast: 3.5, minLength: 24, charsetIn: [base64url, hex] }
    action: mask-match

  - id: response-bodies-default
    appliesTo: [network.responseBody]
    match: { any: true }
    action: drop-value
    keepMetadata: [contentType, byteLength, sha256]
    unless: { contentTypeIn: [application/json, text/plain, text/html], andOptIn: captureBodies }

  - id: password-inputs
    appliesTo: [action.inputValue, dom.attributes]
    match: { inputTypeIn: [password], orAttributeNameIn: [value] , andInputTypeIn: [password] }
    action: drop-value

  - id: form-input-values
    appliesTo: [action.inputValue]
    match: { any: true }
    action: mask-value
    keepMetadata: [length, isEmpty]
    note: "Typed values come from declared test data; masked anyway, since the declared value is
           already recorded in the approved proposal where it belongs."

  - id: session-ids-in-storage
    appliesTo: [storage.localStorage, storage.sessionStorage]
    match: { keyMatches: "(?i)(token|auth|session|jwt|credential|secret|key)" }
    action: mask-value
    keepName: true
    keepMetadata: [length, type]

  - id: indexeddb
    appliesTo: [storage.indexedDb]
    match: { any: true }
    action: names-only
    note: "Database and store names only. No record contents in MVP."
```

## Actions

| Action | Effect | Structure retained |
| --- | --- | --- |
| `keep` | No change | All |
| `mask-value` | Whole value replaced by `valueReplacement`, plus a shape descriptor when enabled | Field name, position, metadata listed in `keepMetadata` |
| `mask-match` | Only the matched substrings replaced | Surrounding text, offsets, length |
| `drop-value` | Field removed entirely | Field name and `keepMetadata` |
| `names-only` | Keys/names retained, values removed | Names and counts |
| `hash-value` | Value replaced by `sha256:<first 12 hex>` | Field name; enables equality comparison across runs without revealing the value |

`hash-value` is the workhorse for comparison: two runs can be shown to have used *different*
session tokens without either being disclosed. Rules that need cross-run comparability use it
instead of `mask-value`.

## Shape descriptors

When `defaults.shapeDescriptor` is true, a masked value is accompanied by
`{ type, length, sha256Prefix }`. This is what lets `get_storage_diff` report "the value changed"
without revealing either value, and what lets a finding cite a *difference* while the category is
marked `redacted`.

## Mode

| Mode | `unknownFieldAction` | Use |
| --- | --- | --- |
| `strict` (default) | `mask-value` | Any field the policy cannot classify is treated as sensitive |
| `permissive` | `keep` | Fixture-only investigations where the target classification is `fixture`. Rejected at config load for `test` and `staging` targets |

Strict mode is what "unknown-shape data is redacted by default" means concretely. A new field
appearing in a response body is masked until a rule says otherwise.

## Application points

| Stage | What runs there | Why |
| --- | --- | --- |
| Collection time | Rules decidable per-event without whole-run context: `http-auth-headers`, `cookie-values`, `url-query-secrets`, `password-inputs`, `response-bodies-default` size/type gating | Keeps the highest-risk values out of any buffer that outlives the event |
| Normalization stage 3 | All remaining rules, including cross-event and entropy-based ones | Needs the normalized representation |
| Pre-transmission | Verification pass over the serialized `ToolResult` | Defence in depth before the provider boundary |
| Pre-export | Verification pass over every artifact in the bundle | Catches anything an earlier stage missed and blocks the export |

The verification passes do not *apply* redaction, they *detect* residue. A hit at
pre-transmission or pre-export is an error, not a silent fix, because a hit means an earlier stage
has a bug.

## The trace problem

Playwright traces are the richest artifact and the hardest to redact: they contain network bodies,
DOM snapshots, and action metadata in a packed format. Three supported dispositions, chosen by
config:

| `capture.tracePolicy` | Behaviour | `captureStatus.trace` |
| --- | --- | --- |
| `redacted-pipeline` (default) | Trace resources are extracted, redacted field-by-field where the format allows, and repacked. Anything not field-addressable is dropped | `complete` or `partial` with reasons |
| `withhold` | Trace is collected for in-process analysis and not persisted | `redacted` |
| `raw-opt-in` | Trace persisted unredacted. Permitted only when the target classification is `fixture`. Rejected at config load otherwise, and every manifest in the session records `unsafeTrace: true` | `complete` |

Video is treated similarly: pixels cannot be field-redacted, so video is `on-failure` by default,
and a config check refuses `video: on` together with a `staging` target unless explicitly
acknowledged in config with a recorded justification string.

## Determinism and versioning

- Every rule is a pure function of the field value plus declared metadata. No time, no randomness,
  no network.
- Regex evaluation is bounded: patterns are pre-compiled, linear-time-checked at policy load
  (nested-quantifier detection), and applied with a per-field length cap to prevent pathological
  backtracking on large bodies.
- `policyHash` is the SHA-256 of the canonical policy file bytes. Every `RedactionStamp` records
  `policyId`, `policyVersion`, `policyHash`, `mode`, and `appliedRules: [{ruleId, occurrences}]`.
- Changing the policy does **not** retroactively redact existing artifacts. It changes what future
  runs persist. A report citing older artifacts records the older `policyHash`, so the reader can
  see which rules were in force.

## Testing

| Test | Milestone |
| --- | --- |
| Per-rule unit tests with positive and negative fixtures | M1 |
| `redaction_before_persistence.spec.ts`: a fixture emitting cookies, auth headers, URL tokens, PII in a response body and in console, asserted absent from every persisted artifact, DB row, log line, and index entry | M1 gate |
| Fail-closed test: a store call without a `RedactionStamp` raises `REDACTION_NOT_APPLIED` | M1 gate |
| Pre-transmission verification test: a deliberately unredacted `ToolResult` is blocked before dispatch | M3 |
| Export verification test | M7 |
| Policy fuzzing: generated payloads containing synthetic secrets in unusual encodings and nestings; measures residue rate and regex time bounds | M8 |
| Determinism test: same input, same policy, byte-identical redaction across platforms | M1 |

## Known limitations

1. Pattern-based redaction cannot recognise a novel secret format. Strict mode mitigates; it does
   not eliminate.
2. Field-level redaction of video is impossible. The mitigation is policy, not technology.
3. Redaction reduces diagnostic power. This is priced into the level ladder rather than hidden: a
   finding depending on a `redacted` category cannot exceed `correlated`.
4. `hash-value` reveals equality. Two runs sharing a token are distinguishable from two runs not
   sharing one. Accepted, and preferable to disclosure.
