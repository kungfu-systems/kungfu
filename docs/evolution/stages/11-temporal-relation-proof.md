# Stage 11: Temporal Relation Proof

```json kungfu-evolution-stage
{
  "schema": "kungfu.evolution-stage/v1",
  "id": "temporal-relation-proof",
  "era": "work-control-dogfood",
  "sequence": 11,
  "title": "Temporal relation proof",
  "status": "open",
  "evolutionImpact": "opens",
  "period": { "start": "2026-08-10", "end": "ongoing" },
  "buildsOn": ["product-release-cut-updater-convergence"],
  "pressure": "Exact Facts and Cuts identified immutable worlds, but consumers still encoded compatibility, provenance, supersession, revocation, and historical path acceptance inside transport-specific projections.",
  "priorLimitation": "A consumer could compare roots or replay a Cut, but there was no neutral, directional, operation-scoped contract for proving one typed temporal path at one exact historical Cut without implicit graph inference.",
  "localCapability": "Canonical KFD temporal predicates, relation and authority facts, supersession and revocation facts, provenance objects, and bounded path receipts now share one content-addressed validation and query contract.",
  "compression": "Historical relation meaning, authority, Cut membership, path bounds, and receipt identity converge on explicit immutable Facts while transport projections remain derived consumers.",
  "authorityTransitions": [
    {
      "subject": "temporal-relation-proof",
      "before": "consumer-local root comparison and transport-specific compatibility interpretation",
      "after": "canonical Fact-bound predicates and explicit bounded path receipts evaluated at one exact Cut",
      "authorityRefs": [
        "framework/fact/kungfu-fact-cut-kernel.contract.json",
        "framework/core/src/python/kungfu/storage/fact_root_canonical.py",
        "docs/adr/KF-ADR-019fe996-1912-7144-8fa5-3fceaa416365.md"
      ]
    }
  ],
  "retiredSurfaces": [],
  "unlockedCapabilities": [
    "old-Cut temporal relation replay",
    "directional operation-scoped compatibility proof",
    "authority-aware supersession and revocation",
    "deterministic bounded path receipts"
  ],
  "downstreamConsumers": [
    "Buildchain compatibility projections",
    "release provenance objects",
    "temporal release admission",
    "release provenance cutover"
  ],
  "evidence": [
    {
      "kind": "adr",
      "ref": "docs/adr/KF-ADR-019fe996-1912-7144-8fa5-3fceaa416365.md",
      "label": "Temporal relation and proof authority decision"
    },
    {
      "kind": "document",
      "ref": "framework/fact/kungfu-fact-cut-kernel.contract.json",
      "label": "Canonical Fact and Cut temporal relation contract"
    }
  ],
  "readerRoute": {
    "intent": "Understand how immutable Facts prove a directional temporal path at one exact historical Cut",
    "start": "docs/adr/KF-ADR-019fe996-1912-7144-8fa5-3fceaa416365.md",
    "deepen": [
      "framework/fact/kungfu-fact-cut-kernel.contract.json",
      "framework/core/src/python/kungfu/storage/fact_root_canonical.py"
    ]
  },
  "amends": [],
  "supersedes": []
}
```

This Stage opens the neutral temporal proof substrate. Release-specific
projections, admission policy, and legacy cutover remain downstream work and
must not become alternative relation authorities.
