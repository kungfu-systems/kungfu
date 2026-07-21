---
metadata_schema: kungfu.document-metadata/v1
doc_type: architecture-decision
adr_id: ADR-0134
decision_status: accepted
implementation_status: staged
implementation_prs: [https://github.com/kungfu-systems/kungfu/pull/1200]
qualification_refs: [extensions/mission-control/contracts/world.json, extensions/mission-control/contracts/facts.json, extensions/mission-control/compatibility/v3.1.json, extensions/mission-control/mission-control-actions/domain/mission_control.py, framework/core/tests/python/test_mission_control_profile.py, framework/core/tests/python/test_atlas_storage.py]
review_state: self-reviewed
sensitivity: public
sources: [local-files, user-consensus]
period: 2026-07-21
theme: initiative-assignment-l3-contract-world
confidence: high
evidence_grade: B
last_reviewed: 2026-07-21
ai_provenance: GPT-5 via Codex on 2026-07-21; based on the Mission Control Profile contracts, KFD-7 role contract, repository tests, and user-authorized terminology decision; no claim about unobserved deployed runtimes
---

# ADR-0134: Initiative and Assignment are the canonical L3 control-plane terms

- Status: accepted; implementation and qualification staged
- Date: 2026-07-21
- Category: Mission Control / L3 identity / compatibility
- Related: [ADR-0059](ADR-0059-mission-control-mission-go-responsibility-model.md),
  [ADR-0104](ADR-0104-native-mission-go-authority-cutover.md), and
  [ADR-0123](ADR-0123-action-geometry-domain-profile-separation.md)

## Context

The first Mission Control Profile named its persistent intent container
`Mission` and its dispatchable unit `Go`. Those names now collide with product
and workflow vocabulary outside the L3 domain boundary. The canonical layered
API vocabulary needs names that state responsibility rather than a command:
an Initiative retains intent, while an Assignment carries bounded delegated
work, context admission, and acceptance.

Existing `kungfu.mission-control` worlds, surfaces, payloads, receipts, and
roots may already be sealed. Their bytes and identifiers are historical facts,
not migration inputs.

## Decision

### 1. The successor L3 world has a new identity

New L3 evidence is declared in contract world
`kungfu.initiative-assignment`, version `1`, with these fact surfaces:

- `kungfu.initiative-assignment.initiative`;
- `kungfu.initiative-assignment.assignment`; and
- `kungfu.initiative-assignment.completion-claim`.

New record, link, and write-receipt schemas use `initiative` and `assignment`
vocabulary. The Mission Control Profile id remains `kungfu.mission-control`;
the Profile owns the domain policy but is not the identity of every world it
can interpret.

### 2. Legacy evidence is read-only and keeps its exact identity

Contract world `kungfu.mission-control`, versions 1 through 3, and its
`mission`, `go`, and `completion-claim` surfaces remain readable. A compatibility
projection may expose a legacy Mission as an Initiative and a legacy Go as an
Assignment, but it must carry the original world id, surface id, version,
observation id, payload hash, source id, and subject key unchanged.

The projection is not an alias, migration, admission, or new receipt. It may
not append under a legacy surface, rewrite a payload, recompute a root, or
claim that old and new identifiers are interchangeable. Legacy command names
may translate transient request and response fields into the successor writer;
they do not mint legacy evidence.

The compatibility policy is explicit: **Legacy roots, bodies, receipts,
fixtures, public commands, replay, recovery, and object identities retain their
original meaning.**

### 3. Initiative and Assignment are L3; Pursuit remains L2

Initiative and Assignment are Domain Profile records. They do not add an
Action Geometry role and do not change the KFD-7 `pursuit` role body, schema
root, transitions, receipts, or public commands. Pursuit continues to express
direction and continuity at L2; an Assignment is a dispatch unit at L3.

### 4. Identity bytes remain canonical JSON

The successor record and receipt preimages remain canonical JSON. Journal
frames may use their existing transport encoding, but transport bytes are not
root preimages. This decision introduces no alternate identity or minting
path.

## Falsification and qualification

This decision is false if:

- a successor write uses a legacy world or surface id;
- reading legacy evidence changes any sealed identity coordinate or payload
  hash;
- materializing the successor world removes or mutates a legacy declaration;
- the compatibility projection appends, migrates, or recomputes evidence;
- Initiative or Assignment changes the KFD-7 Pursuit schema root or role
  transitions; or
- capabilities omit the exact compatibility policy and world/surface mapping.

Qualification requires one runtime containing both successor and legacy facts,
a byte-for-byte legacy identity fixture, Profile source validation and contract
materialization tests, and an assertion against the unchanged Pursuit contract.

## Implementation evidence

- [PR #1200](https://github.com/kungfu-systems/kungfu/pull/1200) is the bounded
  development delivery for the successor contract world, read-only projection,
  Profile actions, and Work Dashboard intent surface.
- The qualification references in the frontmatter identify the executable
  Profile, coexistence, sealed-identity, and unchanged-Pursuit checks; channel
  promotion remains a separate settlement decision.

## Consequences

- New L3 authoring has one unambiguous vocabulary and namespace.
- Existing evidence remains independently auditable under its original names.
- Readers bear one bounded compatibility projection; writers have one current
  contract world.
- Hub capture/admission, Assignment claim, orchestration, and gate semantics
  remain separate follow-up decisions.
