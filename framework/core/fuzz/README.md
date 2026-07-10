# kungfu::view fuzz + sanitizer targets (ADR-0039 residual risk)

Memory-safety coverage for the sole FlatBuffers access module (`kungfu::view`):
fuzz the three untrusted-input entries under ASan/UBSan so "no out-of-bounds /
UAF" is *demonstrated*, not merely asserted.

## Targets

| target | entry fuzzed | invariant |
| --- | --- | --- |
| `fuzz_compile_schema` | `view::compile_schema` (`.fbs` text → `.bfbs`) | hostile schema text never crashes the parser |
| `fuzz_from_bytes` | `view::schema_handle::from_bytes` (`.bfbs` load) | `VerifySchemaBuffer` rejects every malformed buffer, never UB |
| `fuzz_bind_frame` | `view::schema_handle::bind_frame` (frame access) | verify-before-access: a bad frame is skipped, never read out of bounds |

Each links only the view module (`src/view/schema.cpp`) + FlatBuffers + SQLite —
no runtime, mirroring the `view-encapsulation` slice.

## Toolchain (important)

- **ASan/UBSan** works with the build's default **Apple clang** (macOS) — zero
  extra toolchain. This is the every-build lightweight tier.
- **libFuzzer** (`-fsanitize=fuzzer`) is **NOT in Apple clang**
  (`libclang_rt.fuzzer_osx.a not found`). It needs an LLVM clang:
  - macOS dev: `brew install llvm` → `/opt/homebrew/opt/llvm/bin/clang++`
  - Linux CI: system clang ships libFuzzer built-in
  So fuzz targets build under a **separate toolchain** from the cmake-js `.node`
  build; they do not compile in the same configure.

## Proven recipe (mac arm64, standalone — validated 2026-07-10)

```bash
LLVM=/opt/homebrew/opt/llvm/bin/clang++
FB=~/.conan2/p/b/<flatbuffers>/p        # include + lib/libflatbuffers.a
SQ=~/.conan2/p/b/<sqlite>/p             # include + lib/libsqlite3.a
VIEW=framework/core/src/libkungfu/include
SRC=framework/core/src/libkungfu/src/view/schema.cpp

# fuzz tier (libFuzzer + ASan + UBSan)
"$LLVM" -std=c++20 -g -O1 -fsanitize=fuzzer,address,undefined \
  -I"$VIEW" -I"$FB/include" -I"$SQ/include" \
  "$SRC" framework/core/fuzz/fuzz_from_bytes.cpp \
  "$FB/lib/libflatbuffers.a" "$SQ/lib/libsqlite3.a" -o fuzz_from_bytes
./fuzz_from_bytes -max_total_time=<seconds> corpus/from_bytes

# sanitizer-only tier (Apple clang, the build toolchain — no libFuzzer)
clang++ -std=c++20 -g -O1 -fsanitize=address,undefined -fno-sanitize-recover=all \
  -I"$VIEW" -I"$FB/include" -I"$SQ/include" \
  "$SRC" framework/core/slices/view-encapsulation/probe.cpp \
  "$FB/lib/libflatbuffers.a" "$SQ/lib/libsqlite3.a" -o probe_asan && ./probe_asan
```

PoC results: from_bytes 698k execs / compile_schema 211k / bind_frame **2.7M**
execs, no crash; probe clean under ASan+UBSan. Teeth check: temporarily skipping
`VerifySchemaBuffer` in `from_bytes` makes the fuzzer find a crash in seconds
(`AddressSanitizer: BUS in flatbuffers::ReadScalar`) — the net catches real
out-of-bounds reflection reads.

## Tiering (per repo decision)

- **every dev build / local**: ASan+UBSan over the view tests (Apple clang, fast).
- **alpha release build**: full — ASan+UBSan + libFuzzer long-run (LLVM clang),
  new crash blocks the alpha. Not nightly (kungfu has no nightly); the alpha
  build is the recurring heavy gate.
- **Windows**: MSVC `/fsanitize=address` over the tests on the alpha build only.

## Seeds

`corpus/<target>/` holds checked-in seed inputs; alpha-run findings are added
back here + fixed. Keep seeds small and representative.
