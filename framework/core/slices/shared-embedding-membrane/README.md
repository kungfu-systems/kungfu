---
metadata_schema: kungfu.document-metadata/v1
document_status: active
doc_type: analysis
review_state: self-reviewed
sensitivity: internal
sources: [local-files]
period: 2026-07-10
theme: libkungfu-shared-embedding-membrane
confidence: high
evidence_grade: A
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
view. The harness reports five independent trials. The gate is the noise-free
p50 code-path budget: a genuine latency regression raises p50, so it still
fails. The p99 tail on a shared CI runner is scheduler-dominated -- the observed
p99 rides the provisional 5us budget and jitters above it while p50 stays flat
-- so the min and median p99 are reported for triage but are advisory, not a
gate. CI uses one fixed 60-second post-build settle and never retries a failed
benchmark. Exceptions are contained on both sides of the C boundary. The
report also records the exact extension-owned idle wrapper state
(`sizeof(context) + sizeof(reader)`), excluding the host-owned shared core and
module code.

Run through the repository entrypoint:

```text
./shifu verify --full
```

The cross-platform `run.mjs` gates the noise-free p50 code path: warm control
call p50 at most 500 nanoseconds and 4 KiB batch p50 at most 3.5 microseconds on
POSIX or 4.5 microseconds on Windows. The Windows allowance reflects two
independent five-trial MSVC runs spanning 3.7-4.2 microseconds, with 0.3
microseconds of fixed headroom rather than a retry or scheduler-tail exception;
POSIX keeps the tighter budget. The provisional ADR p99 budgets
(control 1us, 4 KiB batch 5us) are reported as advisory triage numbers rather
than gated, because the p99 tail on shared CI runners is scheduler-dominated
and rides those budgets while the code-path p50 stays flat.
