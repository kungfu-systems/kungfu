# Embedding the yijinjing journal core

`yijinjing` is the journal spine of kungfu -- frame/page mmap machinery,
reader/writer, assemble, locator/location and the base utilities they stand
on -- built as a standalone static library (`libyijinjing.a`). This document
is the embedding contract: what you get, what you must provide, and what is
deliberately not offered.

## Distribution form

The supported form is **source embedding of a static target**. There is no
packaged artifact, no shared library and no ABI promise (see
"Deliberately not offered" for why and for the escalation criteria).

```cmake
# your CMakeLists.txt -- nothing from the kungfu build system is required
add_subdirectory(<kungfu>/framework/core/src/libyijinjing yijinjing)

add_executable(your_tool main.cpp)
target_link_libraries(your_tool yijinjing)
```

`<kungfu>` can be a git checkout, a submodule or a FetchContent source
directory. The target propagates its include directories and C++20
requirement (`std::atomic_ref` implements the frame publication protocol,
see ADR-0001), so the consumer needs no extra configuration.

## What you must provide

Header-only dependencies, resolvable as CMake targets via `find_package`
(any package manager works; the kungfu build itself uses conan 2):

| dependency | accepted targets |
| --- | --- |
| fmt | `fmt::fmt-header-only` or `fmt::fmt` |
| spdlog | `spdlog::spdlog_header_only` or `spdlog::spdlog` |
| nlohmann_json | `nlohmann_json::nlohmann_json` |
| boost::hana | any include path providing `<boost/hana.hpp>`; falls back to the repository's vendored copy (`framework/core/.deps/hana-1.80.0`) |

If your enclosing build already defines these targets, the core uses them
as-is and performs no `find_package` of its own.

## What you get

- target `yijinjing` (STATIC, position-independent), include roots for
  `<kungfu/common.h>`, `<kungfu/longfist/core.h>` and
  `<kungfu/yijinjing/...>`;
- the full journal write/read surface with a noop bus and noop publisher --
  no master, no event loop, no sockets, no databases. The
  `fact-ledger-slice/` tools next to this directory are the reference
  consumers;
- a dependency-direction guarantee, enforced by `check-deps.sh`: the core
  never includes runtime, transport or storage headers, the trading type
  registry, or any trading type.

## Deliberately not offered

- **`libyijinjing.so` / ABI stability.** The API surface is still moving
  with the runtime fact ledger design. A dynamic library would freeze an
  interface nobody has embedded against yet and add rpath/ABI failure modes
  for every regular user of libkungfu.
- **Package-manager artifacts** (conan/vcpkg/npm/homebrew packages of the
  core alone). Publishing infrastructure before there is an external
  consumer inverts the demand direction.

Escalation criteria -- revisit the distribution form when any of these is
actually true, not before:

1. an embedder outside this repository maintains code against the core and
   source embedding demonstrably blocks them (submodule/FetchContent churn,
   toolchain mismatch they cannot control);
2. the core's public headers have gone a full minor release line without a
   breaking change, so an interface freeze would describe reality instead
   of aspiration;
3. a consumer needs to load the core into a process it does not build
   (plugin/FFI case) -- the first scenario a static target genuinely cannot
   serve.

Until then, the static core stays the single supported form, and
`libkungfu.so/.dylib/.dll` remains the runtime entry point for everything
user-facing.
