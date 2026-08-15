# Stage 12: Project Compatibility Zero Residue

```json kungfu-evolution-stage
{
  "schema": "kungfu.evolution-stage/v1",
  "id": "project-compatibility-zero-residue",
  "era": "work-control-dogfood",
  "sequence": 12,
  "title": "Project compatibility zero residue",
  "status": "open",
  "evolutionImpact": "extends",
  "period": { "start": "2026-08-08", "end": "ongoing" },
  "buildsOn": ["temporal-relation-proof"],
  "pressure": "A complete Kungfu product must expose a self-contained Work vocabulary and runtime instead of inheriting commands, storage readers, fixtures, or documentation routes from one external project.",
  "priorLimitation": "Historical project integration had leaked names and compatibility surfaces into the product, while immutable Evolution Stages still pointed readers at the retired documents.",
  "localCapability": "Initiative, Assignment, Work Design, and Work Control now own the useful workflow semantics directly; generic Xinfa Atlas primitives remain independent of every external project.",
  "compression": "Project-specific adapters, aliases, readers, fixtures, and terminology collapse into native product concepts with no compatibility path.",
  "authorityTransitions": [
    {
      "subject": "work-authority",
      "before": "one current Work Control identity with an explicit read-only v3 compatibility boundary",
      "after": "native Initiative, Assignment, Work Design, and Work Control without project-specific compatibility",
      "authorityRefs": ["docs/profiles/work-control.md", "framework/assignment-runtime/assignment-runtime.contract.json"]
    }
  ],
  "retiredSurfaces": ["external-project command vocabulary", "project-specific storage readers", "compatibility aliases and bundles", "project fixtures and documentation routes"],
  "unlockedCapabilities": ["self-contained Kungfu authoring", "project-independent Work execution", "generic Xinfa Atlas composition"],
  "downstreamConsumers": ["Kungfu CLI", "Agent Runtime", "Work Dashboard", "Work Design", "third-party KFX projects"],
  "evidence": [
    { "kind": "document", "ref": "docs/profiles/work-control.md", "label": "Current native Work Control contract" },
    { "kind": "document", "ref": "framework/assignment-runtime/assignment-runtime.contract.json", "label": "Native Assignment Runtime contract" }
  ],
  "readerRoute": {
    "intent": "Understand Kungfu native work authority without external-project compatibility",
    "start": "docs/profiles/work-control.md",
    "deepen": ["framework/assignment-runtime/assignment-runtime.contract.json", "docs/architecture/kfx-topology.md", "docs/architecture/agent-supply-chain.md"]
  },
  "amends": ["profile-suite-composition", "initiative-assignment-portable-work", "native-work-control-recursive-dogfood", "work-control-canonical-name"],
  "supersedes": []
}
```

This Stage corrects current navigation without rewriting the settled records
that explain how the project-specific integration originally arose.
