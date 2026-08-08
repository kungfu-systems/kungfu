# Stage 8: Native Work Control and Recursive Dogfood

```json kungfu-evolution-stage
{
  "schema": "kungfu.evolution-stage/v1",
  "id": "native-work-control-recursive-dogfood",
  "era": "work-control-dogfood",
  "sequence": 8,
  "title": "Native Work Control and recursive dogfood",
  "status": "open",
  "evolutionImpact": "opens",
  "period": { "start": "2026-07-24", "end": "ongoing" },
  "buildsOn": ["initiative-assignment-portable-work"],
  "pressure": "A large primitive and extension surface needed promotion governance and a native work authority that could carry Kungfu's own development without privileged side channels.",
  "priorLimitation": "Primitive promotion, work orchestration, and KFX registry state still depended on derived or compatibility surfaces that could drift from native authority.",
  "localCapability": "The Primitive management plane and intake gate, native Work Control cutover, maintainability closure, native KFX registry, and Assignment family state now repeatedly carry first-party delivery.",
  "compression": "Kungfu's development loop is expressed through its own Fact, Episode, Profile, Project Cut, Work, review, Primitive, and KFX primitives; projections remain derived and replaceable.",
  "authorityTransitions": [
    {
      "subject": "work-authority",
      "before": "Initiative, Assignment, and portable Project Cut-bound Work",
      "after": "native Work Control and Assignment family state",
      "authorityRefs": ["docs/profiles/work-control.md", "docs/adr/KF-ADR-019f9771-4c20-7e2c-8e7c-3f3cb3f1b9bd.md"]
    },
    {
      "subject": "primitive-lifecycle",
      "before": "informal subsystem promotion",
      "after": "derived Primitive management plane with intake closure",
      "authorityRefs": ["docs/architecture/primitive-management-plane.md", "docs/architecture/incubation-passport-governance.md"]
    },
    {
      "subject": "extension-composition",
      "before": "KFX Profile Suite contract",
      "after": "native KFX registry with reconciled projections",
      "authorityRefs": ["docs/architecture/kfx-topology.md", "docs/profiles/profile-authoring.md"]
    }
  ],
  "retiredSurfaces": ["consumer projection as intended Work authority", "unregistered primitive intake", "KFX registry projection as source authority"],
  "unlockedCapabilities": ["native assignment orchestration", "evidence-bound primitive promotion", "KFX manager as a KFX consumer", "continuous first-party dogfood", "historical self-improvement inputs"],
  "downstreamConsumers": ["Kungfu continuous delivery", "task decomposition and buildchain optimization", "KFX management", "future evolution-map stages"],
  "evidence": [
    { "kind": "pull-request", "ref": "https://github.com/kungfu-systems/kungfu/pull/1382", "label": "Derived Primitive management plane" },
    { "kind": "pull-request", "ref": "https://github.com/kungfu-systems/kungfu/pull/1412", "label": "Primitive intake closure" },
    { "kind": "pull-request", "ref": "https://github.com/kungfu-systems/kungfu/pull/1534", "label": "Native Work Control cutover" },
    { "kind": "pull-request", "ref": "https://github.com/kungfu-systems/kungfu/pull/1578", "label": "Terminal maintainability governance closure" },
    { "kind": "pull-request", "ref": "https://github.com/kungfu-systems/kungfu/pull/1704", "label": "Native KFX registry foundation" },
    { "kind": "pull-request", "ref": "https://github.com/kungfu-systems/kungfu/pull/1720", "label": "Native Assignment family state" }
  ],
  "readerRoute": {
    "intent": "Understand how Kungfu now develops itself with its own primitives",
    "start": "docs/architecture/primitive-management-plane.md",
    "deepen": ["docs/profiles/work-control.md", "docs/architecture/kfx-topology.md", "docs/architecture/agent-supply-chain.md"]
  },
  "amends": [],
  "supersedes": []
}
```

This is intentionally an open Stage. Future evidence may extend it; a new
Stage should open only when another load-bearing compression or authority
transition is visible.
