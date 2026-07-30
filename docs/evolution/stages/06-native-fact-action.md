# Stage 6: Native Fact and Action Authority

```json kungfu-evolution-stage
{
  "schema": "kungfu.evolution-stage/v1",
  "id": "native-fact-action-authority",
  "era": "native-core-authority",
  "sequence": 6,
  "title": "Native Fact and Action authority",
  "status": "settled",
  "evolutionImpact": "settles",
  "period": { "start": "2026-07-18", "end": "2026-07-21" },
  "buildsOn": ["project-cut-xinfa-continuation"],
  "pressure": "Fact and Action semantics had become useful across profiles, but adapter or profile ownership would fragment behavior across languages and products.",
  "priorLimitation": "The architecture model existed, while native writer and apply-action authority remained distributed across provisional surfaces.",
  "localCapability": "The native Fact foundation, Action Geometry, Domain Profile, and apply_action authority closed in the core and were delivered through the existing Project Cut and review loop.",
  "compression": "Proven Fact and Action behavior returned to one native semantic kernel; Profiles retained domain composition rather than core truth.",
  "authorityTransitions": [
    {
      "subject": "execution-history",
      "before": "sealed Episode plus Fact runtime infrastructure",
      "after": "native Fact foundation with Episode and Action Geometry",
      "authorityRefs": ["docs/architecture/fact-episode-action-runtime.md", "docs/qualification/fact-storage-authority.md"]
    },
    {
      "subject": "action-semantics",
      "before": "profile-local action code",
      "after": "native Action Geometry plus Domain Profile",
      "authorityRefs": ["docs/architecture/fact-episode-action-runtime.md", "docs/architecture/primitive-management-plane.md"]
    }
  ],
  "retiredSurfaces": ["profile-specific action semantics as authority", "binding-only Fact mutation authority"],
  "unlockedCapabilities": ["uniform cross-language Fact writes", "native action validation", "Profile-defined domain semantics", "portable work operations"],
  "downstreamConsumers": ["Work Control", "Assignment family", "Primitive manager", "KFX registry", "Dogfood findings"],
  "evidence": [
    { "kind": "pull-request", "ref": "https://github.com/kungfu-systems/kungfu/pull/1053", "label": "Fact Episode Action architecture" },
    { "kind": "pull-request", "ref": "https://github.com/kungfu-systems/kungfu/pull/1138", "label": "Native Fact foundation" },
    { "kind": "pull-request", "ref": "https://github.com/kungfu-systems/kungfu/pull/1155", "label": "Action Geometry and Domain Profile separation" },
    { "kind": "pull-request", "ref": "https://github.com/kungfu-systems/kungfu/pull/1176", "label": "Native apply_action authority" }
  ],
  "readerRoute": {
    "intent": "Understand the current primitive semantic kernel",
    "start": "docs/architecture/fact-episode-action-runtime.md",
    "deepen": ["docs/qualification/fact-storage-authority.md", "docs/architecture/primitive-management-plane.md"]
  },
  "amends": [],
  "supersedes": []
}
```

This stage demonstrates the recurring pattern the map is meant to expose:
prototype capability is not the endpoint; authority is compressed downward.
