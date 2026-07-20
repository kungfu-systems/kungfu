---
metadata_schema: kungfu.document-metadata/v1
doc_type: architecture-decision
adr_id: ADR-0123
decision_status: accepted
implementation_status: staged
implementation_prs: []
review_state: self-reviewed
sensitivity: public
sources: [local-files, user-consensus]
period: 2026-07-20
theme: action-geometry-domain-profile-separation
confidence: high
evidence_grade: B
last_reviewed: 2026-07-20
---

# ADR-0123: Action Geometry and Domain Profiles are separate semantic layers

- Status: accepted boundary; machine separation and compatibility migration
  remain staged
- Date: 2026-07-20
- Category: KFD-7 / action semantics / Profile boundary
- Related: [ADR-0109](ADR-0109-four-object-agent-work-state-contract.md),
  [ADR-0112](ADR-0112-backend-neutral-fact-cut-kernel.md),
  [ADR-0119](ADR-0119-recoverable-action-loop-coordination-contract.md), and
  [ADR-0120](ADR-0120-kfd7-library-boundary-and-successor-abi.md)

## Context

Kungfu currently uses "Profile" for two different responsibilities:

- the cross-domain KFD-7 structure that keeps Fact, Episode, Pursuit, Atlas,
  and Warrant responsibilities independently addressable; and
- the Agent Work vocabulary, lifecycle states, defaults, evidence policy, and
  presentation implemented over that structure.

The current `work_profile.py`, action schema, and public commands combine these
responsibilities in one first executable slice. That was useful for dogfood,
but it makes a first-party Agent Work policy look like the universal structure
and makes future trading, operations, research, or personal-work adopters
appear to require the same fields and lifecycle.

## Decision

### 1. Action Geometry is the cross-domain layer

**Action Geometry** owns the stable separation and relationships among:

- admitted Fact state and causal Episode experience;
- direction through Pursuit;
- perspective through Atlas;
- bounded authority through Warrant;
- the invariants that prevent one responsibility from silently substituting
  for another; and
- conservative projection to and from a simple session.

Pursuit, Atlas, and Warrant are Action Primitives or responsibility roles.
They are not Profiles. Fact and Episode remain runtime substrates with their
existing authorities.

The machine-readable artifact for this layer is an **Action Geometry
Contract**. Its exact identity is exposed as `actionGeometryRoot`.

### 2. Domain Profiles specialize the geometry

A **Domain Profile** owns adopter-specific:

- fields and role-body schemas;
- lifecycle vocabulary and transition rules;
- validation, defaults, and success policy;
- presentation and progressive disclosure;
- evidence obligations, residual risk, and domain non-claims.

The first-party Agent Work model is one Domain Profile over Action Geometry.
Mission Control, trading, research, and future products may define different
Domain Profiles without redefining the five responsibility boundaries.

A machine-readable Domain Profile exposes `domainProfileRoot` and exact
per-role `roleSchemaRoots`. Domain states may refine or map to base geometric
observations, but they cannot redefine what direction, perspective, authority,
state, or occurrence mean.

### 3. Authority remains below both layers

Neither an Action Geometry Contract nor a Domain Profile may:

- mint Fact or Episode authority;
- write private journal, CAS, or content-store layouts;
- turn a relation into semantic inheritance;
- treat a successful call or sealed Episode as completion; or
- introduce a second storage or receipt authority.

They use public Fact, Episode, query, receipt, and ActionBinding interfaces.

### 4. Existing identities are not reinterpreted

The current identifiers, including `kungfu.kfd7.profile-role/v1`,
`kungfu.kfd7.profile-action/v1`, `kungfu-kfd-7-action-profile`, and
`kfd7.profile.<role>`, remain compatibility names for the combined v1 slice.
Their persisted roots and accepted receipts keep their original meaning.

The migration adds separately versioned geometry and Domain Profile contracts.
A semantic encoding change requires a successor schema or protocol tag,
preserved legacy readers, explicit mapping, and differential evidence. It must
not silently relabel an existing root.

### 5. The current implementation is transitional

`kungfu.agent.work_profile` remains the compatibility entry until the staged
implementation splits:

1. a domain-neutral Action Geometry contract, evaluator, and discovery
   identity;
2. an Agent Work Domain Profile manifest with exact role schemas and lifecycle
   rules; and
3. compatibility adapters that preserve current CLI, Python, Node, Agent, GUI,
   object, receipt, and replay behavior.

No code move is justified merely by the terminology change. The split proceeds
only with characterization and compatibility evidence.

## Qualification

The separation is qualified only when:

- Action Geometry invariants run without importing Agent Work field names or
  lifecycle vocabulary;
- every Domain Profile binds one exact `actionGeometryRoot`, its own
  `domainProfileRoot`, and all required `roleSchemaRoots`;
- the Agent Work Domain Profile preserves current positive and negative
  fixtures, roots, receipts, public commands, and recovery behavior;
- session round-trip refinement and context-insufficiency checks remain valid;
- a Domain Profile cannot weaken role separation or obtain Fact/Episode
  authority; and
- legacy combined-v1 objects remain readable without reinterpretation.

## Consequences

Kungfu gains one stable cross-domain action structure while domains retain
freedom over vocabulary and workflow. Agents can tell whether a claim is about
the universal geometry or one adopter's policy by inspecting exact roots.

The cost is an explicit compatibility period. Existing "Profile" names cannot
be mass-renamed, and the implementation must carry a legacy adapter until
packaged products and retained data prove the split.
