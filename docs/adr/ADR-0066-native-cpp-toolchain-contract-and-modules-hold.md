---
metadata_schema: kungfu.document-metadata/v1
doc_type: architecture-decision
adr_id: ADR-0066
decision_status: accepted
implementation_status: staged
implementation_prs: [https://github.com/kungfu-systems/kungfu/pull/951, https://github.com/kungfu-systems/kungfu/pull/955, https://github.com/kungfu-systems/kungfu/pull/966, https://github.com/kungfu-systems/kungfu/pull/971, https://github.com/kungfu-systems/kungfu/pull/973, https://github.com/kungfu-systems/kungfu/pull/974]
qualification_refs: [framework/core/architecture/build-capabilities.json, framework/core/architecture/check-build-capabilities.mjs, framework/core/architecture/layers.json, framework/core/architecture/check-layers.mjs, framework/core/architecture/PUBLIC_CONTRACTS.cmake, framework/core/src/libkungfu/tests/domain_component_link_tests.cpp, framework/core/src/libkungfu/tests/api_contract_tests.cpp, framework/core/src/libyijinjing/tests/fixtures/journal-wire-v1.json, framework/core/src/libyijinjing/tests/custom_provider_qualification.cpp, .github/workflows/core-build-profiles.yml, scripts/source-acceptance.mjs]
review_state: self-reviewed
sensitivity: public
sources: [local-files]
period: ongoing
theme: kungfu-cpp-modernization
confidence: high
evidence_grade: A
last_reviewed: 2026-07-15
---

# ADR-0066: native compilers share one C++ contract; modules remain qualification-only

- Status: accepted
- Date: 2026-07-12
- Category: (b) mechanism / governance — native build contract
- Subsystem: Shifu, CMake, Conan, yijinjing/libkungfu, native bindings
- Related: [ADR-0001](ADR-0001-yijinjing-publish-barrier.md),
  [ADR-0008](ADR-0008-yijinjing-schema-layout-baseline.md),
  [ADR-0037](ADR-0037-storage-records-hana-core-kernel-metadata.md),
  [ADR-0039](ADR-0039-unified-view-interface-encapsulates-flatbuffers.md),
  [ADR-0044](ADR-0044-shifu-delegation-protocol.md),
  [ADR-0047](ADR-0047-authoritative-facts-hana-pod-or-flatbuffers.md)

## Context

Kungfu declared C++23 globally, while Conan identified the same build as
`gnu17`. The root CMake floor was 3.15, contributor documentation said 3.20,
and the actual generator came from uv even when `ninja` on `PATH` was older.
That combination built on maintained machines, but it did not describe one
package identity or one reproducible compiler contract.

The build also carried broad directory/global state: `CMAKE_CXX_FLAGS`, `/W0`,
warning suppressions, `link_libraries`, include/link directories and linker
flags. Those settings leaked across the C++ core, Node/Electron bindings,
Python binding and standalone embedding surface. In particular, third-party
Hana diagnostics were suppressed as if they were first-party diagnostics.

Finally, C++ Modules were being considered as a compile-time optimization.
They are a build-graph and compiler-tooling feature, not a language-baseline
reason by themselves. The Hana macro schema, generated FlatBuffers, pybind11,
node-addon-api and public embedding surface are poor first module boundaries.

## Decision

1. `toolchain.contract.json` is the repository authority for native language,
   compiler-matrix and minimum-tool versions. CMake consumes it and Shifu
   reports the selected facts with `./shifu doctor` or
   `./shifu doctor --json`. Buildchain and future CI must consume the same file
   rather than copying version conditions.
2. Production compilers remain native to each platform: Apple Clang on macOS,
   GCC on Linux and MSVC on Windows. Clang on Linux and clang-cl on Windows are
   secondary qualification surfaces. A single LLVM frontend is not a release
   requirement.
3. The first-party project language mode is strict C++23 (`required`, extensions
   off). The consumer/package identity uses Conan `cppstd=23`. A dependency may
   still reuse a recipe-declared compatible package (for example a package
   built as GNU C++17) only when that dependency's Conan recipe explicitly
   declares the modes compatible; Conan output must make that reuse visible.
   The public yijinjing target propagates only C++20:
   `std::atomic_ref`, `std::span` and its public headers require C++20, not
   C++23. Internal libkungfu/binding targets remain C++23.
4. The root build requires CMake 3.28 and Ninja 1.11.1. Standalone yijinjing and
   its embedding example require CMake 3.20 because they do not consume the
   repository's module qualification graph. Conan and Ninja remain uv-locked
   build tools; ambient copies are diagnostics, not hidden authorities.
5. First-party compile/link requirements are target-scoped through
   `kungfu_compile_contract`. Third-party Hana, sqlite_orm, Node and Python
   headers are `SYSTEM` includes. `/W0` and broad Apple/GNU warning suppression
   are removed. Global output/RPATH settings remain because the assembled
   Node/Electron/Python runtime is one relocation closure; they are not source
   warning or language requirements.
6. Pointer/length is retained at C ABI and language-binding edges, then adapted
   immediately to typed C++ views. Content hashing establishes the first
   `std::span<const std::byte>` migration and keeps pointer/length overloads as
   compatibility adapters. No Hana POD, FlatBuffers authority, journal layout,
   mmap publication or binding semantics change.
7. Named modules stay outside production targets. The removable qualification
   slice uses CMake `FILE_SET CXX_MODULES`; no handwritten BMI command, header
   unit or compiler-specific cache becomes part of Shifu. Production adoption
   requires a repeated compile-time improvement of at least 15% on two primary
   platforms, no unacceptable third-platform regression, and unchanged native
   artifacts/embedding contracts.
8. Raising the root CMake floor activates modern policies by default. One
   explicit compatibility island remains: `CMP0148` is `OLD` immediately around
   pybind11 discovery because pybind11 2.13's shipping Python 3.13 binding still
   depends on `FindPythonLibsNew`. Remove the island only after the modern
   `FindPython` path passes Node, Electron and Python import/stub smoke on all
   three primary platforms.
9. RxCpp 4.1.1 remains pinned, but Kungfu exports an in-repository Conan recipe
   with one source patch before dependency resolution. The patch removes
   `const` from two notification payloads that already declare mutating copy
   assignment operators; GCC 14 otherwise correctly rejects those operators.
   The recipe verifies the upstream archive SHA-256 and produces a distinct
   Conan recipe/package revision. It must not patch a shared cache in place,
   and can be removed when an upstream release compiles unchanged on GCC 14.

## Baseline and qualification evidence

### Build-profile composition stage (2026-07-15)

The native toolchain contract now has a bounded, machine-readable build
capability authority at `framework/core/architecture/build-capabilities.json`.
It defines the supported profile vocabulary, component/provider/projection and
binding closure, dependency roots, defaults, conflicts and build identity.
Generated CMake, Markdown and manifest projections are drift-checked by the
source gate. Shifu, Conan and CMake consume the same selected profile, while
invalid or not-yet-qualified profiles fail closed before dependency resolution.

The first stage kept `full` as the only supported profile and removed the
global `CONAN_LIBS` umbrella in favor of generated target-local dependency
sets. The composable-Core stage then qualifies four supported profiles:
`journal`, `embedded-minimal`, `embedded-sqlite`, and the unchanged default
`full`. Planned profiles still fail closed before dependency resolution.

`embedded-minimal` resolves only fmt, spdlog, nlohmann-json and xxHash, builds
the yijinjing journal/content kernel, and excludes libkungfu, RocksDB, SQLite,
NNG, FlatBuffers, RxCpp, Node, Python and WASM. Its public
`content_store_provider_registry` is explicit and instance-local; the native
qualification fixture proves capability discovery, lifecycle, read/write,
stable errors and duplicate-provider rejection without internal headers or
global registration. `embedded-sqlite` builds the file-backed runtime and
SQLite projection without resolving, compiling, or linking RocksDB. The live
location KV seam and the storage facade use engine-neutral ports; unavailable
RocksDB selections fail with stable `provider_unavailable` diagnostics.

Every configure emits `kungfu-core-build-identity.json` with the exact profile,
closure, source revision, compiler and platform, and the assembled distribution
stages that identity beside its native artifacts. The `Core build profiles`
workflow builds both `embedded-minimal` and `full` with Apple Clang, GCC and
MSVC, then checks the selected identity and the custom-provider fixture. Local
macOS qualification additionally rebuilds `embedded-sqlite` and the complete
Node/Python/Electron/WASM `full` product.

### Domain component graph stage (2026-07-15)

The production Core source closure is now projected through eleven bounded
domain components and eleven internal CMake targets instead of coarse service
and adapter buckets. `framework/core/architecture/layers.json` is the authority
for component ownership, entry points, declared dependencies and contract-test
evidence; generated CMake targets retain `libkungfu` as the public facade while
making ledger, state/query, live, storage, extension, adapter and composition
responsibilities independently visible to the linker and architecture gate.

The architecture checker enforces a six-to-twelve production-component budget,
one owner for every production source and internal target, acyclic component
and target graphs, declared target edges, CMake-backed contract tests, reverse
layer/include rejection and source-responsibility budgets. The build-capability
checker additionally requires every production component to be projected into
the profile authority. Negative fixtures prove each failure mode, and the view
adapter has an independent link test that does not consume the `libkungfu`
facade. The refactor preserves the exact 54-file production source set and all
four previously qualified build profiles.

### Public contract compatibility stage (2026-07-15)

The same `layers.json` authority now classifies every exported libkungfu and
libyijinjing header as stable, experimental, internal or
source-embedding-only, then associates the expanded header inventory with its
actual component owner, minimum supported profile, consumers and evolution
policy. Only `kungfu_get_api` is a stable link-visible symbol. The remaining
libkungfu C++ surface is source-compatible experimental API without an STL,
object-layout or toolchain ABI promise; yijinjing remains a source-embedded
static target without a shared-library ABI promise.

Generated CMake independently compiles every public header in a translation
unit under the profile closure that first supports it. A frozen C translation
unit declares the old embedding v1/v2/v3 and native-storage v1 table prefixes
without including current headers, then links against the current Core to
verify version negotiation, caller size, unsupported versions and additive
capabilities. The current journal reader also consumes a retained wire-v1
layout fixture. Node, Python, Electron and WASM rows share one version,
capability and error semantic authority, while the machine deprecation ledger
holds replacement, window, known-consumer and removal conditions for legacy
mmap adapters. Negative fixtures reject missing or duplicate header classes,
stable-symbol drift, binding-parity drift, missing retained evidence and an
incomplete deprecation window.

The 2026-07-12 baseline used source `175e5b7694aa`:

| Platform | Primary facts | Build facts |
| --- | --- | --- |
| macOS arm64 | Apple Clang 21.0.0, libc++, CMake 4.3.2, uv Ninja 1.13.0, macOS SDK 26.5 | clean core 135.47 s; warm 32.08 s; single-source incremental 28.83 s; mmap tests pass |
| Ubuntu 24.04 x64 | GCC 14.2.0, libstdc++, CMake 3.28.3, uv Ninja 1.13.0 | strict C++23 core/Node/Electron/Python/wheel build, mmap/content-hash tests, and changed-scope gate pass |
| Windows 11 x64 | MSVC 19.51.36248, MSVC DLL CRT, CMake 4.3.3, uv Ninja 1.13.0, Windows SDK 10.0.26100.0 | strict C++23 core/Node/Electron/Python/wheel build and mmap/content-hash tests pass |

The first named-module run exposed two decisive facts:

- Apple Clang 21 does not ship `clang-scan-deps`; CMake therefore cannot build
  a named-module dependency graph with the production macOS compiler.
- Homebrew Clang 22.1.6 can build the 48-consumer slice, but its module compile
  took 1376.6 ms versus 508.0 ms for the equivalent header build (-171.0%).

Linux GCC 14 compiled the module slice in 147.6 ms versus 154.0 ms for the
header slice (+4.2%). Windows MSVC compiled it in 777.3 ms versus 815.3 ms
(+4.7%). Both execute correctly, but neither clears the 15% threshold.

The production gate is therefore **hold**. Linux GCC 14 and Windows MSVC prove
the qualification infrastructure is portable, but cannot promote modules
while macOS production Apple Clang is unsupported and every measured result is
below the benefit threshold (with the available secondary macOS result much
worse).

## Consequences

- A stale compiler, CMake or Ninja fails during configure with the exact
  contract floor; it is no longer silently normalized by unrelated global
  flags.
- Public yijinjing embedders pay a C++20 requirement, while Kungfu retains
  C++23 internally for selected features. A future C++23 public dependency must
  be justified by the header that introduces it and revisits this ADR.
- Kungfu's consumer/package cache key records strict C++23. Recipe-declared
  compatible dependency reuse remains allowed and auditable in Conan output;
  other accidental cross-mode reuse is rejected.
- Modules add no production BMI/IFC lifecycle, cache key or release artifact.
  The qualification harness is retained under `tests/qualification` as an
  executable negative/portability proof, not linked by the product build.
- Warning cleanup can proceed incrementally against first-party targets without
  exposing vendored headers as project warnings or muting all MSVC diagnostics.

## Verification

- `./shifu doctor --json` parses as JSON and reports the repository-selected
  compiler, CMake, Ninja, Conan, linker and cache.
- Root configure rejects a below-contract compiler/generator; Conan output and
  `compile_commands.json` show C++23 with extensions off.
- `./shifu test:mmap`, the content-hash native test, embedding slice and
  Node/Electron/Python artifact smoke pass on all three primary platforms.
- `./shifu qualify:cpp-modules` records compiler-specific module/header timing;
  a result below 15% reports `hold` and never mutates production targets.
- Hana POD layout/epoch tests, FlatBuffers/schema authority gates and PDB
  packaging checks remain unchanged and green.

## Replacement criteria

Replace this decision only with evidence that preserves native platform ABI and
debugging strengths, one machine-readable contract, strict package identity,
the C++20 public embedding floor, schema/layout invariants and a module benefit
that clears the stated cross-platform gate.
