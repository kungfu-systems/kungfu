# Fact, Episode, and Action Primitive Runtime

Status: qualified shadow implementation. [KF-ADR-019f86da-4f90-7c45-8d95-3745dcbbff1c](../adr/KF-ADR-019f86da-4f90-7c45-8d95-3745dcbbff1c.md) owns the accepted generic
Fact identity, relation, Cut, ref, CAS, and receipt contract. One retained
three-process dogfood now proves independent role identities, a sealed
successor Cut, no-chat review, and clean-runtime continuation. This document
organizes that contract with the wider action model; it does not replace its
authority or claim authority cutover or P17 release qualification.

## Authority and scope

The sources of authority remain:

- [KF-ADR-019f86da-4f90-786d-aa24-a97705e13917](../adr/KF-ADR-019f86da-4f90-786d-aa24-a97705e13917.md) for the
  accepted combined-v1 product rule that Pursuit, Atlas, Warrant, and Episode
  remain independently addressable;
- [KF-ADR-019f86da-4f90-7cb5-b65c-b463768e7ae8](../adr/KF-ADR-019f86da-4f90-7cb5-b65c-b463768e7ae8.md) for
  the current distinction between the Fact-Episode Ontology and the three
  Action Geometry Primitives;
- [KF-ADR-019f86da-4f90-7c45-8d95-3745dcbbff1c](../adr/KF-ADR-019f86da-4f90-7c45-8d95-3745dcbbff1c.md) and
  [`kungfu-fact-cut-kernel.contract.json`](../../framework/core/fact/kungfu-fact-cut-kernel.contract.json)
  for the accepted domain-neutral Fact object, version, relation, Cut, ref,
  CAS, receipt, ownership, and failure contract;
- [`kungfu-agent-work-state.contract.json`](../../framework/work/agent-work/kungfu-agent-work-state.contract.json)
  for current machine definitions, implementation mappings, invalid
  inferences, and qualification status;
- [KF-ADR-019f86da-4f90-791c-9b90-4888cca36327](../adr/KF-ADR-019f86da-4f90-791c-9b90-4888cca36327.md) and its follow-up
  decisions for Episode identity, manifests, sealing, and bundles;
- [KF-ADR-019f86da-4f90-7d81-90a0-d144fc27fe03](../adr/KF-ADR-019f86da-4f90-7d81-90a0-d144fc27fe03.md) for
  Fact admission and trust eligibility;
- [KF-ADR-019f86da-4f90-7a58-80ea-4666cc94397f](../adr/KF-ADR-019f86da-4f90-7a58-80ea-4666cc94397f.md)
  through [KF-ADR-019f86da-4f90-7b89-895f-21b4008bc732](../adr/KF-ADR-019f86da-4f90-7b89-895f-21b4008bc732.md) for
  Xinfa Atlas, Project Cut, source projection, and Git Episode boundaries; and
