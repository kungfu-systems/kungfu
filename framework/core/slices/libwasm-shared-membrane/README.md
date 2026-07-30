---
metadata_schema: kungfu.document-metadata/v1
document_status: draft
doc_type: analysis
review_state: unreviewed
sensitivity: public
sources: [executable-probe, local-files]
period: 2026-07-11
theme: libwasm-shared-embedding-membrane
confidence: high
evidence_grade: B
last_reviewed: 2026-07-11
---

# libwasm shared embedding membrane spike

This slice tests the bounded Rust-host exception allowed by [KF-ADR-019f86da-4f90-7d41-a4a0-e6b01d4b31c6](../../../../docs/adr/KF-ADR-019f86da-4f90-7d41-a4a0-e6b01d4b31c6.md). It is
experimental evidence, not a KFX loader, manifest change, stable ABI, or
production compatibility promise.

The C++ host owns the only libkungfu image and passes its versioned
`kf_embedding_api_v1` table to a dynamically loaded Rust cdylib. The Rust
adapters expose the same two C entries and keep all Wasmtime/Wasmer types, raw
handles, and panic containment behind that boundary. Both engines execute the
same core-Wasm bytes: a fixed 2 MiB linear memory with `control`, `consume`,
and `trap` exports and no WASI, filesystem, network, environment, or clock
imports.
Both adapters stay loaded for the host process lifetime, and the panic probe
does not replace the process-global panic hook.

The host capability crosses libkungfu once per batch. Rust copies the borrowed
mmap payload exactly once into guest linear memory, calls the guest once, then
releases the batch. The report therefore distinguishes native metadata/payload
copy accounting from the intentional host-to-guest copy. There is no per-frame
FFI callback and no raw journal address enters the guest.

The same three-trial schema gates both engines against [KF-ADR-019f86da-4f90-7d41-a4a0-e6b01d4b31c6](../../../../docs/adr/KF-ADR-019f86da-4f90-7d41-a4a0-e6b01d4b31c6.md)'s provisional
budgets: control p99 at most 10 microseconds, 4 KiB batch p99 at most 50
microseconds, 1 MiB effective copy throughput at least 1 GiB/s, and idle
instance resident delta at most 16 MiB excluding the already-loaded engine
code. Each trial averages eight consecutive 1 MiB guest copies before the
outer three-trial median, so a single runner scheduling interruption cannot
decide the throughput verdict; all eight copies remain visible in the byte
accounting. Guest traps and a deliberate Rust panic must return as contained
status, never unwind across C.

Run through the repository entrypoint:

```text
./shifu verify --full
```

The CMake slice accepts `KF_LIBWASM_CARGO_REGISTRY` as an optional sparse
registry mirror. Leaving it empty uses the official Cargo source; CI may set a
reviewed mirror URL while Cargo still verifies the checksums pinned in each
adapter's lockfile.

The slice uses the same stable, per-engine Cargo target-cache contract as the
production adapters. Its staged libraries remain inside the slice build tree,
so qualification never depends on an external-cache path after compilation.

The standalone spike pins Rust 1.96.0 with a minimal profile in its own
directory. Wasmtime 46.0.1 requires Rust 1.94 and Wasmer 7.2.0 requires Rust
1.93; the local pin keeps older self-hosted runner defaults from silently
selecting an unsupported compiler without changing the root workspace policy.

This core-Wasm contract is deliberately below a future WIT Component Model
world. It proves the shared engine fallback and copy boundary first; it does
not claim Wasmer has a first-class Component Model embedding API or that WIT
versioning has been decided.

The adapters are separate cdylibs because current Wasmtime 46.0.1 and Wasmer
7.2.0 require incompatible Cranelift patch lines in one Cargo link graph. They
share one source file and one C ABI, so this upstream dependency conflict stays
behind the engine boundary instead of forcing the primary engine to downgrade.
