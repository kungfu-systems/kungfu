---
status: active
period: 2026-07-10
theme: libkungfu-shared-embedding-membrane
doc_type: analysis
source_level: local-files
confidence: high
sensitivity: internal
evidence_grade: A
review_state: self-reviewed
last_reviewed: 2026-07-11
ai_provenance:
  model_family: GPT-5
  product: Codex
  generated_at: 2026-07-10
  invisible_context: exact model build and hidden reasoning unavailable
---

# Shared embedding membrane spike

This slice is the executable evidence for the native-first gate in ADR-0045.
It is a spike, not a stable SDK or KFX manifest change.

The host owns the one libkungfu image and dynamically loads a native KFX probe.
The probe does not link libkungfu or any C++ symbol: the host passes the versioned
`kf_embedding_api_v1` function table to its C entry point. The probe consumes
the table through the header-only C++ RAII wrapper in `kungfu/embedding.hpp`.

The read capability crosses the membrane once per batch. Each returned payload
pointer borrows an mmap page retained until explicit batch release. Each trial
warms 10 batches, then requires `payload_bytes_copied == 0`, a non-null mapped
address, 1,000 measured 4 KiB batches (16 frames per call), and a direct 1 MiB
view. The harness reports three independent trials and gates the median p99;
CI uses one fixed 60-second post-build settle and never retries a failed
benchmark. Exceptions are contained on both sides of the C boundary. The
report also records the exact extension-owned idle wrapper state
(`sizeof(context) + sizeof(reader)`), excluding the host-owned shared core and
module code.

Run through the repository entrypoint:

```text
./shifu verify --full
```

The cross-platform `run.mjs` enforces the provisional ADR budgets: warm control
call p99 at most 1 microsecond and 4 KiB batch p99 at most 5 microseconds.
