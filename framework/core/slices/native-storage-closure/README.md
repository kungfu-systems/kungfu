---
metadata_schema: kungfu.document-metadata/v1
document_status: active
doc_type: analysis
review_state: self-reviewed
sensitivity: internal
sources: [local-files]
period: 2026-07-11
theme: adr-0049-native-storage-closure
confidence: high
evidence_grade: A
last_reviewed: 2026-07-11
---

# Native storage closure

This slice qualifies the ADR-0049 `libkungfu` product boundary through the
versioned `kungfu/native_storage.h` C ABI. The consumer links `libkungfu`
directly and uses no Python, Node, Rust host, GUI, cloud, or database service.

The fixture creates a `.kungfu` workspace, begins and seals an Episode, closes
and reopens the native context, queries both head and a stable historical
manifest cut, runs Episode-scoped fsck, and exports an Episode bundle. Every
operation delegates to the existing runtime storage service; the ABI transports
UTF-8 JSON edge projections and does not implement a second storage model.

The v1 contract is single-thread-affine. One borrowed result can be outstanding
per context and must be explicitly released. ABI version mismatch, unsupported
operations, busy ownership, invalid input, and core failure are distinct status
codes. `context_last_error` exposes a borrowed diagnostic until the next call.

Run the repository gate:

```text
./shifu verify --full
```
