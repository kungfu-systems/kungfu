# Stage 1: Polyglot Journal Restart

```json kungfu-evolution-stage
{
  "schema": "kungfu.evolution-stage/v1",
  "id": "polyglot-journal-restart",
  "era": "journal-substrate",
  "sequence": 1,
  "title": "Polyglot journal restart",
  "status": "settled",
  "evolutionImpact": "settles",
  "period": { "start": "2026-06-16", "end": "2026-06-17" },
  "buildsOn": [],
  "pressure": "The v4 restart needed one low-latency execution substrate that did not fragment C++, Python, and Node history.",
  "priorLimitation": "Each runtime could execute locally, but cross-runtime work had no single append-only history or common debugging ground.",
  "localCapability": "C++, Python, and Node bindings read and write the same mmap journal in one process while preserving the native low-latency core.",
  "compression": "The mmap journal became a language-neutral execution substrate instead of a trading-only implementation detail.",
  "authorityTransitions": [
    {
      "subject": "execution-history",
      "before": "runtime-specific process state",
      "after": "yijinjing append-only journal",
      "authorityRefs": ["docs/architecture/overview.md", "docs/architecture/event-model.md"]
    }
  ],
  "retiredSurfaces": [],
  "unlockedCapabilities": ["cross-runtime causal capture", "shared replay substrate", "native-first binding discipline"],
  "downstreamConsumers": ["Rewind", "Fact ledger", "Episode manifests", "runtime projections"],
  "evidence": [
    { "kind": "commit", "ref": "a20748de6117b627d8ad9e41551f53fe7fa9f5f2", "label": "C++ v4 core restart" },
    { "kind": "commit", "ref": "01cf26faab988082b65bb0b37a8c35d87df50a6c", "label": "Python journal round trip" },
    { "kind": "commit", "ref": "1599ab1cc50a2eeef0f7f4dfd54b8d2030f674b8", "label": "Node joins the shared journal" },
    { "kind": "commit", "ref": "5f3ab0786cba51bde94b6a075c8720c913bf6143", "label": "Single-process three-language endpoint" },
    { "kind": "commit", "ref": "103b66851dcaa647f1ca9a5abeb151e4a0828128", "label": "v4 long-term roadmap recovery point" }
  ],
  "readerRoute": {
    "intent": "Understand the original low-latency substrate",
    "start": "docs/architecture/overview.md",
    "deepen": ["docs/architecture/event-model.md", "docs/qualification/contracts.md"]
  },
  "amends": [],
  "supersedes": []
}
```

The stage is intentionally narrower than the later product: it established the
physical and language boundary that every later causal abstraction could reuse.
