---
metadata_schema: kungfu.document-metadata/v1
doc_type: architecture-decision
adr_id: ADR-0121
decision_status: accepted
implementation_status: implemented
implementation_prs: [https://github.com/kungfu-systems/kungfu/pull/1115, https://github.com/kungfu-systems/kungfu/pull/1116, https://github.com/kungfu-systems/kungfu/pull/1139]
closure_pr: https://github.com/kungfu-systems/kungfu/pull/1139
qualification_refs: [framework/fact/kungfu-fact-root-canonical-v2.json, framework/fact/kungfu-fact-writer-authority-v2.json, tests/fixtures/fact-root-canonical/vectors.json, tests/fixtures/fact-kernel-characterization/v1.json, framework/core/src/libkungfu/src/runtime/storage/fact_protocol.cpp, framework/core/src/libkungfu/src/runtime/storage/fact_query.cpp, framework/core/src/python/kungfu/storage/fact_root_canonical.py, scripts/check-fact-root-canonical.test.mjs, framework/core/tests/python/test_fact_kernel_characterization.py, framework/core/tests/storage-node-binding.test.js, docs/qualification/evidence/gate-measurements/1edae0d8b1/linux/receipt.json, scripts/check-kungfu-gate-catalog.test.mjs, scripts/check-project-cut-composition.test.mjs]
review_state: self-reviewed
sensitivity: public
sources: [local-files, user-consensus]
period: ongoing
theme: portable-fact-root-canonical-encoding
confidence: high
evidence_grade: A
last_reviewed: 2026-07-19
ai_provenance: GPT-5 via Codex on 2026-07-19; based on repository sources and user-authorized design constraints; no claim about hidden model parameters or unobserved third-party implementations
---

# ADR-0121: Fact Root v2 uses a closed typed binary preimage

- Status: accepted and implemented; KFR2 is the explicit native writer
  authority, while release qualification remains a separate decision
- Date: 2026-07-19
- Category: Fact identity / canonical encoding / KFD-1
- Related: [ADR-0112](ADR-0112-backend-neutral-fact-cut-kernel.md), [ADR-0098](ADR-0098-project-cut-v1-canonical-root-and-source-projection.md)

## Context

The first native Fact kernel selects closed record fields but serializes each
field with `nlohmann::json::dump()` before length framing. That path is adequate
only as one internal legacy implementation: it does not define integer
transport above JavaScript's safe range, floating-point edge values, Unicode
normalization, unknown nested fields, or cross-language canonical bytes. The
v1 contract also claimed NFC while the writer did not enforce it. Changing
those rules under the existing protocol label would silently reinterpret
persisted Roots and violate KFD-1.

## Decision

`kungfu.fact-root.canonical/v2` (KFR2) is the portable Fact Root protocol. Its
normative source is
[`kungfu-fact-root-canonical-v2.json`](../../framework/fact/kungfu-fact-root-canonical-v2.json).
Every preimage starts with the four bytes `KFR2`, followed by a closed typed
value. Type tags, unsigned 64-bit length/count framing, integer ranges,
binary64 bits, text, bytes, array, set, map, and schema-bound record encoding
are fixed by that contract rather than by a JSON library.

Root-bound integers use canonical decimal text only at the conformance/edge IR
and encode as exact eight-byte values. Finite binary64 bits encode exactly;
positive and negative zero remain distinct, while NaN and infinities reject.
Text must be shortest-form UTF-8 Unicode scalar values. KFR2 preserves the
scalar sequence exactly: composed and decomposed spellings are distinct values,
so no platform Unicode-normalization library can change a Root.

Arrays preserve order. Sets sort complete encoded values bytewise and reject
equal preimages. Maps have text keys, sort complete encoded keys, and reject
equal keys. Records sort stable unsigned field ids, reject duplicates, reject
unknown schemas and fields, and never infer identity defaults. `null` is a
value; absent is a schema condition and has no value encoding. Any field-set,
type, identity-default, encoding, or meaning change requires a successor schema
id and produces a successor Root.

The checked-in corpus freezes both canonical bytes and SHA-256 Roots, plus
stable rejection codes. `libkungfu` and an independent Python implementation
must reproduce every preimage byte; a thin Node or Python binding over the C++
kernel does not count as an independent implementation. Source acceptance and
native binding qualification rerun the corpus, making JSON, Unicode, hash,
compiler, and serialization dependency drift fail closed.

## Legacy and migration boundary

`sha256-length-framed-fields-v1` remains a required legacy reader, with no
portability or NFC claim. Existing v1 bytes and Roots are never reserialized,
normalized, or relabeled as KFR2.

KFR2 is the explicit authoritative writer for new native journal records under
[`kungfu-fact-writer-authority-v2.json`](../../framework/fact/kungfu-fact-writer-authority-v2.json).
Every new record and its operation receipt use record schema version 2. Logical
continuity is represented by stable Fact object identity and
`kungfu.fact.root-mapping-receipt/v1`. The mapping receipt binds the legacy and
successor protocol labels, both Roots, and the exact admission Root; it does not
claim byte equality or mutate either Root. Authority import replays each record
under its declared protocol and verifies the exact source Root. A caller cannot
select the legacy writer through the public mutation surface; downgrade,
unknown protocol, and unknown record schema attempts fail before a write.

## Corrected admission invariants

The legacy writer now rejects unknown relation-endpoint fields before they can
leak into a new Root. It sorts Episode frontier entries by the complete
`(episodeId, sealedContentRoot, acceptedManifestFrameUid)` tuple and rejects a
duplicate Episode id. These changes narrow admission only; the legacy reader
continues to verify every already-persisted v1 Root using its original bytes.

## Falsification and residual risk

This decision is false if two accepted corpus implementations differ on one
preimage byte, if only final hashes are compared, if unknown fields or duplicate
set/map/record identities are accepted, if a surrogate or non-finite float
receives a Root, or if a v1 Root is silently recomputed as v2.

The KFR2 codec is independently implementable and the native journal writer now
emits KFR2. The checked characterization roots, retained legacy replay fixture,
CAS contention test, and source gates form one exact candidate on Linux, macOS,
and Windows CI. This does not claim production durability, distributed
operation, or release qualification; those remain separate decisions.
