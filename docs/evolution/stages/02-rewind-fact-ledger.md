# Stage 2: Rewind and the Fact Ledger

```json kungfu-evolution-stage
{
  "schema": "kungfu.evolution-stage/v1",
  "id": "rewind-fact-ledger",
  "era": "facts-and-episodes",
  "sequence": 2,
  "title": "Rewind and the Fact ledger",
  "status": "settled",
  "evolutionImpact": "settles",
  "period": { "start": "2026-07-01", "end": "2026-07-04" },
  "buildsOn": ["polyglot-journal-restart"],
  "pressure": "A shared byte history was insufficient for explaining what an agent did across runtimes or for admitting durable state as explicit facts.",
  "priorLimitation": "Readers still had to reconstruct causal meaning from journal frames and legacy command surfaces.",
  "localCapability": "The minimal Fact ledger and Rewind recorded one Python-to-Node causal chain in the standalone yijinjing journal.",
  "compression": "Journal frames became a causal fact spine, and legacy CLI or trading surfaces stopped defining the core boundary.",
  "authorityTransitions": [
    {
      "subject": "execution-history",
      "before": "yijinjing append-only journal",
      "after": "journal-backed Fact ledger and causal Rewind chain",
      "authorityRefs": ["docs/guides/rewind.md", "docs/architecture/runtime-storage-service.md"]
    }
  ],
  "retiredSurfaces": ["legacy core CLI commands", "trading-specific API as the core capability boundary"],
  "unlockedCapabilities": ["causal agent-work inspection", "Fact admission experiments", "runtime-neutral capability SDK"],
  "downstreamConsumers": ["Episode object model", "agent-work capture", "native Fact foundation"],
  "evidence": [
    { "kind": "pull-request", "ref": "https://github.com/kungfu-systems/kungfu/pull/135", "label": "Minimal Fact ledger slice" },
    { "kind": "pull-request", "ref": "https://github.com/kungfu-systems/kungfu/pull/136", "label": "Standalone yijinjing journal core" },
    { "kind": "pull-request", "ref": "https://github.com/kungfu-systems/kungfu/pull/157", "label": "One causal chain across Python and Node" },
    { "kind": "pull-request", "ref": "https://github.com/kungfu-systems/kungfu/pull/224", "label": "Legacy surface removal and capability SDK reduction" }
  ],
  "readerRoute": {
    "intent": "Understand why raw logs became causal Facts",
    "start": "docs/guides/rewind.md",
    "deepen": ["docs/architecture/runtime-storage-service.md", "docs/concepts/facts-before-trust.md"]
  },
  "amends": [],
  "supersedes": []
}
```

This stage is the first explicit move from recording bytes to recording
admitted state and causal responsibility.
