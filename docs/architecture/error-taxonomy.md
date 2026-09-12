# Error Taxonomy

Status: M0 frozen candidate
Package: `packages/core/src/errors`

## Governing principle

Playwright produces evidence. Deterministic software normalizes and measures evidence. DeepSeek interprets and prioritizes evidence. Humans authorize consequential transitions.

## Shape

```ts
interface InvestigatorError {
  code: ErrorCode;              // stable, machine-readable
  message: string;              // human, redacted, never contains secrets or raw evidence
  subReason?: string;           // stable enum per code where useful
  retryable: boolean;
  exitCode: number;             // maps to the CLI contract
  context: Record<string, JsonPrimitive>;  // IDs and counts only, never payloads
  cause?: InvestigatorError;
}
```

Rules:

- Every thrown error in the codebase is one of these. A bare `Error` escaping to the CLI boundary
  is itself a bug and is caught, wrapped as `INTERNAL`, and reported with a stack in `--verbose`.
- `context` accepts only JSON primitives. Passing a buffer, a DOM string, a header map, or a
  provider response into `context` is blocked by the type signature. This is the mechanism that
  prevents unredacted evidence from leaking through error messages into logs.
- `message` is produced from a template plus `context`. Templates are reviewed for secret safety.

## Codes

### Configuration and usage

| Code | Exit | Retryable | Notes |
| --- | --- | --- | --- |
| `CONFIG_INVALID` | 1 | no | Schema violation, unknown key, cross-field assertion failure |
| `CONFIG_ENV_UNRESOLVED` | 1 | no | `env:NAME` unresolvable; names the variable, never a value |
| `WORKSPACE_NOT_FOUND` | 1 | no | No `.investigator/` found |
| `WORKSPACE_VERSION_MISMATCH` | 1 | no | DB migration level newer than the binary |
| `INPUT_INVALID` | 1 | no | Unreadable or invalid intake report / approval file |
| `INTERNAL` | 1 | no | Unexpected; always a bug |
| `NOT_IMPLEMENTED` | 1 | no | A command in the frozen CLI contract that arrives in a later milestone. Registered and failing loudly, so the contract is discoverable from `--help` without a command silently doing nothing |

### Approvals

| Code | Exit | Retryable | Notes |
| --- | --- | --- | --- |
| `GATE_REQUIRED` | 2 | no | Transition needs an approval that does not exist |
| `GATE_ALREADY_APPROVED` | 2 | no | Gate not in `AWAITING_APPROVAL` |
| `GATE_CHECKSUM_MISMATCH` | 3 | no | Flag, file, and artifact checksums disagree |
| `GATE_PROPOSAL_STALE` | 3 | no | Proposal artifact changed since it was rendered |
| `GATE_APPROVAL_EXPIRED` | 2 | no | Older than `approvals.expiryHours` |
| `GATE_EDIT_OUT_OF_SURFACE` | 1 | no | Approval file edits a field the gate does not permit |
| `GATE_REFERENCE_UNKNOWN` | 1 | no | Approval references an ID not in this investigation |

### AI

| Code | Exit | Retryable | Notes |
| --- | --- | --- | --- |
| `AI_AUTH` | 6 | no | Provider auth. Never logs key material |
| `AI_RATE_LIMIT` | 6 | yes | After policy exhaustion |
| `AI_TIMEOUT` | 6 | yes | After policy exhaustion |
| `AI_PROVIDER_UNAVAILABLE` | 6 | yes | 5xx, transport, circuit breaker open. Sub-reasons include `CIRCUIT_OPEN`, `CONTEXT_LENGTH` |
| `AI_INVALID_OUTPUT` | 4 | no | Unparseable after repair |
| `AI_SCHEMA_MISMATCH` | 4 | no | Parseable, schema-invalid after repair |
| `AI_REFERENCE_MISMATCH` | 4 | no | Schema-valid, references fabricated or foreign IDs |
| `AI_UNSUPPORTED_ACTION` | 4 | no | Proposed an action type outside the closed set |
| `AI_CLAIM_UNSUPPORTED` | 4 | no | `confirmed_root_cause` without approved direct evidence |
| `AI_CAPABILITY_MISSING` | 6 | no | Flow needs a capability observed as unsupported |
| `AI_BUDGET_EXCEEDED` | 5 | no | Typed partial or inconclusive result accompanies it |
| `AI_TOOL_NOT_ALLOWED` | 4 | no | Flow called a tool outside its allowlist |
| `TOOL_RESULT_UNSAFE` | 7 | no | A tool result carried raw bytes, a data URI, or no redaction stamp. Refused before it could reach the provider (ADR-0008, ADR-0011) |
| `TOOL_RESULT_TOO_LARGE` | 4 | no | A tool result exceeded its size ceiling. Bounded context is what keeps a tool a projection rather than a dump |

