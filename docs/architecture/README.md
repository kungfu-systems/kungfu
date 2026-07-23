# Architecture

For the KFD-7 library ownership split, current ABI inventory, and staged
successor membrane, see
[`kfd7-library-boundary.md`](kfd7-library-boundary.md) and
[KF-ADR-019f86da-4f90-7b96-bc7d-4555833303eb](../adr/KF-ADR-019f86da-4f90-7b96-bc7d-4555833303eb.md).
For the boundary between cross-domain Action Geometry and adopter-owned Domain
Profiles, see
[KF-ADR-019f86da-4f90-77c0-827b-fe1a3aa43e2b](../adr/KF-ADR-019f86da-4f90-77c0-827b-fe1a3aa43e2b.md).
For the distinction between the Fact-Episode Ontology and the three Action
Geometry Primitives, see
[KF-ADR-019f86da-4f90-7cb5-b65c-b463768e7ae8](../adr/KF-ADR-019f86da-4f90-7cb5-b65c-b463768e7ae8.md).

This section owns the current system structure and the boundaries between the
journal, runtime, services, language adapters, SDK, extensions, and skills.
Architecture decisions and their historical rationale remain in
[ADR](../adr/README.md).

- [Architecture Overview](overview.md)
- [Agent Supply Chain](agent-supply-chain.md)
- [Core Layer Map](../../framework/core/architecture/LAYERS.md)
- [Event Model](event-model.md)
- [Adapters](adapters.md)
- [Carrier Type Registry](carrier-type-registry.md)
- [Embedding Contract Face](embedding-contract-face.md)
- [Episode Manifest Trust Boundary](episode-manifest-trust-boundary.md)
- [Fact, Episode, and Action Primitive Runtime](fact-episode-action-runtime.md)
- [Work Lifecycle Operation Matrix](work-lifecycle-operation-matrix.md)
- [Domain Profile Authoring](domain-profile-authoring.md)
- [Project Cut Product Loop](project-cut-product-loop.md)
- [Invariant Verification System](invariant-verification-system.md)
- [Incubation Passport Governance](incubation-passport-governance.md)
- [Work Events Schema Ownership Migration](work-events-schema-ownership-migration.md)
- [Runtime Service](runtime-service.md)
- [Runtime Storage Service](runtime-storage-service.md)
- [Storage Provider Lifecycle](storage-provider-lifecycle.md)
- [Strong Durability and Crash Recovery Design](strong-durability-and-crash-recovery-design.md)
- [Extensions](extensions.md)
- [kfx Topology](kfx-topology.md)
- [Kungfu Skills](skills.md)
