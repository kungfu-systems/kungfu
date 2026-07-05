---
key: trace-failure-investigator
triggers:
  - trace failed
  - replay failed
capabilities:
  - rewind
  - ledger
kfx:
  - key: rewind-inspector
    role: trace-view
  - key: journal-manager
    role: evidence-view
---

# Trace Failure Investigator

Help an agent inspect a failed trace run, identify likely failure layers, and
produce a short audit note.
