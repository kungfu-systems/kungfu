# Stage 9: Work Control canonical name

```json kungfu-evolution-stage
{
  "schema": "kungfu.evolution-stage/v1",
  "id": "work-control-canonical-name",
  "era": "work-control-dogfood",
  "sequence": 9,
  "title": "Work Control canonical name",
  "status": "settled",
  "evolutionImpact": "extends",
  "period": { "start": "2026-07-29", "end": "ongoing" },
  "buildsOn": ["native-work-control-recursive-dogfood"],
  "pressure": "The native authority had cut over to Work Control while current product paths, catalogs, documentation, and generated surfaces still presented the retired name as a peer.",
  "priorLimitation": "Two discoverable names obscured the single writer and let generated Agent and KFD surfaces retain a second apparent action family.",
  "localCapability": "Work Control and kungfu.work-control are the sole product identity, with native Initiative and Assignment objects and no retired reader or compatibility owner.",
  "compression": "One canonical name carries the Profile, package, CLI, GUI, TUI, Agent, documentation, build, and publication surfaces.",
  "authorityTransitions": [
    {
      "subject": "work-authority",
      "before": "native Work Control and Assignment family state",
      "after": "one native Work Control identity with Initiative and Assignment",
      "authorityRefs": ["docs/profiles/work-control.md"]
    }
  ],
  "retiredSurfaces": ["retired name as a peer Profile", "retired name in default CLI and Agent discovery", "retired physical implementation paths"],
  "unlockedCapabilities": ["deterministic naming reverse scan", "single KFD action-family discovery", "installed-product current-name qualification"],
  "downstreamConsumers": ["Work Dashboard", "Kungfu CLI and Agent catalogs", "KFX publication inventory", "Assignment family delivery"],
  "evidence": [
    { "kind": "document", "ref": "docs/profiles/work-control.md", "label": "Current Work Control product contract" }
  ],
  "readerRoute": {
    "intent": "Understand the sole current Work Control identity",
    "start": "docs/profiles/work-control.md",
    "deepen": ["docs/architecture/kfx-topology.md"]
  },
  "amends": ["native-work-control-recursive-dogfood"],
  "supersedes": []
}
```

This stage changes product naming and discovery only. It does not rewrite
retained facts, create another writer, or redesign Assignment semantics.
