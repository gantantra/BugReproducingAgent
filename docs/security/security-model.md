# Security and Privacy Model

Status: M0 frozen candidate (frozen decision 6)

## Governing principle

Playwright produces evidence. Deterministic software normalizes and measures evidence. DeepSeek interprets and prioritizes evidence. Humans authorize consequential transitions.

## Trust boundaries

```
+---------------------------------------------------------------+
| Local machine, single trusted OS user                         |
|                                                               |
|  +------------------+     +---------------------------------+ |
|  | .investigator/   |     | investigate process             | |
|  | db, artifacts    |<--->| bounded raw evidence in memory  | |
|  | ALL REDACTED     |     | UNREDACTED, transient           | |
|  +------------------+     +----------------+----------------+ |
|                                            |                  |
+--------------------------------------------|------------------+
                                             |
        +------------------------+           |          +------------------+
        | Application under test |<----------+--------->| DeepSeek API     |
        | (authorized test env)  |  browser            | normalized,      |
        |                        |                     | redacted facts   |
        +------------------------+                     +------------------+
```

Three boundaries matter:

1. **Process memory -> durable storage.** Crossed only through redaction. Fail closed.
2. **Local -> provider.** Crossed only by normalized, redacted, schema-validated tool facts and
   flow prompts. Never raw artifacts.
3. **Agent -> application under test.** Crossed only by the closed action vocabulary, within the
   origin allowlist, under environment classification rules.

## Assets

| Asset | Sensitivity | Where it lives |
| --- | --- | --- |
| `DEEPSEEK_API_KEY` | Critical | Environment variable only, transiently in a header |
| Application credentials for the test target | High | Environment variables, applied at run time; resulting storage state redacted before persistence |
| Session tokens, cookies, auth headers observed in traffic | High | Bounded process memory; redacted before persistence |
| PII in page content and response bodies | High | Bounded process memory; redacted before persistence |
| Evidence artifacts (traces, video, DOM, network logs) | Medium after redaction | `.investigator/investigations/*/artifacts/` |
| Manifests, lineage, approvals, AI ledger | Low, integrity-critical | `investigator.db` |
| Prompts and flow artifacts | Low | `/ai/flows/` in the repository |

## Secret handling

Frozen decision 6: `DEEPSEEK_API_KEY` from environment only. Never logged, never persisted, never
written to artifacts.

Mechanics:

- Access is only through `SecretStore.reveal`, returning a branded `Secret`.
- `Secret.toString()`, `Secret.toJSON()`, and the Node inspect symbol all return `[redacted]`.
  Tested against template interpolation, `JSON.stringify`, `console.log`, `util.inspect`, and
  error serialisation.
- The raw value is unwrapped only inside the `Authorization` header construction in the DeepSeek
  adapter, is not assigned to any variable that outlives the call, and is never placed in an object
  that could be serialised.
- `InvestigatorError.context` accepts only JSON primitives by type signature, which blocks the most
  common accidental-leak path (dumping a request object into an error).
- Config stores the *variable name* (`apiKeyEnv`), not an `env:` reference, so the key never enters
  the resolved config object that `investigate doctor` prints.
- Application credentials follow the same path. Config never contains a credential value; only a
  variable name.

## Redaction boundary

Raw sensitive evidence may exist only in bounded process memory during collection and
transformation. It must be redacted before durable persistence, provider transmission, normalized
indexing, diagnostic logging, report generation, or any artifact export. Buffers are released after
processing. The agent disables its own crash-dump, heap-snapshot, and verbose-log paths that would
persist unredacted in-process data. OS-level paging and kernel mechanisms are documented as
residual risk in the security model.

### Concretely

| Boundary | Enforcement |
| --- | --- |
| Durable persistence | `ArtifactStore.put` and every `MetadataTx.insert*` require a `RedactionStamp` parameter. There is no overload without it. Missing stamp is `REDACTION_NOT_APPLIED`, exit 9 |
| Provider transmission | `ai-gateway` accepts only `ToolResult` objects and flow-artifact prompt text. A test asserts that no code path passes an artifact stream or a raw event into `LlmRequest` |
| Normalized indexing | The index is built from already-redacted normalized records; the builder takes redacted types only |
| Diagnostic logging | The logger passes every field through the redactor. `logging.redactLogs: false` is rejected at config load. `--verbose` increases *structure*, never sensitivity |
| Report generation | The renderer reads validated findings and redacted evidence projections only |
| Artifact export | `investigate export` re-runs redaction verification over every included artifact and fails the export on any hit |

### Bounded memory

- Raw response bodies are capped at `capture.responseBodyMaxBytes` at read time; the cap is applied
  while streaming, so an oversized body is never fully materialised.
- Raw buffers are explicitly released after transformation (reference dropped, and for large
  buffers, zero-filled before release where the buffer is ours to zero).
- The collector applies collection-time redaction for fields decidable without whole-run context
  (cookie values, `Authorization`/`Proxy-Authorization`/`Set-Cookie` headers, configured query
  parameter names, `localStorage` values under configured key patterns), so those never reach a
  buffer that outlives the event.

### Self-inflicted persistence paths, disabled

