---
metadata_schema: kungfu.document-metadata/v1
doc_type: architecture-decision
adr_id: SHIFU-ADR-0001
decision_status: accepted
implementation_status: partial
review_state: unreviewed
sensitivity: public
sources: [local-files, user-consensus]
period: ongoing
theme: shifu-cache-profile-contract
confidence: high
evidence_grade: B
last_reviewed: 2026-07-12
---

# SHIFU-ADR-0001: Cache profile contract and ownership

- Status: accepted; development implementation
- Date: 2026-07-12
- Scope: Shifu execution and toolchain cache policy
- Related: Kungfu Core [ADR-0044](./ADR-0044-shifu-delegation-protocol.md)
  and the KFD-1 welded `shifu-launcher` surface in
  [`docs/versioning.md`](../versioning.md)

## Context

Development machines and self-hosted runners need the same cache policy without
copying endpoint knowledge into every repository, workflow, or host script.
Today, `build-local.env` provides useful low-level bindings, but an environment
file is not a versioned contract and cannot express authority, applicability,
fallback, verification, or evidence consistently.

There are three different responsibilities that must not collapse into one:

1. Buildchain decides the trusted build process, runner route, source lock, and
   release evidence.
2. Shifu executes the post-checkout task and binds toolchain/dependency caches.
3. An inventory controller knows private services and decides which principal or
   host receives which projection.

If Buildchain or the inventory controller defines its own field model, cache
semantics drift. If Shifu owns the infrastructure inventory, a public execution
tool becomes coupled to one private topology.

## Decision

Shifu owns one versioned cache contract with two schemas: a profile input and a
redacted resolution receipt. Their canonical discovery root is
[`cache-contract.json`](../shifu/cache-contract.json). Markdown explains the decision
and workflow but never duplicates the field specification.

An inventory controller may maintain any private internal model. Its public
boundary is generation of a Shifu profile instance that validates without
translation against the Shifu schema. The projected instance records the source
authority and digest, so a host can prove which inventory revision produced it.

Buildchain may choose a runner and supply a trusted profile reference. It does
not own or reinterpret Shifu cache fields. Its Phase-0 locked Git checkout cache
remains separate from Shifu's post-checkout execution cache boundary.

Profiles are secret-free. Endpoint URLs cannot contain user information, query
strings, or fragments. Credentials remain in approved provider-specific secret
surfaces. Resolution evidence is explicitly redacted, and local paths appear
only as digests.

The checked-out Shifu exposes the exact contract and schemas through
`shifu cache contract` and `shifu cache schema`. This is the supported dogfood
path before a public Shifu package or alpha release exists.

## Compatibility

The contract major version is part of its identity. Unknown fields are rejected
to prevent silent policy drift. Optional additive fields may extend v1; new
required fields, removals, or changed meanings require v2. A consumer that does
not support the declared major version fails closed.

This contract is part of the existing KFD-1 `shifu-launcher` welded surface.
Compatible v1 additions are additive changes; incompatible changes follow the
registered KFD-1 version decision process.

## Consequences

- Future agents can discover the cache contract from Shifu itself instead of
  reconstructing it from host files.
- Private inventories stay private and can evolve independently, provided their
  projections validate against the pinned contract.
- Local development and self-hosted runners consume the same schema with
  different policy instances.
- Provider-specific writers and automatic profile application can be added
  later without changing authority ownership.
- Cargo source replacement uses a child-scoped wrapper with highest-priority
  command-line config, while Conan remote selection uses a disposable
  `CONAN_HOME`. Shifu does not read, merge, or overwrite user configuration;
  the managed aliases and endpoints cannot silently drift from the profile.
- A future Shifu repository extraction can move this ADR registry and contract
  together without renumbering Kungfu Core ADRs.

## Alternatives considered

- **Environment variables as the contract** — rejected. They are useful
  bindings but do not express ownership, applicability, fallback, trust, or
  versioned evidence.
- **Buildchain owns the cache schema** — rejected. Buildchain owns process;
  placing execution semantics there would make every non-Buildchain Shifu use a
  second-class path.
- **The inventory controller owns and translates a separate schema** —
  rejected. Translation creates two semantic authorities and makes drift
  invisible.
- **Shifu owns concrete infrastructure inventory** — rejected. It couples a
  public execution tool to private topology and secrets.
