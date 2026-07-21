---
metadata_schema: kungfu.document-metadata/v1
doc_type: qualification-runbook
document_status: active
review_state: self-reviewed
sensitivity: public
sources: [local-files, executable-probe, official-upstream]
period: 2026-07-20
theme: kfd-agent-runtime-reference-qualification
confidence: high
evidence_grade: B
last_reviewed: 2026-07-20
ai_provenance: GPT-5 via Codex on 2026-07-20; records the executable qualification boundary and does not claim unobserved platforms or external adoption
---

# KFD Agent Runtime reference qualification

Run `./shifu kfd:agent-runtime:qualify -- --kfd-root /path/to/kfd`.
The harness copies the frozen adapter and its public shared-library dependency
into a disposable scratch directory, runs the exact KFD Runtime 100 suite,
invokes the KFD-owned offline verifier, proves that a deliberately invalid
always-accept adapter fails the named negative vectors, and performs a real
process termination/reopen/fsck probe over disposable storage.

The retained output contains the KFD report, verifier result, negative-fixture
report, and a Kungfu qualification envelope. The envelope is not a KFD
certificate: it keeps Core and Experimental partitions separate and binds the
claim to the observed platform and exact artifact/suite roots.

The production adapter has one semantic implementation in C++. It starts only
at `kungfu_get_api` from `kungfu/api.h` and negotiates standard responsibility
tables. Node owns black-box process orchestration and Python independently
inspects the Episodes retained by the same native storage authority; neither
language host reimplements the KFD state machine.
