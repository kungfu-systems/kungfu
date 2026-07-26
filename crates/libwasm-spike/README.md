---
metadata_schema: kungfu.document-metadata/v1
document_status: active
doc_type: reference
review_state: self-reviewed
sensitivity: public
sources: [local-files]
period: 2026-07-24
theme: libwasm-spike-retirement
confidence: high
evidence_grade: A
last_reviewed: 2026-07-24
---

# libwasm-spike retirement gate

`libwasm-spike` is retained source authority, not an abandoned experiment:
`crates/libwasm/src/lib.rs` includes its implementation, and embedding
qualification workflows still build the spike targets.

Delete this directory only after all of these conditions are met:

1. `crates/libwasm` owns its implementation without including files from
   `libwasm-spike`.
2. The embedding and alpha-preflight workflows reference only the successor
   crate and keep their Wasmer/Wasmtime matrix.
3. The shared-membrane, native embedding, and release qualification suites pass
   on macOS, Linux, and Windows from the successor source.
4. No tracked build, workflow, slice, or qualification file references
   `crates/libwasm-spike`.