- the published KFD Candidates for the non-normative generative hypotheses:
  [cross-domain action primitives](https://kfd.libkungfu.dev/drafts/action-state-separation/),
  [Atlas action perspective](https://kfd.libkungfu.dev/drafts/atlas-action-perspective/),
  [Pursuit intent continuity](https://kfd.libkungfu.dev/drafts/pursuit-intent-continuity/),
  and [Warrant bounded authority](https://kfd.libkungfu.dev/drafts/warrant-bounded-authority/).

KFD owns principles, generation mechanisms, qualification questions, and
falsifiers. Kungfu owns this product's storage, runtime, migration,
projection, and release design. This page is the current integration map
between those boundaries, not a second semantic registry or a release claim.

## Design thesis

KFD-7 names the semantic foundation the **Fact-Episode Ontology**:

- **Fact** preserves admitted state under an explicit cut.
- **Episode** preserves realized causal occurrence across cuts.

Kungfu realizes that ontology through two runtime substrates: journal-backed
Fact admission/query and Episode lifecycle/replay. "Runtime substrate" is the
implementation term; it does not replace the normative ontology.

Three cross-domain action roles are then expressed over Facts:

- **Pursuit** preserves intent continuity and success conditions.
- **Atlas** preserves the perspective, sources, and cut used to understand the
  next action.
- **Warrant** preserves the bounded authority under which that action may
  occur.

The action loop is:

```text
Fact cut
  -> select or revise Pursuit
  -> declare Atlas
  -> verify or derive Warrant
  -> act
  -> record Episode
  -> inspect consequences and admit new claims
  -> next Fact cut
```

At decision time, Action Geometry may derive an `ActionBinding` that names the
exact Fact cut, Pursuit, Atlas, Warrant, candidate action, and resource. A
Domain Profile supplies the domain predicates used to evaluate that binding.
The binding is not a third substrate or a fourth Fact-backed action Primitive.
It is an immutable intersection receipt: changing any input root produces a
different binding, and an Episode can record use of a binding without making
an invalid decision valid.

[KF-ADR-019f86da-4f90-786d-aa24-a97705e13917](../adr/KF-ADR-019f86da-4f90-786d-aa24-a97705e13917.md) still exposes a four-value combined-v1 compatibility surface to the
Agent Work Domain Profile. The current semantic model classifies those values
differently: Episode is the ontology binding that records realized movement
among Fact cuts, while Pursuit, Atlas, and Warrant are the three Action
Geometry mappings. That distinction must not erase Episode identity or allow
any action Primitive to stand in for occurrence.

## Canonical relationship and ordering

The journal is the highest local semantic authority for typed object identity,
admission, order, causality, lifecycle, Cut, ref movement, and receipts. The
content store is authoritative for immutable body bytes only when those bytes
verify against a journal-committed root. Projections remain rebuildable.

This creates three different orderings that must not be collapsed:

1. **Occurrence order:** work may begin in an Episode, produce observations,
   and lead to admitted Fact versions and a successor Cut.
2. **Semantic visibility:** an object becomes part of the Kungfu fact world
   only through an admitted journal record. Content-store bytes alone are
   staged or orphan material.
3. **Layer order:** Fact and Episode are parallel runtime substrates.
   Pursuit, Atlas, and Warrant are action objects built over Fact identity,
   versions, relations, and Cuts; Episode independently records occurrence.

```text
                       append-only journal authority
                         /                     \
                        /                       \
       Fact substrate: admitted state      Episode substrate: causal occurrence
          at explicit Cuts                    across those Cuts
                  |
        Pursuit / Atlas / Warrant
        identities, versions, relations
                  |
        Action Geometry contract
                  |
           Domain Profile views
   Initiative / Assignment work views
                  |
       Project Cut product settlement
```

For a large body, crash-safe publication may write immutable bytes to the
selected content-store backend before appending the journal record that commits
their hash. This physical write order does not invert semantic authority:

```text
body bytes without journal reference -> material, not a Fact
journal record with missing body      -> visible but degraded evidence
journal record + verified body        -> complete usable Fact version
projection without journal authority  -> non-authoritative view
```

An Episode can therefore be earlier than a Fact in one action's experiential
sequence without being more fundamental in the ontology. Conversely, Episode
open, attach, seal, and recovery state cannot exist authoritatively without
journal facts. The relation is deliberately recursive rather than a one-way
containment hierarchy.

## Layer model

| Layer | Owns | Must not own |
| --- | --- | --- |
| Storage kernel | immutable bodies, typed records, refs, relations, cuts, receipts, integrity | product workflow vocabulary |
| Fact-Episode Ontology | admitted state and realized causal occurrence | direction, perspective, authority, or domain policy |
| Runtime substrate | journal-backed Fact admission/query and Episode lifecycle/replay | a second ontology, Mission/Go policy, or UI defaults |
| Action Geometry (cross-domain responsibility model) | Pursuit, Atlas, Warrant responsibility boundaries, typed relations, non-substitution invariants, and session refinement | Fact/Episode authority or domain field and lifecycle vocabulary |
| Domain Profiles | Mission/Go and other domain fields, lifecycle, defaults, validation, presentation, and success policy | independent storage semantics or redefinition of Action Geometry |
| Product settlement | a Project Cut binding accepted source, Atlas, Episode change, policy, omissions, and continuation coordinates | a replacement source, Atlas, Episode, or Fact authority |
| Projections | Git, JSON, CLI, GUI, Python, Node, bundles | hidden authority |

The stable kernel should be small enough that every product surface can use the
same semantics. Product convenience belongs above it.

For the Agent Work Domain Profile, the target product organization is
Initiative and Assignment, and the highest ordinary project interface is the
Project Cut-centered loop. Existing Mission/Go records and commands retain
their compatibility meaning until an explicit versioned migration. See
[The Project Cut Product Loop](../concepts/project-cut-product-loop.md) and
[KF-ADR-019f86da-4f90-7a57-a680-9739f5e67173](../adr/KF-ADR-019f86da-4f90-7a57-a680-9739f5e67173.md).

The first executable outer-ring slice combines the KFD-7 Action Geometry with
one Agent Work Domain Profile:

- the generic Fact kernel remains the sole owner of object ids, immutable
  versions, typed relations, Cuts, ref CAS, and kernel receipts;
- `kungfu agent work action` validates two ontology bindings and three action
  mappings, plus the applicable Pursuit, Atlas, Warrant, Episode, or Fact
  transition, before issuing generic kernel writes;
- one final native ref CAS is the public commit point, while a denied CAS
  reports any immutable prerequisite records that were already appended; and
- `kungfu agent work inspect` requests immutable bodies explicitly, so the
  default generic query stays metadata-only and product-neutral.

The matching action and receipt schemas live under `framework/work/agent-work/`.
They are the transitional combined-v1 implementation, not a second storage
stack or a KFD normative definition. [KF-ADR-019f86da-4f90-77c0-827b-fe1a3aa43e2b](../adr/KF-ADR-019f86da-4f90-77c0-827b-fe1a3aa43e2b.md) requires future machine
discovery to expose an exact `actionGeometryRoot`, `domainProfileRoot`, and
per-role `roleSchemaRoots` without reinterpreting existing roots.

Action Geometry names three semantic action responsibilities, not physical
topology. One record, type, API, process, or interface may carry several
ontology bindings and action mappings when
their sources, cuts, versions, authority, and derivations remain independently
inspectable and counterfactually distinguishable. Architecture and
qualification checks therefore test mappings and prohibited inferences, not
the number of implementation components.

## Semantic identity

Every first-class object requires an identity independent of:

- a filesystem path;
- a database key chosen by one backend;
- a Git branch, commit, worktree, or submodule;
- a process, thread, chat session, or provider run;
- a GUI route; and
- a human-readable title.

Object identity and current state are separate. A current Pursuit, Atlas, or
Warrant view is a Fact projection at a declared cut. An Episode has its own
causal identity and may reference the before and after cuts without becoming a
state diff.

Relations are typed, many-to-many, and non-inheriting. A reference explains a
relationship; it does not silently copy perspective, authority, completion, or
trust.

The first executable Agent Work Domain Profile schema and semantic fixtures
live beside the public work-state contract. They deliberately remain above the
storage kernel: Core provides roots, cuts, relations, receipts, and Episode
identity; the Fact-Episode Ontology distinguishes admitted state from realized
occurrence; Action Geometry preserves the three action responsibilities and
cross-role invariants; the Domain Profile decides which fields, lifecycle
states, and domain predicates constitute a valid action.

## Storage architecture

Kungfu should reuse the existing runtime storage direction rather than create
an action-specific database:

| Mechanism | Role |
| --- | --- |
| yijinjing journal | append order, causality, receipts, and typed lifecycle records |
| content store | immutable large bodies and content-addressed object payloads |
| typed catalogs and refs | identity, relation, source, head, and accepted-cut records |
| projections | rebuildable query, GUI, CLI, Python, and Node views |
| bundle | portable, self-describing Fact and Episode exchange boundary |

Authority import preserves the journal's real atomicity boundary rather than
inventing batch transactions. Each accepted record plus its adjacent operation
receipt is one logical append decision. If a later decision cannot be admitted,
the response distinguishes no-write `backend-failure` from write-bearing
`import-interrupted`, lists the exact committed prefix and observed folded
roots, and directs recovery to restart and retry the same authenticated bundle.
Retry verifies that the destination remains a subset, skips the prefix, and
must converge to the bundle's exact final refs and record roots. Qualification
can inject a deterministic failure only between complete logical decisions;
the ordinary path has no active failpoint, and a torn pair within one decision
remains an fsck/recovery boundary rather than a claimed resumable prefix.

Backend selection remains replaceable. RocksDB, content-addressed files, and
SQLite projections may implement parts of the service, but none may become the
public meaning of Fact, Episode, Pursuit, Atlas, or Warrant.

The minimum generic record families are:

- object identity and object type;
- immutable body reference;
- typed relation add/revoke;
- Fact cut declaration and accepted roots;
- Episode open/attach/seal/tombstone;
- authority derivation, attenuation, expiry, and revocation receipts;
- projection head and rebuild provenance; and
- import/export acceptance receipts.

[KF-ADR-019f86da-4f90-7c45-8d95-3745dcbbff1c](../adr/KF-ADR-019f86da-4f90-7c45-8d95-3745dcbbff1c.md) freezes the logical record families and ownership boundary. Its
machine contract is the implementation input; no authoritative writer is
claimed until the native qualification gates pass.

## What Kungfu should learn from Git

Git demonstrates mechanisms that belong in the runtime:

- content-addressed immutable objects;
- names that point to immutable identity rather than replace it;
- explicit parentage and graph traversal;
- compare-and-swap ref movement;
- local-first operation;
- cheap branching of views;
- integrity checking and rebuildable indexes;
- portable bundles; and
- independent transport and storage semantics.

These mechanisms support KFD-1 style non-drift without forcing Kungfu to adopt
Git's ontology.

## What Kungfu must not inherit from Git

Kungfu must not model:

- Pursuit, Atlas, and Warrant as three branches or submodules;
- an Episode as only a commit or state delta;
- filesystem trees as the complete Fact world;
- one repository head as the user's complete current reality;
- merge success as authority, consequence review, or Pursuit completion; or
- commit authorship as a Warrant.

Git records durable content history. Kungfu must additionally preserve causal
experience, declared perspective, bounded authority, source admission, and
trust state.

## Git projection protocol

Git remains a first-class external projection when work happens in a
repository:

```text
Kungfu identity
  -> projection manifest
  -> Git paths, refs, commits, notes, or trailers
  -> Git work occurs
  -> qualified Git Workspace Episode
  -> Project Cut reconciliation
  -> accepted Kungfu Fact cut
```

The projection manifest must bind:

- Kungfu object identities and source cut;
- repository identity, ref, commit, and path coordinates;
- encoding version and loss declaration;
- write authority and conflict policy;
- Episode or receipt roots used for reconciliation; and
- the last accepted projection head.

Git projection is rebuildable and auditable. Git JSON, branch names, and
working-tree files do not become runtime authority merely because they are
convenient for an agent.

## Xinfa Atlas migration boundary

Current `.xinfa` material remains authoritative according to its existing
ADRs until a separate cutover decision is accepted and qualified. Migration
should proceed in stages:

1. import existing Xinfa Atlas and Project Cut state as read-only sources;
2. assign stable Kungfu identities while preserving source coordinates;
3. compare Kungfu projections against existing Xinfa outputs;
4. run dual-write or shadow settlement with divergence reports;
5. prove export, recovery, and clean-clone continuation;
6. admit the Kungfu representation as authority through an explicit cut; and
7. retain a compatibility projection for old repository consumers.

Moving a directory from `.xinfa` to `.kungfu` is not authority migration.
Authority changes only when identity, lineage, recovery, and rollback are
proved.

## Product simplification

The runtime must support all three action roles even when the product reveals
only one ordinary action.

For low-consequence local work, a Domain Profile may default:

```text
Pursuit -> current work item
Atlas   -> current workspace and declared source cut
Warrant -> inspectable standing low-risk authority
Episode -> automatically opened and sealed action record
```

Defaults reduce ceremony, not semantics. Every default must remain
inspectable, replaceable, exportable, and independently invalidatable.

## Delivery gates

This design may guide implementation only while the following gates remain
explicit:

1. **Identity**: each role survives process, path, backend, and Git ref changes.
2. **Separation**: removing one role yields a typed gap rather than inference
   from another.
3. **Causality**: an Episode proves occurrence, not authorization or success.
4. **Authority**: Warrant derivation, scope, expiry, attenuation, and revocation
   fail closed.
5. **Perspective**: Atlas source and cut are inspectable and replayable.
6. **Continuity**: Pursuit decomposition and settlement preserve lineage.
7. **Recovery**: fsck, rebuild, export/import, and rollback preserve identity
   and declared loss.
8. **Projection**: Git and other projections can round-trip without becoming
   hidden authority.
9. **Dual-first parity**: human and agent surfaces resolve to the same machine
   contract and receipts.
10. **Reality-pressure dogfood**: ordinary Kungfu development proves the loop
    without requiring manual reconstruction from chat or repository folklore.

These gates refine, but do not replace, [KF-ADR-019f86da-4f90-786d-aa24-a97705e13917](../adr/KF-ADR-019f86da-4f90-786d-aa24-a97705e13917.md)'s `FO1` through `FO8` P17
qualification plan.

## Initial delivery sequence

1. Preserve [KF-ADR-019f86da-4f90-786d-aa24-a97705e13917](../adr/KF-ADR-019f86da-4f90-786d-aa24-a97705e13917.md) and the current machine contract as the public baseline.
2. Implement the accepted [KF-ADR-019f86da-4f90-7c45-8d95-3745dcbbff1c](../adr/KF-ADR-019f86da-4f90-7c45-8d95-3745dcbbff1c.md) machine contract over the existing journal
   and content-store substrate without changing its identity or ownership.
3. Project existing Mission/Go, Xinfa Atlas, authorization, and Episode
   implementations into the generic model without destructive renaming.
4. Add read-only inspection and divergence reporting before any authority
   cutover.
5. Exercise one complete dogfood loop with negative authority and stale
   perspective cases.
6. Qualify recovery, handoff, Git projection, and human/agent parity.
7. Revise the machine contract only through an explicit compatibility and ADR
   change if the architecture evidence warrants it.

## Open questions

- Which relations belong to the Fact-Episode Ontology or Action Geometry
  closed sets, and which remain Domain Profile-defined schemas?
- What is the minimum Warrant kernel that supports both local agent work and
  higher-consequence domains without importing their policy?
- How should a single Episode reference several Pursuits or Warrants without
  implying shared success or authority?
- Which Git projection losses are acceptable for ordinary repository work?
- What evidence is sufficient to replace `.xinfa` authority rather than merely
  mirror it?

Until those questions are answered through ADRs and product evidence, this
document remains a proposed implementation basis rather than a release claim.
