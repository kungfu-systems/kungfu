# Architecture

For the KFD-7 library ownership split, current ABI inventory, and staged
successor membrane, see
[`kfd7-library-boundary.md`](kfd7-library-boundary.md) and
[ADR-0120](../adr/ADR-0120-kfd7-library-boundary-and-successor-abi.md).
For the boundary between cross-domain Action Geometry and adopter-owned Domain
Profiles, see
[ADR-0123](../adr/ADR-0123-action-geometry-domain-profile-separation.md).
For the distinction between the Fact-Episode Ontology and the three Action
Geometry Primitives, see
[ADR-0125](../adr/ADR-0125-fact-episode-ontology-and-action-geometry.md).

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
- [Runtime Service](runtime-service.md)
- [Runtime Storage Service](runtime-storage-service.md)
- [Storage Provider Lifecycle](storage-provider-lifecycle.md)
- [Strong Durability and Crash Recovery Design](strong-durability-and-crash-recovery-design.md)
- [Extensions](extensions.md)
- [kfx Topology](kfx-topology.md)
- [Kungfu Skills](skills.md)
