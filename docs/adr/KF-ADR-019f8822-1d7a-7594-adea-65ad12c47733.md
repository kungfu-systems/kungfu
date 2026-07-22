---
metadata_schema: kungfu.document-metadata/v1
doc_type: architecture-decision
adr_id: KF-ADR-019f8822-1d7a-7594-adea-65ad12c47733
decision_status: accepted
implementation_status: staged
implementation_prs: [https://github.com/kungfu-systems/kungfu/pull/1222]
qualification_refs: [framework/profile/kungfu-domain-profile-authoring.contract.json, framework/work-lifecycle/kungfu-work-lifecycle-operation-matrix.contract.json, scripts/check-domain-profile-authoring.test.mjs, scripts/check-work-lifecycle-operation-matrix.test.mjs, tests/fixtures/domain-profile-authoring/course-production/package.json]
review_state: self-reviewed
sensitivity: public
sources: [local-files, user-consensus]
period: 2026-07-22
theme: domain-profile-authoring-contract
confidence: high
evidence_grade: B
last_reviewed: 2026-07-22
ai_provenance: GPT-5 via Codex on 2026-07-22; based on the accepted Action Geometry, KFX lifecycle, Fact and Episode, and Project Cut decisions plus the staged authoring contract and Course Production fixture; does not claim unobserved installed-product or four-language runtime parity
---

# KF-ADR-019f8822-1d7a-7594-adea-65ad12c47733: Domain Profile authoring is declarative, qualified, and Core-neutral

- Status: accepted; authoring contract and reference package staged
- Date: 2026-07-22
- Category: KFX / Domain Profile / third-party extension
- Related: [ADR-0089](ADR-0089-transactional-kfx-package-and-lifecycle-authority.md),
  [ADR-0097](ADR-0097-project-cut-spacetime-and-publication-boundary.md),
  [ADR-0112](ADR-0112-backend-neutral-fact-cut-kernel.md),
  [ADR-0123](ADR-0123-action-geometry-domain-profile-separation.md),
  [ADR-0125](ADR-0125-fact-episode-ontology-and-action-geometry.md), and
  [ADR-0127](ADR-0127-project-cut-centered-product-loop.md)

## Context

Kungfu already separates cross-domain Action Geometry from first-party Agent
Work vocabulary and owns KFX package lifecycle below language bindings. That
separation is incomplete as a public extension model if a third party must edit
or recompile Core, copy an internal Profile, or rely on one language-specific
installer to introduce a new domain.

An authoring format that only lists schemas is also insufficient. A Domain
Profile affects responsibility mapping, valid operations, Claim, Assessment,
Decision, and Admission policy, settlement, migration, and Cut projection. If
those declarations are not rooted and qualified together, an apparently
compatible package can silently fuse roles, claim authority it does not own, or
change the meaning of retained Work during upgrade.

## Decision

### 1. One public declaration owns the complete domain delta

A Domain Profile package declares its identity and schema versions, package and
dependency closure, capabilities and compatibility, domain objects and
relations, responsibility mappings, workflows and operations, policy surfaces,
settlement and Cut projection, and migration graph. Hashes bind the package,
Profile, members, schemas, policies, registries, permissions, qualification,
and compatibility material as one inspectable closure.

The declaration is the language-neutral authority for generated or projected
C++, Python, Node.js, Rust, CLI, Agent, GUI, and TUI surfaces. A binding or user
interface may expose fewer operations according to capability and authority,
but it cannot invent different object identity, lifecycle, or policy semantics.

### 2. Authoring and runtime lifecycle are explicit and receipt-bearing

The public lifecycle distinguishes `inspect`, `validate`, `register`,
`qualify`, `install`, `activate`, `deactivate`, `upgrade`, `rollback`, `export`,
and `import`. Each mutation remains subject to the transactional KFX package
authority in ADR-0089: exact inputs, current-state or expected-plan fencing,
authorization, apply, and a durable receipt.

Registration does not imply qualification, installation does not imply
activation, and process availability does not imply semantic authority. Export
and import preserve identity and retained interpretation; they do not mint a
new Profile or rewrite historical Fact, Episode, receipt, or Cut identities.

### 3. Domain extension cannot widen Core authority

A Domain Profile may define adopter-specific objects, fields, relationships,
states, operations, and presentation. It maps those semantics onto separately
inspectable Fact, Episode, Pursuit, Atlas, and Warrant responsibilities without
fusing them. It may require Claim, Assessment, Decision, and Admission policy,
but no convenience workflow may collapse those responsibilities into one
self-approving actor.

A normal Profile cannot redefine Fact or Episode identity or time semantics,
write private journal or content-store layouts, obtain undeclared native
mutation authority, bypass Warrant or Admission, or promote a proposed
cross-domain primitive into Core. Such a primitive requires separate KFD
discovery and qualification evidence.

### 4. Admission is fail closed and migration is compatibility-bound

Validation or activation refuses at least role fusion, undeclared authority,
self-dependency cycles, schema or root drift, incompatible migration, and
unsigned or unqualified packages. Upgrade requires an explicit compatible path
through the migration graph. Rollback selects retained qualified roots and
cannot reconstruct or reinterpret old content.

Unknown required capability, missing dependency material, ambiguous Cut
projection, or unavailable historical interpreter evidence is a typed refusal,
not a best-effort activation.

### 5. A non-software reference Profile is qualification evidence

The Course Production fixture demonstrates that the contract can express a
domain outside software delivery through declarations alone. It is a hash-closed
authoring package used to test identity, dependency closure, responsibility
mapping, workflow, policy, migration, and qualification checks.

The fixture is not represented as signed, qualified, installable, or active.
It does not prove the later native runtime, installed-product, four-language,
clean-home recovery, or cross-platform qualification stages.

## Falsification and qualification

This decision is false if a third-party domain requires a Core-specific symbol
or branch, if two official language projections disagree on rooted semantics,
if an unqualified package can activate, if upgrade can reinterpret retained
Work without an admitted migration, or if a Profile can mint Fact, Episode, or
Project Cut authority.

The staged qualification checks the complete declaration, negative admission
cases, hash closure, a non-software reference package, generated documentation,
and the public Work lifecycle operation inventory. Later deliveries must prove
native runtime behavior, all four language bindings, packaged-product
installation, clean-runtime recovery, and hosted cross-platform parity before
those capabilities are claimed complete.

## Consequences

- Third parties receive one auditable, transportable authoring surface instead
  of a Core fork or language-specific plugin convention.
- Core remains responsible for identity, authority, transaction, storage, and
  receipt invariants while domains remain free to define their own vocabulary.
- The product must maintain schema and migration compatibility across generated
  language and interface projections.
- Current authoring evidence is intentionally narrower than runtime and
  distribution completion; those gaps remain visible in the operation matrix.
