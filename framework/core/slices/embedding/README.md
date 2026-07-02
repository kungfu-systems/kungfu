# Embedding slice

**Probe statement.** This slice pins the distribution form of the yijinjing
core: source/static embedding via `add_subdirectory` is the one supported way
to consume it (contract: `src/libyijinjing/EMBEDDING.md`). A standalone CMake
project — configured from scratch, never through the kungfu parent build —
pulls in `src/libyijinjing` alone, builds an executable against it, writes a
causal chain of Json events, reopens the directory with `assemble`, and
asserts the chain and payloads survived the round trip.

A red run means the embedding contract regressed. The usual suspect: the core
`CMakeLists.txt` grew a dependency on a kungfu parent-scope variable or
target, so external embedders can no longer configure it standalone.

## Run

```bash
# from framework/core (seed the conan toolchain first: conan install / rebuild:core)
slices/embedding/run.sh
```

The script configures the embedder in a throwaway build directory using the
core build's conan toolchain — standing in for the embedder's own dependency
provisioning (fmt, spdlog, nlohmann_json; see EMBEDDING.md for what an
embedder must supply). `embed_smoke` exits 0 only if every event read back
carries the exact `frame_uid` recorded at write time, the causal links match,
and the Json payloads parse to what was written.

## What this does NOT cover

- Windows (`run.sh` is bash; verify skips slices there).
- FetchContent-style embedding from outside this repository — same mechanism,
  but the vendored boost::hana fallback next to the core tree is absent in
  that layout and the embedder must provide `<boost/hana.hpp>` itself.
