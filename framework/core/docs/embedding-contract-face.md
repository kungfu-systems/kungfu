# RFC: the Stage 3 embedding contract face

- Status: accepted (2026-07-11 — all decision points ratified; see "Ratified
  decisions")
- Date: 2026-07-11
- Scope: the libkungfu embedding surface the Rust host trunk consumes, and its
  convergence with the ADR-0045 gate-1 versioned C ABI
- Discharges: [ADR-0046](adr/ADR-0046-rust-host-trunk-and-assembled-runtime.md)
  decision 5 (lines 181–205) — "which symbols constitute that surface is decided
  when stage 3 lands, recorded against this ADR"; the independent RFC ADR-0046
  requires for the embedding contract face (drift-prevention is the point).
- Related: [ADR-0045](adr/ADR-0045-kfx-execution-profiles-native-rust-wasm.md)
  gate 1 (the C ABI the trunk is named as second consumer of);
  [`docs/libkungfu-embedding-membrane-spike.md`](../../../docs/libkungfu-embedding-membrane-spike.md)
  (the 3-platform feasibility evidence this RFC stands on);
  [`docs/rust-host-spike.md`](../../../docs/rust-host-spike.md) Part 3.3
  (the 17 host-assumption seams Stage 3 neutralizes).

## Question

ADR-0046 decision 1 makes the Rust trunk own `main()` and inspect the physical
storage/journal layer "through the libkungfu FFI seam." ADR-0046 decision 5
says the dylib "grows an explicit exported embedding surface" and that the
trunk "defaults to consuming the *same* C ABI — one membrane, two consumers"
(the trunk and native KFX extensions), rather than a parallel exported-C++
contract. This RFC decides, concretely:

1. **What is the embedding surface** — which symbols libkungfu intentionally
   exposes for embedding, given today's "export everything" reality.
2. **Does the trunk consume the ADR-0045 gate-1 membrane, or a separate seam** —
   and what does the trunk actually need from it beyond the v1 read-only journal
   batch capability.
3. **Versioning and transition policy** — how the ABI evolves, and whether an
   interim same-repo C++ linkage is kept.

## What already exists (facts, not proposals)

The extension face is not hypothetical — it is a concrete, 3-platform-proven
artifact today:

- **The versioned C ABI header**:
  `framework/core/src/libkungfu/include/kungfu/embedding.h` —
  `KF_EMBEDDING_ABI_V1` (`:30`), the single link-visible bootstrap
  `kungfu_embedding_get_api(requested_version, caller_struct_size, out_api)`
  (`:144–147`), the POD v1 table `kf_embedding_api_v1` (`:131–142`:
  context_open/capabilities/close, reader_open/read_batch/release_batch/close),
  opaque handles (`:36–37`), status enum (`:39–45`), capability bits
  (`:47–48`: READ_JOURNAL_BATCH, MMAP_PAYLOAD_VIEW). Export macro
  `KF_EMBEDDING_EXPORT` (`:9–24`) is the only curated visibility macro.
- **Implementation**: `.../src/runtime/embedding.cpp:200`
  (`extern "C" KF_EMBEDDING_EXPORT kungfu_embedding_get_api`), catching every
  C++ exception before returning through a function pointer (`:24`).
- **Consumer A — native KFX, link-free**:
  `slices/shared-embedding-membrane/native_kfx.cpp:33`
  (`kf_native_probe_run_v1(const kf_embedding_api_v1 *api, …)`); its CMake
  forbids any core/Conan link dependency
  (`slices/shared-embedding-membrane/CMakeLists.txt:11,13–15`).
- **Consumer B — the Rust host, via FFI**: `crates/host-spike/src/embedding.rs:92`
  (`extern "C" { fn kungfu_embedding_get_api(…) }`) + safe borrowing wrapper;
  `crates/host-spike/build.rs:93–96` links the core. (This crate is
  workspace-excluded; the seam is proven but not yet in `crates/trunk`.)
- **Spike evidence** (`docs/libkungfu-embedding-membrane-spike.md`): one
  core-owned versioned C ABI, two consumers, measured on macOS/Linux/Windows
  release with `payload_bytes_copied == 0`, control p99 ≤ 1 us, 4 KiB batch
  p99 ≤ 5 us. Platform ownership decided: no second facade DLL — macOS/Linux
  host links shared libkungfu and passes the table; **Windows host links the
  static libkungfu and passes the same table, exporting only the small C
  entry** (avoiding libkungfu's COFF 65K export limit).

Current libkungfu export surface, by contrast, is **uncurated**:
`framework/core/src/libkungfu/CMakeLists.txt:3` `enable_windows_export_all_symbols()`;
no `.def`/version-script/`KUNGFU_EXPORT` macro governs the core's own symbols;
Windows builds static (COFF 65K limit from rocksdb/boost::hana/sqlite_orm
templates), Mac/Linux shared (`CMakeLists.txt:56–64`). `journal::assemble`
(the symbol ADR-0046:185 cites) is internal-only
(`libyijinjing/.../journal/assemble.h:51`, used only inside core slice
binaries) and is deliberately NOT surfaced.

And the trunk today does **not** FFI into the core at all — `crates/trunk/` is
stage-1 sized (`env` 7 verbs + `prewarm` + the pass-through exec launcher);
its only dependency is `shifu-core` (`crates/trunk/Cargo.toml:32`). The FFI seam
exists and is proven only in the excluded `crates/host-spike`.

## Decision (proposed)

### D1. The embedding surface is the one versioned C ABI membrane

libkungfu's intentional embedding surface is exactly **`kungfu_embedding_get_api`
+ the `kf_embedding_api_v1` table**, and nothing else. We do **not** export
`journal::assemble` or grow a parallel exported-C++ contract; the "export
everything" default on Mac/Linux is an artifact of the current build, not the
contract, and remains internal-by-intent (a follow-up may curate it, but the
*embedding* contract is only the C ABI).

Rationale: this is the ADR-0046:191–199 default and the ADR-0045 gate-1 rule
("one C ABI is the source of truth; no C++ or Rust ABI crosses the boundary"),
and it is the only shape the spike proved. Two permanently parallel embedding
contracts on one core is precisely the drift ADR-0046 decision 5 forbids.

### D2. The trunk is the membrane's second consumer, via the same C ABI

The trunk adopts `crates/host-spike`'s FFI seam (the `extern "C"
kungfu_embedding_get_api` + the safe Rust borrowing wrapper) rather than a
trunk-only exported-C++ surface. One membrane, two consumers (native KFX + the
trunk). The host-spike's `embedding.rs` + `build.rs` linkage move into
`crates/trunk` (or a shared crate the trunk depends on).

Windows note: because the core is static on Windows, the trunk links the static
libkungfu and either re-exports the one C entry or calls the negotiator
directly in-process — the spike's Windows model. **This is the same reason the
S2 cpp dogfood probe could not find a "shared libkungfu" on Windows: the
membrane model (static core + table passing) is the correct Windows answer, and
Stage 3 lands it.**

### D3. Versioning: additive, negotiated, capability-gated

`kungfu_embedding_get_api(requested_version, caller_struct_size, out)` already
negotiates version + table size; capability bits already gate features. The
policy:

- v1 is frozen as the read-only journal-batch capability (single-thread-affine,
  numeric status, zero-copy mmap batch).
- New capabilities are added as new capability bits and/or a `kf_embedding_api_v2`
  table obtained through the same negotiator; old consumers keep working by
  requesting their version. No breaking change to a shipped version.
- A cross-build ABI-compatibility test (independently built old/new core and
  consumer) gates any version bump — the spike lists this as owed before any
  stable-SDK claim.

### D4. Transition: C ABI by default; interim C++ linkage only on evidence

ADR-0046:191–199 permits interim same-repo C++ linkage because the trunk is
versioned and compiled with the core. This RFC's default is nonetheless the
C ABI membrane (D2), matching native KFX, so there is no second contract to
maintain. Same-repo C++ linkage is admitted only where measured evidence
justifies a trunk-only surface the C ABI cannot express; each such use is
recorded against this RFC with its retirement condition. Exit judgment: the
interim linkage retires when the C ABI covers the trunk's inspection needs
(D5).

## Ratified decisions (2026-07-11, Keren)

### D5. The trunk's inspection needs stay read-only (the load-bearing scope)

Stage 3 ships trunk physical inspection (`doctor`, integrity, journal/storage
layer walking) on **read-only capabilities only**: v1's zero-copy journal batch
plus, at most, an additive read-only capability (e.g. location enumeration)
obtained through the same negotiator. Any write, KV, sqlite, or manifest surface
is deferred to a later, separately-argued ABI version — it is **not** added to
the membrane in Stage 3. This keeps the membrane small and the drift surface
minimal.

### D6. The trunk consumes the membrane on a first-party fast path

The trunk (versioned and compiled with the core) consumes the membrane
**without** the product-loader admission layer (admission, authority, artifact
hash, user consent, lifecycle receipts). Those remain product-loader work for
**third-party** native KFX extensions, which keep the full admission path. The
membrane's negotiate-and-call shape is identical for both; only the surrounding
loader machinery differs (first-party fast path vs third-party admitted path).

### D7. One shared `kungfu-embedding` Rust crate

The `crates/host-spike` embedding FFI (`extern "C" kungfu_embedding_get_api` +
the safe `Batch`-borrows-`reader` wrapper) moves into a **new shared
`kungfu-embedding` crate**. Both `crates/trunk` and the future `kungfu-kfx`
native-authoring crate (the ADR-0045 gate-2 thin Rust layer) depend on it, so
there is one safe borrowing layer, not two copies. This is the single-membrane
rule (D1) expressed on the Rust side.

## Consequences

- The Stage-3 trunk grows a real FFI dependency on the core through exactly one
  negotiated C ABI; "which Python/which core image" and "two embedding
  contracts" both cease to exist by mechanism.
- The Windows static-core reality becomes a feature, not a gap: the S2 cpp-probe
  "no shared libkungfu" symptom is answered by the membrane model.
- v1 stays frozen; the trunk's needs drive at most additive read capabilities,
  scoped here before code.

## Violation criteria

Record against this RFC any change that: exports a second embedding contract
(C++ or Rust ABI) from the core alongside the C ABI; bumps a shipped ABI version
in a breaking way; adds a trunk-only exported-C++ surface without a recorded
evidence + retirement note; or widens v1 with write/KV/manifest capability
without a separately-argued version decision.
