# Stage 3: Sealed Episode Object

```json kungfu-evolution-stage
{
  "schema": "kungfu.evolution-stage/v1",
  "id": "sealed-episode-object",
  "era": "facts-and-episodes",
  "sequence": 3,
  "title": "Sealed Episode object",
  "status": "settled",
  "evolutionImpact": "settles",
  "period": { "start": "2026-07-09", "end": "2026-07-11" },
  "buildsOn": ["rewind-fact-ledger"],
  "pressure": "Facts described admitted state, but work also needed a bounded causal object with identity, completeness, export, and trust boundaries.",
  "priorLimitation": "A run slice or causal chain had no stable sealed identity and could not cleanly distinguish temporal experience from current state.",
  "localCapability": "Episode manifests and sealed content roots committed a bounded causal object while positioning Facts as the wider runtime infrastructure layer.",
  "compression": "Fact became the state substrate and Episode became the causal experience substrate; neither had to impersonate the other.",
  "authorityTransitions": [
    {
      "subject": "execution-history",
      "before": "journal-backed Fact ledger and causal Rewind chain",
      "after": "sealed Episode plus Fact runtime infrastructure",
      "authorityRefs": ["docs/architecture/fact-episode-action-runtime.md", "docs/concepts/the-episode.md"]
    },
    {
      "subject": "causal-work-object",
      "before": "ad hoc run and trace slices",
      "after": "sealed Episode",
      "authorityRefs": ["docs/concepts/episode-object-model.md", "docs/architecture/episode-manifest-trust-boundary.md"]
    }
  ],
  "retiredSurfaces": ["run identity as the complete causal model"],
  "unlockedCapabilities": ["content-addressed causal experience", "Episode admission", "exportable work evidence", "Fact and Episode product layering"],
  "downstreamConsumers": ["Project Cut", "Profile qualification", "Work Control completion", "Buildchain evidence"],
  "evidence": [
    { "kind": "pull-request", "ref": "https://github.com/kungfu-systems/kungfu/pull/430", "label": "Episode object model" },
    { "kind": "pull-request", "ref": "https://github.com/kungfu-systems/kungfu/pull/491", "label": "Sealed Episode content root" },
    { "kind": "pull-request", "ref": "https://github.com/kungfu-systems/kungfu/pull/500", "label": "Runtime Fact infrastructure positioning" },
    { "kind": "pull-request", "ref": "https://github.com/kungfu-systems/kungfu/pull/531", "label": "Layer-complete products" }
  ],
  "readerRoute": {
    "intent": "Understand Fact state versus Episode experience",
    "start": "docs/architecture/fact-episode-action-runtime.md",
    "deepen": ["docs/concepts/the-episode.md", "docs/concepts/episode-object-model.md", "docs/architecture/episode-manifest-trust-boundary.md"]
  },
  "amends": [],
  "supersedes": []
}
```

The separation in this stage remains central: later Work and Action objects
consume both substrates without collapsing them.
