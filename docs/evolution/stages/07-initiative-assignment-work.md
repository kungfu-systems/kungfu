# Stage 7: Initiative, Assignment, and Portable Work

```json kungfu-evolution-stage
{
  "schema": "kungfu.evolution-stage/v1",
  "id": "initiative-assignment-portable-work",
  "era": "work-control-dogfood",
  "sequence": 7,
  "title": "Initiative, Assignment, and portable Work",
  "status": "settled",
  "evolutionImpact": "settles",
  "period": { "start": "2026-07-22", "end": "2026-07-22" },
  "buildsOn": ["native-fact-action-authority"],
  "pressure": "Agent work needed explicit responsibility, dependency, review, and portability semantics above individual Facts and Episodes.",
  "priorLimitation": "External work records could describe intent, but the runtime lacked one portable, Project Cut-bound work object and assignment family.",
  "localCapability": "Initiative and Assignment entered the L3 world, and Work became portable across workspaces while retaining its Project Cut boundary.",
  "compression": "Intent, delegation, bounded execution, and completion evidence became first-class Work objects over the existing primitives.",
  "authorityTransitions": [
    {
      "subject": "work-authority",
      "before": "external work records",
      "after": "Initiative, Assignment, and portable Project Cut-bound Work",
      "authorityRefs": ["docs/profiles/work-control.md", "framework/project-cut/README.md"]
    }
  ],
  "retiredSurfaces": ["Git or Atlas JSON as the intended runtime work authority"],
  "unlockedCapabilities": ["portable work continuation", "native assignment dependency graphs", "completion claims and independent review", "runtime-owned Initiative projection"],
  "downstreamConsumers": ["native Work Control", "Assignment orchestration", "continuous-delivery dogfood", "primitive incubation work"],
  "evidence": [
    { "kind": "pull-request", "ref": "https://github.com/kungfu-systems/kungfu/pull/1200", "label": "Initiative and Assignment L3 world" },
    { "kind": "pull-request", "ref": "https://github.com/kungfu-systems/kungfu/pull/1245", "label": "Portable Project Cut-bound Work" }
  ],
  "readerRoute": {
    "intent": "Understand how agent intent becomes bounded Work",
    "start": "docs/profiles/work-control.md",
    "deepen": ["framework/project-cut/README.md", "docs/concepts/project-cut-product-loop.md"]
  },
  "amends": [],
  "supersedes": []
}
```

This stage builds a work layer from the earlier causal and semantic substrates
instead of introducing a separate workflow database.
