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

# libkungfu shared embedding membrane spike

## Result

The native-first membrane is feasible with one core-owned, versioned C ABI.
The same v1 lifecycle and read-only journal batch capability now has two
consumers:

1. a dynamically loaded native KFX probe using the header-only C++ RAII layer;
2. the existing Rust host-spike using a safe Rust borrowing layer.

This is spike evidence, not a stable public SDK promise. It does not change the
KFX manifest or contract, add a native profile loader to the product, start the
WASM spike, or authorize ADR-0046 Stage 3.

## Membrane shape

`kungfu_embedding_get_api` is the only link-visible bootstrap. It negotiates
`KF_EMBEDDING_ABI_V1` plus the caller/table size and returns fixed-width/POD
function pointers for:

- context open, capabilities, and close;
- journal reader open and close;
- bounded batch read and explicit batch release.

The core catches every C++ exception before returning through a function
pointer. The native KFX entry catches its own C++ exceptions. The Rust wrapper
contains all `unsafe` calls in one module; a `Batch` mutably borrows its reader,
so its payload slices cannot outlive release or reader/context teardown in safe
Rust.

## No per-frame FFI and zero-copy proof

`reader_read_batch` performs the frame loop inside libkungfu. One call returns
up to 4096 metadata views. Payload pointers address the journal's mmap pages;
the reader retains page ownership until `reader_release_batch(token)`. The ABI
reports metadata copies separately and requires `payload_bytes_copied == 0`.

Each native probe trial warms 10 batches, then reads 16,000 256-byte frames as
1,000 calls of 16 frames (4 KiB per call), followed by one direct 1 MiB view.
The harness runs three independent trials, keeps every raw result visible, and
gates the median of their p99 values so one scheduler preemption is not treated
as sustained latency. The dynamically loaded module has only system C/C++
runtime dependencies; it has no libkungfu or C++ core dependency. The host has
exactly one libkungfu dependency and passes the v1 table to the module.

## Measured evidence

Release evidence from the same probe schema and code line on 2026-07-10:

| platform | control p50 / p99 | 4 KiB batch p50 / p99 | payload copied | idle state | result |
|---|---:|---:|---:|---:|---|
| macOS arm64 (local) | 0 ns / 42 ns | 2.125 us / 3.875 us | 0 bytes | 96 bytes | pass |
| Linux x64 | 17 ns / 18 ns | 0.959 us / 2.862 us | 0 bytes | 96 bytes | pass |
| Windows x64 | 0 ns / 100 ns | 2.300 us / 3.300 us | 0 bytes | 96 bytes | pass |

Every row uses the median of three independent trials; each trial reports 1,000
measured batch calls, 16,000 frames, and 4,096,000 payload bytes. The macOS row
is the optimized local Release build; Linux and Windows are the dedicated PR
matrix on the same code line. All rows pass the unchanged control p99 <= 1 us
and 4 KiB batch p99 <= 5 us gates. The additional 1 MiB frame is a direct mmap
view with zero payload copy.

The Rust host-spike passes all five existing steps. Its first step now seeds a
fixture in C++ only, then performs context/reader/batch lifecycle and payload
validation through the shared ABI's safe Rust wrapper; the old one-off C++ read
shim is gone.

The dedicated `Embedding membrane spike` workflow reconstructs a tree-hash-
verified source delta from the PR base, then builds the same host/module and
runs the same thresholds on all three release platforms.

## Platform ownership decision

No second facade DLL is needed.

- macOS/Linux: the host links the existing shared libkungfu image and passes
  the function table to a module that does not link libkungfu.
- Windows: the host links the existing static libkungfu and passes the same
  table to the DLL. Only the probe DLL's small C entry is exported, avoiding
  libkungfu's existing COFF 65K export limit.

Thus “shared membrane” means one ABI contract and one host-owned core image,
not a second shared library with duplicated core state.

The Linux A/B also exposed a maintenance boundary: a module that inherited the
top-level Conan link set duplicated RocksDB/SQLite/NNG state and double-freed at
dynamic finalization. Clearing the probe target's inherited link list fixed the
same host/libkungfu binary, and configuration now fails if that module gains a
link dependency. The resulting Linux module depends only on the system runtime;
the same cut-proof uses `otool`, platform-selected `ldd`, or `dumpbin` in CI.

## Residual limits before productization

- v1 handles are single-thread-affine and require serialized access;
- v1 is read-only and proves one journal batch capability, not the eventual
  complete native KFX capability set;
- errors are stable numeric statuses but do not yet expose a diagnostic string;
- admission, authority, artifact hash, user consent, and lifecycle receipts
  remain product-loader work and are intentionally absent from this spike;
- ABI compatibility tests across independently built old/new core and consumer
  artifacts are still required before declaring a stable SDK.

These limits keep the next decision narrow: accept or revise the membrane
shape before adding product loader/manifest work. They do not block the native
ABI feasibility result.
