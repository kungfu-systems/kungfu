# Stage 4: Profile Suite Composition

```json kungfu-evolution-stage
{
  "schema": "kungfu.evolution-stage/v1",
  "id": "profile-suite-composition",
  "era": "composable-continuation",
  "sequence": 4,
  "title": "Profile Suite composition",
  "status": "settled",
  "evolutionImpact": "settles",
  "period": { "start": "2026-07-12", "end": "2026-07-12" },
  "buildsOn": ["sealed-episode-object"],
  "pressure": "Neutral Fact and Episode primitives needed a reusable way to become domain products without moving domain semantics into the core.",
  "priorLimitation": "Each application integration could become a private bundle of runtime wiring, policy, and UI assumptions.",
  "localCapability": "The public Profile Suite semantic contract composed reusable KFX surfaces, and Mission Control migrated onto the same runtime.",
  "compression": "Domain products became declarative Profile Suites over a neutral core rather than forks of the core.",
  "authorityTransitions": [
    {
      "subject": "extension-composition",
      "before": "application-specific integration",
      "after": "KFX Profile Suite contract",
      "authorityRefs": ["docs/architecture/kfx-topology.md", "docs/profiles/profile-authoring.md"]
    }
  ],
  "retiredSurfaces": ["Mission Control private suite wiring"],
  "unlockedCapabilities": ["third-party Profile authoring", "shared lifecycle qualification", "domain policy outside the neutral core"],
  "downstreamConsumers": ["Mission Control", "Dogfood Profile", "Work Control Profile", "KFX manager"],
  "evidence": [
    { "kind": "pull-request", "ref": "https://github.com/kungfu-systems/kungfu/pull/709", "label": "Profile Suite semantic contract" },
    { "kind": "pull-request", "ref": "https://github.com/kungfu-systems/kungfu/pull/714", "label": "Mission Control migration to public suite runtime" }
  ],
  "readerRoute": {
    "intent": "Understand how neutral primitives become domain products",
    "start": "docs/profiles/profile-authoring.md",
    "deepen": ["docs/architecture/kfx-topology.md", "docs/profiles/profile-lifecycle.md", "docs/profiles/mission-control.md"]
  },
  "amends": [],
  "supersedes": []
}
```

This composition boundary later allows Work Control and KFX management to be
dogfooded as Profiles instead of privileged special cases.
