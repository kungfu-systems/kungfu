---
status: active
period: ongoing
theme: kungfu-cpp-toolchain
doc_type: reference
source_level: local-files
confidence: high
sensitivity: public
evidence_grade: A
review_state: self-reviewed
last_reviewed: 2026-07-12
ai_provenance:
  model_family: GPT-5
  product: Codex
  generated_at: 2026-07-12
  invisible_context: not asserted
---

# C++ toolchain contract

Kungfu uses one native build contract, not one compiler binary on every
platform. The production matrix is Apple Clang on macOS, GCC on Linux and MSVC
on Windows; Linux Clang and Windows clang-cl are secondary qualification
surfaces. This preserves libc++/libstdc++, CRT, PDB/SEH and platform SDK
behavior while keeping language and diagnostics comparable.

The machine authority is [`toolchain.contract.json`](../toolchain.contract.json).
It defines the C++ language modes, generator and minimum versions. CMake reads
that file during configure, and Shifu reports the selected tools:

```sh
./shifu doctor
./shifu doctor --json
```

The JSON form is intended for Buildchain, local evidence and CI. It reports
facts; it does not repair or silently switch compilers.

## Language boundary

- First-party Kungfu runtime and binding targets compile as strict C++23 with
  extensions disabled.
- The public source-embedding target `yijinjing` propagates C++20. Its public
  contract uses `std::atomic_ref` and typed byte spans; neither requires C++23.
- C ABI, N-API and Python edges may receive pointer/length pairs, but internal
  C++ code adapts them immediately to typed views such as
  `std::span<const std::byte>`.
- Hana POD and FlatBuffers remain separate schema authorities. A compiler
  upgrade never authorizes a journal/POD layout change.

## CMake ownership

The root build requires CMake 3.28 and the Ninja generator. Conan and Ninja are
locked in the uv development environment used by the core build. Target-scoped
usage requirements own language, warnings, includes and link options;
third-party/generated headers are isolated as system inputs. The assembled
runtime keeps shared output/RPATH settings because Node, Electron, Python and
libkungfu must relocate as one artifact closure.

`KF_LIBWASM_CARGO_REGISTRY` selects an optional sparse Cargo mirror for the
production libwasm adapters. Shifu carries it through the Conan/cmake-js
boundary into CMake, so a managed build can use a local or regional transport
without changing Cargo package identity. For example:

```sh
KF_LIBWASM_CARGO_REGISTRY=sparse+https://rsproxy.cn/index/ ./shifu build:core
```

The build exports Kungfu's pinned RxCpp 4.1.1 Conan recipe before dependency
resolution. Its single portability patch makes the notification payloads
assignable, matching their declared assignment operators and allowing the
header to compile under GCC 14. The recipe downloads the upstream release by
fixed SHA-256; it never edits an installed or shared Conan cache in place.

Use only Shifu entrypoints. The CMake and Conan commands behind them are
implementation details, not a second contributor workflow.

## Modules policy

C++ Modules are qualification-only. Run the removable fan-in slice with:

```sh
./shifu qualify:cpp-modules
```

The slice uses CMake `FILE_SET CXX_MODULES` and the uv-managed Ninja. It does
not use header units or hand-authored BMI commands. Production adoption is held
unless repeated evidence shows at least 15% improvement on two primary
platforms without a third-platform or artifact-contract regression. See
[ADR-0066](../framework/core/docs/adr/ADR-0066-native-cpp-toolchain-contract-and-modules-hold.md).
