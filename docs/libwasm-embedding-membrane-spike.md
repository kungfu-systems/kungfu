---
metadata_schema: kungfu.document-metadata/v1
document_status: draft
doc_type: analysis
review_state: unreviewed
sensitivity: public
sources: [executable-probe, local-files, official-upstream]
period: 2026-07-11
theme: libwasm-shared-embedding-membrane
confidence: high
evidence_grade: B
last_reviewed: 2026-07-11
ai_provenance:
  model_family: GPT-5
  product: Codex
  generated_at: 2026-07-11
  visible_context: ADR-0045, the merged libkungfu embedding membrane, official Wasmtime and Wasmer Rust APIs, and run 29138796710 on macOS ARM64, Linux x64, and Windows x64
  invisible_context_boundary: Exact hidden model build and unimplemented production admission, receipt, WIT, and Wasmer CPU-metering behavior are unknown
---

# libwasm shared embedding membrane spike

## Current verdict

The bounded Rust-host exception is feasible on macOS ARM64, Linux x64, and
Windows x64 without creating a second libkungfu seam. Wasmtime 46.0.1 remains
the provisional primary engine; Wasmer 7.2.0 is a working, measured fallback
behind the same small C ABI and the same core-Wasm guest contract.

The three-platform functional, performance, copy, footprint, lifecycle, and
error-containment slice passes. This is still not a production compatibility
layer: the guest contract is deliberately below WIT/Component Model and
Wasmer's equivalent CPU-metering path is not yet wired. Nothing here changes
the KFX manifest, loader, admission contract, or ADR-0046 Stage 3.

## Shared membrane shape

The C++ host owns the only libkungfu image and obtains
`kf_embedding_api_v1`. It dynamically loads one engine adapter and passes that
table through a two-entry C surface:

- `kf_libwasm_run_v1` performs version/size validation, context and reader
  lifecycle, batch execution, reporting, and complete error containment;
- `kf_libwasm_panic_probe_v1` proves that a Rust panic returns as a numeric
  status instead of unwinding across C.

Both adapters compile the same Rust source and execute the same Wasm bytes.
The guest exports a fixed 2 MiB memory plus `control`, `consume`, and `trap`.
It imports nothing: no WASI, filesystem, network, environment, clock, or
engine-specific host type.

The host keeps both engine adapters resident for its process lifetime and the
panic probe does not replace the process-global panic hook. This closes the
Windows unwind boundary without adding engine SDK types or lifecycle calls to
the C surface.

Current Wasmtime and Wasmer releases cannot share one Cargo link graph:
Wasmtime 46.0.1 selects Cranelift 0.133.1 while Wasmer 7.2.0 pins Cranelift
0.133.0. The spike therefore builds two replaceable cdylib adapters from one
source file and one C contract. This keeps upstream compiler coupling behind
the engine boundary instead of downgrading the primary engine.

## Batch and copy boundary

One `reader_read_batch` call walks frames inside libkungfu. Rust receives
borrowed mmap frame slices, writes them directly into guest linear memory, and
invokes the guest once for the whole batch. It does not allocate a staging
payload buffer, call the guest per frame, expose a journal pointer to Wasm, or
copy a payload back; the scalar result is the return value.

The measured workload uses 10 warmup batches followed by 1,000 batches of 16
256-byte frames, then one 1 MiB frame. Each engine therefore reports exactly
5,144,576 host-to-guest copied bytes: 4,096,000 measured batch bytes plus the
1 MiB copy probe. Native `payload_bytes_copied` remains zero on the libkungfu
side; the one Wasm linear-memory copy is explicit and intentional.

## Three-platform evidence