### Execution

| Code | Exit | Retryable | Notes |
| --- | --- | --- | --- |
| `EXEC_BROWSER_LAUNCH_FAILED` | 7 | yes | Maps to `INFRASTRUCTURE_FAILED` |
| `EXEC_TARGET_UNREACHABLE` | 7 | yes | Pre-navigation network failure |
| `EXEC_ORIGIN_NOT_ALLOWED` | 7 | no | Navigation outside `safety.allowedOrigins`; maps to `AUTOMATION_FAILED` |
| `EXEC_ACTION_FAILED` | 7 | no | Selector/precondition failure; maps to `AUTOMATION_FAILED` |
| `EXEC_VALUE_UNRESOLVED` | 7 | no | A value the reporter never supplied reached execution: a `described` selector, or a `goto` whose URL is null pending an unknown. Maps to `AUTOMATION_FAILED`, never to a product failure |
| `EXEC_DESTRUCTIVE_BLOCKED` | 7 | no | Destructive action without an approved safety flag |
| `EXEC_RUN_BUDGET_EXCEEDED` | 7 | no | `runWallClockBudgetMs` exceeded; maps to `INCONCLUSIVE` |
| `EXEC_INVESTIGATION_LIMIT` | 7 | no | `maxRunsPerInvestigation` or investigation wall clock |
| `EXEC_INTERRUPTED` | 7 | yes | Signal or lease expiry |
| `EXEC_PRODUCTION_GUARD` | 1 | no | Target classified production, or matched a production origin pattern |

### Evidence and integrity

| Code | Exit | Retryable | Notes |
| --- | --- | --- | --- |
| `EVIDENCE_CATEGORY_MISSING` | 8 | no | A category required by the requested operation is `missing` |
| `EVIDENCE_CORRUPTED` | 9 | no | Parse failed on a present artifact |
| `ARTIFACT_HASH_MISMATCH` | 9 | no | Stored hash disagrees with bytes |
| `MANIFEST_SEAL_INVALID` | 9 | no | Seal hash does not cover the recorded contents |
| `MANIFEST_IMMUTABLE` | 9 | no | Attempted write to a sealed manifest |
| `REDACTION_POLICY_MISSING` | 1 | no | Configured policy file absent or invalid |
| `REDACTION_NOT_APPLIED` | 9 | no | Persistence attempted without a `RedactionStamp`. Fail closed |

### Storage

| Code | Exit | Retryable | Notes |
| --- | --- | --- | --- |
| `STORE_BUSY` | 7 | yes | SQLite busy beyond `busyTimeoutMs` |
| `STORE_APPEND_ONLY_VIOLATION` | 9 | no | Update/delete attempted on an append-only table |
| `STORE_DISK_FULL` | 7 | no | Maps to `INFRASTRUCTURE_FAILED` |

## Partial and inconclusive results are values, not errors

Budget exhaustion inside an AI flow does not always throw. Flows declare whether they can return a
partial result. When they can, the flow returns:

```ts
type FlowResult<T> =
  | { status: "complete"; value: T; warnings: string[]; usage: Usage }
  | { status: "partial"; value: Partial<T>; completedUnits: number; totalUnits: number;
      stopReason: "BUDGET_TOKENS" | "BUDGET_COST" | "BUDGET_TURNS" | "BUDGET_WALLCLOCK" | "BUDGET_TOOL_CALLS";
      warnings: string[]; usage: Usage }
  | { status: "inconclusive"; reason: string; warnings: string[]; usage: Usage };
```

A `partial` result is persisted only for the units that individually passed schema and reference
validation. The CLI exits `5` and prints what was completed and what was not. An `inconclusive`
result exits `10`.

`classify_runs` and `analyze_pass_fail` are partial-capable (they iterate over runs and over
comparison pairs). `intake_to_flow`, `propose_experiments`, `suggest_minimization`, and
`generate_report` are not: a half-formed flow, ranking, reduction plan, or report is worse than
none, so they return `inconclusive`.
