---
metadata_schema: kungfu.document-metadata/v1
doc_type: architecture-decision
adr_id: KF-ADR-019f8fb8-579b-78d5-9ebb-da03bb9aa40c
decision_status: accepted
implementation_status: staged
implementation_prs: [https://github.com/kungfu-systems/kungfu/pull/1363]
qualification_refs: [framework/incubation/incubation-passport.contract.json, framework/incubation/incubation-passport.registry.json, framework/incubation/incubation-passport.baseline.json, framework/incubation/schema/incubation-passport-contract-v1.schema.json, framework/incubation/schema/incubation-passport-registry-v1.schema.json, scripts/check-incubation-passport.mjs, scripts/check-incubation-passport.test.mjs, tests/fixtures/incubation-passport/cases.json, docs/architecture/incubation-passport-governance.md, docs/architecture/work-events-schema-ownership-migration.md]
review_state: self-reviewed
sensitivity: public
sources: [architecture-decisions, local-files, user-consensus]
period: 2026-07-23
theme: incubation-passport-governance
confidence: high
evidence_grade: B
last_reviewed: 2026-07-23
ai_provenance: GPT-5 via Codex on 2026-07-23; based on the accepted Assignment, repository authorities, contracts, implementations, and fixtures; future L5 admission implementations and unobserved external adopters are not claimed
---

# KF-ADR-019f8fb8-579b-78d5-9ebb-da03bb9aa40c: Incubation passports decide temporary anchors and destined authority

- Status: accepted; implementation staged for protected review
- Date: 2026-07-23
- Related: [ADR-0047](ADR-0047-authoritative-facts-hana-pod-or-flatbuffers.md),
  [ADR-0112](ADR-0112-backend-neutral-fact-cut-kernel.md),
  [ADR-0120](ADR-0120-kfd7-library-boundary-and-successor-abi.md), and
  [ADR-0121](ADR-0121-portable-fact-root-canonical-encoding.md)

## Context

Kungfu permits useful capabilities to incubate in Python, TypeScript,
extensions, source slices, or provisional schema locations before their final
native owner exists. That lowers the cost of discovering the right domain
shape, but without a birth-time ownership decision the temporary location can
silently become authority.

Three recurring costs expose the missing control:

- a persistent fact schema can exist outside the one-owner registry until a
  later architecture audit discovers it;
- a script can own both domain logic and durable byte or Root identity, making
  native admission a historical rewrite; and
- an identity protocol can ship from one implementation without shared golden
  vectors, making cross-language convergence unverifiable.

ADR-0047 already requires one Hana or FlatBuffers owner for persistent
structured facts. ADR-0121 already requires independent implementations and
golden vectors for KFR2. The missing decision is how every incubating object
declares those obligations before the temporary implementation expands.

## Decision

Kungfu introduces a versioned **Incubation Passport** for objects whose current
location is not necessarily their destined authority.

Every passport declares at birth:

1. a current `runtime` or `git` anchor and its exact authority reference;
2. the destined layer, owner, and future admission Assignment;
3. the structured-fact schema owner, if any;
4. the persistent-byte authority and the bounded role of scripts;
5. whether it mints a Root or identity preimage; and
6. an admission trigger plus a deadline for bounded runtime incubation.

### Schema and byte authority

Hana and FlatBuffers schema identities resolve through
`framework/core/schema-authority.json`. A Domain Profile may name its versioned
contract world as the owner of its fact-surface definitions, but JSON remains
an edge or contract representation rather than a second journal authority.

Runtime-anchored persistent facts use the native journal. Scripts may own
orchestration, validation, folds, and projections; they do not own persistent
bytes or identity.

### Root protocol admission

Any passport that mints a durable Root or identity preimage requires at least
two independent implementation languages and committed golden vectors before
admission. A binding over the same implementation does not count as an
independent implementation.

### Exact baseline

Pre-existing violations may be admitted only through an exact baseline entry
with an owner, rationale, expiry date, and removal condition. A new issue, a
stale entry, or an expired entry fails the source gate. The baseline is not a
pattern waiver and cannot absorb future files.

### Historical boundary

Passport registration is additive. It never migrates, reinterprets,
recalculates, or aliases sealed evidence. An owner move is a separate admission
that must preserve exact schema bytes, journal frames, Roots, receipts, and
historical readers.

## Initial registrations

The initial registry records:

- KFR2 as the admitted positive reference protocol;
- the Work journal and Initiative/Assignment L3 runtime as incubating
  Root-bearing objects;
- Atlas, Rewind, and Work FlatBuffers schemas at their current registered Git
  anchors; and
- a plan-only future owner move for `work_events.fbs`.

The initial exact baseline contains five pre-existing demo, fuzz, or fixture
schema files outside production schema authority and two incubating Root
protocols that still lack a second implementation and shared vectors.

## Consequences

- New schemas and Root protocols fail at the same source gate that reviews the
  implementation, rather than surfacing as later archaeology.
- Runtime incubation has an explicit end condition and cannot remain silently
  overdue.
- Python-first or extension-first discovery remains available, but it no
  longer grants persistent byte authority by accident.
- The registry and baseline add maintenance work; exact stale-entry failure
  makes debt removal explicit rather than leaving dead waivers behind.
- Future L5 Initiative/Assignment admission must reuse a native service,
  versioned C ABI, cross-language conformance, byte/Root parity, and no-rewrite
  harness. This ADR does not claim that future admission is implemented.

## Falsifiers

This decision is violated if a new tracked schema lacks an owner, if a
Root-minting object is admitted from one implementation language or without
golden vectors, if a runtime passport passes after its deadline, if scripts
become persistent-byte authority, or if an owner move changes sealed bytes or
Roots.