GitHub-hosted optimized Release evidence from immutable-source workflow run
[`29138796710`](https://github.com/kungfu-systems/kungfu/actions/runs/29138796710),
median of three independent trials per row:

| platform / engine | control p50 / p99 | 4 KiB batch p50 / p99 | 1 MiB effective copy | cold compile / instantiate | idle instance delta | adapter file | result |
|---|---:|---:|---:|---:|---:|---:|---|
| macOS ARM64 / Wasmtime 46.0.1 | 42 ns / 84 ns | 2.292 us / 3.542 us | 2.11 GB/s | 1.140 ms / 33.542 us | 32 KiB | 9,148,832 bytes | pass |
| macOS ARM64 / Wasmer 7.2.0 | 42 ns / 84 ns | 2.417 us / 3.750 us | 1.93 GB/s | 0.864 ms / 44.542 us | 48 KiB | 9,861,424 bytes | pass |
| Linux x64 / Wasmtime 46.0.1 | 40 ns / 41 ns | 1.562 us / 6.359 us | 8.17 GB/s | 1.592 ms / 132.446 us | 2 MiB | 13,108,048 bytes | pass |
| Linux x64 / Wasmer 7.2.0 | 70 ns / 81 ns | 2.013 us / 6.559 us | 7.79 GB/s | 1.376 ms / 127.199 us | 2 MiB | 10,987,216 bytes | pass |
| Windows x64 / Wasmtime 46.0.1 | 100 ns / 100 ns | 3.800 us / 5.900 us | 1.43 GB/s | 2.456 ms / 58.900 us | 108 KiB | 11,707,392 bytes | pass |
| Windows x64 / Wasmer 7.2.0 | 100 ns / 200 ns | 3.600 us / 5.500 us | 1.56 GB/s | 2.152 ms / 43.200 us | 88 KiB | 9,670,144 bytes | pass |

Both pass the provisional ADR-0045 ceilings: control p99 at most 10 us, 4 KiB
batch p99 at most 50 us, 1 MiB effective copy throughput at least 1 GiB/s, and
idle instance delta at most 16 MiB excluding already-loaded engine code. Both
also contain the guest trap and deliberate Rust panic.

These numbers are implementation evidence, not a support SLO. Every row uses
the same source, fixture, report schema, and gates. Every engine reports 16,000
frames, 5,144,576 host-to-guest copied bytes, zero guest-to-host copied bytes,
and a contained guest trap. The hosted rows keep the pinned Rust/compiler graph
job-local and do not mutate or consume toolchain bandwidth on the trusted
self-hosted build fleet.

Adjacent runs exposed fluctuation in the separate, already-merged native
membrane: Windows reached 5.100 us in this run and Linux reached 5.669 us in
run `29137961918`. No threshold was loosened and no benchmark retry was added;
run `29138796710` itself has a green Linux row and a Windows libwasm PASS before
the native 5.100 us failure.

## Resource boundary

- Guest memory is fixed at 32 Wasm pages (2 MiB); growth is impossible.
- The module has no table and no ambient imports.
- Wasmtime fuel is enabled and the store receives a bounded allowance.
- Guest traps and Rust panics are contained at the adapter boundary.
- Output is a fixed report struct plus scalar guest return; there is no
  guest-controlled output buffer.

The Wasmer fallback currently proves memory, authority, lifecycle, trap, and
copy boundaries, but not an equivalent CPU meter. Its compiler middleware is a
separate integration surface and remains a productionization gate. A fallback
that cannot close that gate may remain diagnostic/experimental even though its
functional and performance slice passes.

## Why the guest is core Wasm first

Wasmtime has a first-class Component Model API; the reviewed Wasmer embedding
surface is centered on core modules. Using a Wasmtime-only component for the
primary path and a different artifact for the fallback would not be a shared
fallback proof. The spike therefore begins one layer lower with identical core
Wasm bytes and an engine-neutral ABI.

A later WIT world may lift/lower the same batch semantics after this membrane,
copy boundary, and engine replacement model are accepted. This spike does not
decide WIT versioning or claim that Wasmer has equivalent Component Model
support.

## Reproduction

Run the repository-owned full verification entrypoint:

```text
./shifu verify --full
```

The slice supports an optional `KF_LIBWASM_CARGO_REGISTRY` CMake cache value
for a sparse mirror. An empty value uses the official Cargo source; mirror and
official downloads are both checked against the adapter lockfiles.

The standalone spike directory pins Rust 1.95.0 with the minimal profile.
This satisfies the engines' declared Rust 1.94 (Wasmtime) and Rust 1.93
(Wasmer) minima without changing the root workspace toolchain policy.

## Remaining gates

1. Add or explicitly reject equivalent Wasmer CPU metering based on a bounded
   middleware experiment.
2. Decide whether a production WIT Component Model layer can preserve this
   engine-neutral capability contract without duplicating the author surface.
3. Keep the surface experimental until independently built ABI compatibility,
   admission, artifact hashing, consent, limit, and lifecycle receipts exist.