| Path | Action |
| --- | --- |
| Node crash dumps / core dumps | `--report-on-fatalerror`, `--report-on-signal`, `--report-uncaught-exception` are not enabled; `NODE_OPTIONS` is inspected at startup and a warning is emitted if a diagnostic-report or heap-snapshot flag is present |
| Heap snapshots | No code path calls `v8.writeHeapSnapshot`; `--heapsnapshot-near-heap-limit` presence in `NODE_OPTIONS` triggers a startup warning |
| Playwright verbose logs | `DEBUG=pw:*` produces unredacted protocol traffic. Startup detects a `DEBUG` value matching `pw:` and refuses to run unless `--allow-unsafe-debug` is passed, which also marks the workspace and every manifest produced in that session as `unsafeDebug: true` |
| Trace/video | These are *intended* artifacts, and they are the highest-risk ones. Trace contains network bodies and DOM. Redaction is applied to the trace content pipeline before the trace is moved into the artifact store; where the trace format prevents field-level redaction, the trace is either withheld (`captureStatus.trace = "redacted"`) or retained only under an explicit config opt-in that records the decision. See the redaction policy document |
| Temp directories | Per-run temp profile deleted in the run `finally` block; a startup sweep removes orphans from prior crashes |
| Shell history | The CLI never accepts a secret as an argument. There is no `--api-key` flag |

### Residual risks, stated plainly

1. **OS paging and swap.** Unredacted evidence in process memory may be written to swap or a
   hibernation file by the kernel. Not mitigable from userland Node. Mitigation is operational:
   run on a machine with an encrypted disk.
2. **Kernel/hypervisor memory capture.** Out of scope.
3. **Local user with filesystem access.** Artifact access is local-user only; anyone who can read
   the workspace can read the redacted evidence, and anyone who can write it can tamper with the
   database. The lineage hash chain and artifact hashes make tampering *detectable*, not
   impossible.
4. **Redaction is pattern- and policy-based.** A novel secret format not covered by the policy may
   survive into persisted evidence. Mitigated by strict-mode default (unknown-shape data treated
   as sensitive) and by policy fuzzing in M8, not eliminated.
5. **The application under test.** The agent can only redact what it can see and classify. A page
   that renders a secret as ordinary body text will have it captured as text and redacted only if
   it matches a policy rule.

## Access control

Role-based artifact access is out of MVP scope. Artifact access is local-user only.

Workspace files are created with restrictive permissions where the platform supports it (`0o700`
on directories, `0o600` on `investigator.db` and artifacts on POSIX). On Windows, inherited ACLs
apply and no additional hardening is performed in MVP; this is recorded as a known limitation.

## Retention

Configurable retention and cleanup for the local workspace. See
`docs/architecture/test-data-and-side-effects.md` for the mechanics and
`docs/security/redaction-policy.md` for what survives.

Defaults: artifacts 30 days, reproducer packages retained indefinitely, manifests/lineage/
approvals/AI ledger retained indefinitely. Deletion writes a tombstone so a later
reference-validation failure is explainable as expiry rather than fabrication.

## Destructive actions and production impact

Destructive actions require explicit approval and per-sequence safety flags. Execution budgets,
stop conditions, and production-impact guards are specified in
`docs/architecture/test-data-and-side-effects.md`. Summary of the seven guards:

1. `production` classification rejected at config load.
2. `productionOriginPatterns` rejected at navigation time.
3. Origin allowlist enforced at navigation.
4. Destructive actions require per-sequence acknowledged approval with justification.
5. `remote-write` requires a declared reset strategy.
6. No AI-generated code is executed; the action vocabulary is closed.
7. Reset scripts are human-authored files, referenced by path.

## Prompt injection

Page content is untrusted input. It reaches the model only as normalized, redacted,
schema-validated tool results with fixed field names, never as free-form text presented as
instructions. Tools are read-only and allowlisted per flow. Every claim is reference-validated
against the store, so a page instructing the model to assert a false fact cannot produce a
persisted finding. Tool-call and evidence-byte budgets bound the blast radius of a model that has
been steered into pathological querying.

The residual exposure is *influence on interpretation*: a page whose content suggests a wrong
conclusion may shift the model toward it. Validation confines the damage to a claim built from
correctly cited facts, and the level ladder plus gate 2 and gate 3 put a human in the path before
that claim becomes a deliverable.

## Threat-model summary

| Threat | Mitigated? | By what |
| --- | --- | --- |
| Credential exfiltration via logs/artifacts | Yes | Branded `Secret`, redaction, primitives-only error context, explicit tests |
| PII persisted in evidence | Largely | Collection-time and stage-3 redaction, fail-closed persistence, strict default |
| PII sent to the provider | Yes | Only redacted tool facts cross the boundary; export/transmission verification |
| Damage to a shared environment | Largely | Seven production-impact guards |
| Arbitrary code execution from model output | Yes | Closed action vocabulary, no `eval`, no model-supplied page scripts |
| Fabricated evidence in a deliverable | Yes | Seven-check reference validation, no persistence on failure |
| Evidence tampering | Detectable | Artifact hashes, manifest seal, lineage hash chain |
| Memory-resident evidence reaching disk via the OS | No | Documented residual risk; operational mitigation only |
