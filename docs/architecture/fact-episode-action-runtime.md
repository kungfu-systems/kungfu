# Fact, Episode, and Action Primitive Runtime

Status: proposed implementation design. This document organizes existing
Kungfu decisions into one delivery basis; it does not replace their authority
or claim that the design is qualified.

## Authority and scope

The sources of authority remain:

- [ADR-0109](../adr/ADR-0109-four-object-agent-work-state-contract.md) for the
  accepted product rule that Pursuit, Atlas, Warrant, and Episode remain
  independently addressable roles;
- [`kungfu-agent-work-state.contract.json`](../../framework/agent-work/kungfu-agent-work-state.contract.json)
  for current machine definitions, implementation mappings, invalid
  inferences, and qualification status;
- [ADR-0033](../adr/ADR-0033-episode-causal-segment-object.md) and its follow-up
  decisions for Episode identity, manifests, sealing, and bundles;
- [ADR-0051](../adr/ADR-0051-kfd-contract-world-fact-admission-and-trust.md) for
  Fact admission and trust eligibility;
- [ADR-0095](../adr/ADR-0095-xinfa-atlas-primitive-and-compatibility-boundary.md)
  through [ADR-0099](../adr/ADR-0099-git-workspace-episode-provider.md) for
  Xinfa Atlas, Project Cut, source projection, and Git Episode boundaries; and
- the published KFD Candidates for the non-normative generative hypotheses:
  [cross-domain action primitives](https://kfd.libkungfu.dev/drafts/action-state-separation/),
  [Atlas action perspective](https://kfd.libkungfu.dev/drafts/atlas-action-perspective/),
  [Pursuit intent continuity](https://kfd.libkungfu.dev/drafts/pursuit-intent-continuity/),
  and [Warrant bounded authority](https://kfd.libkungfu.dev/drafts/warrant-bounded-authority/).

KFD owns principles, generation mechanisms, qualification questions, and
falsifiers. Kungfu owns this product's storage, runtime, migration,
projection, and release design. This page is a proposed integration map
between those boundaries, not a second semantic registry.

## Design thesis

Kungfu should model real-world agent work on two runtime substrates:

- **Fact** preserves admitted state under an explicit cut.
- **Episode** preserves bounded causal experience across cuts.

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

ADR-0109 still exposes four roles to the Agent Work Profile. This design adds a
lower-level architectural distinction: Episode is both the fourth
independently addressable work role and the temporal substrate that records
movement among Fact cuts. That distinction must not erase Episode identity or
allow Pursuit, Atlas, or Warrant to stand in for occurrence.

## Layer model

| Layer | Owns | Must not own |
| --- | --- | --- |
| Storage kernel | immutable bodies, typed records, refs, relations, cuts, receipts, integrity | product workflow vocabulary |
| Runtime substrate | Fact admission/query and Episode lifecycle/replay | Mission/Go policy or UI defaults |
| Action semantics | Pursuit, Atlas, Warrant identities and typed relations | physical backend choice |
| Profiles | Mission/Go and other domain workflows, defaults, success policy | independent storage semantics |
| Projections | Git, JSON, CLI, GUI, Python, Node, bundles | hidden authority |

The stable kernel should be small enough that every product surface can use the
same semantics. Product convenience belongs above it.

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

The exact record layout requires its own accepted ADR before implementation.

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

For low-consequence local work, a Profile may default:

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

These gates refine, but do not replace, ADR-0109's `FO1` through `FO8` P17
qualification plan.

## Initial delivery sequence

1. Preserve ADR-0109 and the current machine contract as the public baseline.
2. Specify generic identity, relation, cut, and authority record families in an
   ADR before changing storage.
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

- Is a Fact cut one generic object, a signed root over several catalogs, or a
  Profile-defined composition over a generic cut mechanism?
- Which relations belong in the Core closed set, and which remain
  Profile-defined schemas?
- What is the minimum Warrant kernel that supports both local agent work and
  higher-consequence domains without importing their policy?
- How should a single Episode reference several Pursuits or Warrants without
  implying shared success or authority?
- Which Git projection losses are acceptable for ordinary repository work?
- What evidence is sufficient to replace `.xinfa` authority rather than merely
  mirror it?

Until those questions are answered through ADRs and product evidence, this
document remains a proposed implementation basis rather than a release claim.
