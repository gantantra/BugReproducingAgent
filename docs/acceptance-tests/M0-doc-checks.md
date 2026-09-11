# M0 Documentation and Schema Invariants

Status: M0 frozen candidate
Enforced from: M1 (as `/tests/docs/*.test.ts` in CI)

## Governing principle

Playwright produces evidence. Deterministic software normalizes and measures evidence. DeepSeek interprets and prioritizes evidence. Humans authorize consequential transitions.

## Checks

| ID | Check | Failure meaning |
| --- | --- | --- |
| M0-AT-1 | The governing principle appears **verbatim** in `CLAUDE.md`, `docs/architecture/overview.md`, and every ADR whose front-matter `touches` includes `execution`, `evidence`, or `ai` | The architectural contract has been diluted or a new ADR skipped it |
| M0-AT-2 | Every `schemas/*.json` parses as JSON and validates as a JSON Schema (2020-12) | A schema is malformed and cannot be enforced |
| M0-AT-3 | Every schema declares `$id` and `$schema`, and `additionalProperties: false` (or `unevaluatedProperties: false` where conditional subschemas apply) on every object-typed subschema. Every **record** schema additionally declares a `schemaVersion` property with a `const` value | Strictness or versioning has been lost |
| M0-AT-3a | The five schemas exempt from the `schemaVersion` rule are exactly `common.v1.json` and `action.v1.json` (definition/embedded schemas with no independent identity), `config.v1.json` (validates a user-authored file), `flow-artifact.v1.json` (versioned by its own `version` field), and `redaction-policy.v1.json` (versioned by `policyVersion`). A sixth exemption appearing without an ADR is a failure | The versioning rule is being eroded one exemption at a time |
| M0-AT-4 | Every relative path referenced in a `docs/**/*.md` fenced path or backticked path that looks like a repository path resolves to an existing file or directory | Documentation references something that does not exist |
| M0-AT-5 | Every frozen decision (1–6) is traceable to a named document section, listed in `docs/FREEZE-M0.md` | A frozen decision has no home and can drift |
| M0-AT-6 | Every ADR has front-matter with `id`, `status`, `date`, `touches`, `decision`, `consequences`, and a `Governing principle` section when `touches` includes execution, evidence, or AI | ADRs are not uniformly auditable |
| M0-AT-7 | Every milestone document `M0`–`M8` contains all nine required sections: entry criteria, scope, out of scope, interfaces touched, exit criteria, acceptance tests, eval gates, demo command, risks | A milestone is under-specified |
| M0-AT-8 | Every `CaptureStatus` category named in `docs/architecture/capture-completeness.md` appears in `schemas/capture-status.v1.json` as a required property, and vice versa | Docs and schema disagree about evidence categories |
| M0-AT-9 | Every finding level named in `docs/architecture/evidence-reference-model.md` appears in the `level` enum of `schemas/finding.v1.json`, and vice versa | The level ladder can drift between prose and enforcement |
| M0-AT-10 | Every tool named in `docs/architecture/tool-allowlists.md` appears in exactly one flow allowlist table row and in the tool specification section | A tool exists with no allowlist or no specification |
| M0-AT-11 | Every error code in `docs/architecture/error-taxonomy.md` has a unique name and a declared exit code within the CLI contract's documented range | The error taxonomy and the CLI contract disagree |
| M0-AT-12 | Every `RunOutcome` / `JobTerminalReason` combination listed as legal in `docs/architecture/queue-model.md` matches the `CHECK` constraints in the migration SQL, and every illegal one is rejected | The two-dimensional invariant exists only in prose |

## Notes on enforcement

- M0-AT-1 is a literal substring match. The sentence is checked character-for-character, including
  the four full stops, because a paraphrase is exactly the drift the check exists to catch.
- M0-AT-4 is deliberately heuristic: it checks backticked strings containing `/` and a known
  repository prefix (`docs/`, `schemas/`, `packages/`, `apps/`, `ai/`, `eval/`, `tests/`,
  `policies/`). A false positive is fixed by rewording the reference; the check never fails open.
- M0-AT-8, M0-AT-9, M0-AT-10, M0-AT-11, and M0-AT-12 are bidirectional. One-way checks let the
  code grow a value the docs do not mention, which is how vocabularies rot.
- These checks run in the same CI job as the reliability gate, so a documentation regression cannot
  land while the gate is green.
