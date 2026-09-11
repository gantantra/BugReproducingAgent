---
id: ADR-0020
title: Zod as the authoring source with JSON Schema emitted and committed
status: accepted
date: 2026-09-10
touches: [core, ai]
decision: Author every domain schema once in Zod for inferred TypeScript types, emit strict JSON Schema into /schemas as committed build output, validate persisted records and AI outputs against the emitted schema with Ajv, and fail CI if the emitted output drifts from the authored source.
consequences: One source of truth serves TypeScript types, runtime validation, and provider structured output, at the cost of an emission step and Zod-to-JSON-Schema fidelity constraints.
---

# ADR-0020 — Zod authoring, JSON Schema emission

## Governing principle

Playwright produces evidence. Deterministic software normalizes and measures evidence. DeepSeek interprets and prioritizes evidence. Humans authorize consequential transitions.

## Context

Three consumers need the same schema:

1. TypeScript, for compile-time types across ten packages.
2. A runtime validator, for every persisted record and every AI output, strict, with unknown-field
   rejection (ADR-0015).
3. The provider, as a JSON Schema for structured output where `jsonMode` is supported (ADR-0009).

Maintaining these separately guarantees they diverge, and the divergence would appear as a
validation failure on a correct model output, or worse, as an accepted output the types say is
impossible.

## Decision

- **Author in Zod.** Each domain schema is one Zod object in `packages/core/src/schemas/`, with
  `.strict()` applied so unknown keys are rejected, and TypeScript types derived by `z.infer`.
- **Emit JSON Schema** into `/schemas/<name>.v<major>.json` as committed build output, with `$id`,
  `$schema` (2020-12), a `const` `schemaVersion`, and `additionalProperties: false` on every
  object subschema.
- **Validate with Ajv in strict mode** against the emitted JSON Schema, not against the Zod object.
  This is deliberate: the artifact that is validated against is the same artifact sent to the
  provider and the same artifact a future reader will consult. Validating against Zod while
  shipping JSON Schema would leave two behaviours to reconcile.
- **Commit the emitted output** and fail CI if regeneration produces a diff. The emitted schemas
  are reviewable in PRs, and historical versions stay in the repository so old records remain
  interpretable.
- **Emission is checked, not trusted.** A CI test round-trips representative valid and invalid
  fixtures through both the Zod object and the emitted JSON Schema and asserts identical accept and
  reject verdicts. Any construct where the two disagree is banned from the authoring layer.

## Constraints this places on authoring

Zod features whose JSON Schema translation is lossy or ambiguous are not used in domain schemas:
transforms, refinements that cannot be expressed as JSON Schema keywords, `z.custom`, branded types
inside the serialised shape, and preprocessing. Cross-field rules that JSON Schema cannot express
(for example `heartbeatMs < leaseMs / 3`) live in an explicit assertion layer that runs after
schema validation, and each such rule has its own test.

This is a real restriction, and it is the price of having one artifact serve all three consumers.

## Alternatives considered

| Alternative | Why rejected |
| --- | --- |
| Author JSON Schema by hand, derive TS types | Verbose, error-prone, and types drift from the hand-written source |
| Zod only, no JSON Schema | No language-neutral versioned contract; nothing to send as provider structured output |
| JSON Schema only, no static types | Loses compile-time safety across ten packages |
| Author in both, keep in sync manually | Guaranteed divergence |
| TypeBox | Viable and JSON-Schema-native; rejected because Zod ergonomics are better for the validation-heavy application layer and the emission gap is closed by the round-trip test |

## Consequences

Positive: one authoring source; inferred types; a committed, reviewable, versioned JSON Schema for
runtime validation and provider structured output; drift caught by CI; historical schema versions
preserved.

Negative: an emission step in the build; a banned-construct list in the authoring layer; and
cross-field validation in a separate layer with its own tests rather than inline in the schema.
