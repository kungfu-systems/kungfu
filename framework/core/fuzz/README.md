# kungfu::view fuzz + sanitizer targets ([KF-ADR-019f86da-4f90-7a66-b427-f4bcd638d8bc](../../../docs/adr/KF-ADR-019f86da-4f90-7a66-b427-f4bcd638d8bc.md) residual risk)

Memory-safety coverage for the sole FlatBuffers access module (`kungfu::view`):
fuzz the three untrusted-input entries under ASan/UBSan so "no out-of-bounds /
UAF" is *demonstrated*, not merely asserted.

## Targets

| target | entry fuzzed | invariant |
| --- | --- | --- |
| `fuzz_compile_schema` | `view::compile_schema` (`.fbs` text → `.bfbs`) → load + reflect | hostile schema text never crashes the parser, and a compiled schema reflects in bounds |
| `fuzz_from_bytes` | `view::schema_handle::from_bytes` (`.bfbs` load) | the load boundary rejects every malformed / unusable buffer, never UB |
| `fuzz_bind_frame` | `view::schema_handle::bind_frame` (frame access) | verify-before-access: a bad frame is skipped, never read out of bounds |

Each links only the view module (`src/view/schema.cpp`) + FlatBuffers + SQLite —
no runtime, mirroring the `view-encapsulation` slice.

## Two tiers (over the same entry functions)

The same `LLVMFuzzerTestOneInput` entries are built two ways, differing only in
instrumentation and driver:

- **ASan/UBSan corpus replay** (`-DKUNGFU_WITH_SANITIZERS=ON`) — the every-build
  lightweight tier. `StandaloneFuzzMain.cpp` replays the seed corpus through each
  entry under `-fsanitize=address,undefined`; it needs **no** libFuzzer runtime,
  so it builds with the ordinary build compiler (Apple clang on macOS, system
  clang/gcc on Linux, MSVC `/fsanitize=address` on Windows).
- **libFuzzer long-run** (`-DKUNGFU_WITH_FUZZ=ON`) — the alpha heavy tier. Real
  `-fsanitize=fuzzer,address,undefined`; needs a **libFuzzer-capable clang**
  (`libclang_rt.fuzzer` — Apple clang has none). If the active compiler lacks it,
  the fuzz targets are skipped with a message rather than failing configure.

`fuzz/CMakeLists.txt` is configured **standalone** (never `add_subdirectory`'d
into `framework/core`) because the fuzz tier needs a different compiler than the
conan / cmake-js core toolchain, and two compilers can't share one build tree.
Dependencies come from the conan CMakeDeps that `build:core` already generated —
point `CMAKE_PREFIX_PATH` at the core build dir.

## Wiring (how it runs in the gate)

`scripts/verify.mjs` stage 7 drives both tiers against `framework/core/build`
(the conan tree seeded by `build:core` / `rebuild:core`, like the slices stage):

```bash
./shifu verify --full     # ASan/UBSan corpus replay (every-build tier)
./shifu verify --fuzz      # + libFuzzer long-run (needs a libFuzzer clang)
```

`KUNGFU_FUZZ_SECONDS` bounds the per-target long-run (default 20s);
`KUNGFU_FUZZ_CLANGXX` overrides the fuzz compiler (else Homebrew LLVM on macOS,
system `clang++` on Linux). The libFuzzer run happens in a throwaway working dir
seeded from this corpus with `-artifact_prefix` pointed at scratch, so a CI run
never mutates the checked-in seeds or drops a `crash-*` into the repo.

The alpha/release build (`.github/workflows/build.yml`, the only recurring heavy
gate — kungfu has no nightly) overrides the lifecycle verify with
`KUNGFU_FUZZ_SECONDS=90 … verify --fuzz`: the ASan/UBSan tier runs on every
platform (MSVC ASan on Windows), the libFuzzer long-run is the Linux gate, and a
**new crash fails verify and blocks the alpha**.

## Manual standalone recipe (mac arm64)

```bash
PROBE=framework/core/build   # conan CMakeDeps, seeded by build:core
# ASan/UBSan tier (the build compiler — Apple clang)
cmake -S framework/core/fuzz -B /tmp/fuzz-san -DKUNGFU_WITH_SANITIZERS=ON \
      -DCMAKE_BUILD_TYPE=Release -DCMAKE_PREFIX_PATH=$PWD/$PROBE -DCMAKE_MODULE_PATH=$PWD/$PROBE
cmake --build /tmp/fuzz-san
/tmp/fuzz-san/fuzz_from_bytes_sanitize framework/core/fuzz/corpus/from_bytes

# libFuzzer tier (Homebrew LLVM clang)
cmake -S framework/core/fuzz -B /tmp/fuzz-lf -DKUNGFU_WITH_FUZZ=ON \
      -DCMAKE_BUILD_TYPE=Release -DCMAKE_CXX_COMPILER=/opt/homebrew/opt/llvm/bin/clang++ \
      -DCMAKE_PREFIX_PATH=$PWD/$PROBE -DCMAKE_MODULE_PATH=$PWD/$PROBE
cmake --build /tmp/fuzz-lf
/tmp/fuzz-lf/fuzz_from_bytes framework/core/fuzz/corpus/from_bytes -max_total_time=30
```

## Findings

- **Rootless-schema null-pointer read (fixed).** libFuzzer's `fuzz_compile_schema`
  found that a structurally valid `.bfbs` declaring no `root_type` (e.g. the schema
  `attribute g;`) passes `VerifySchemaBuffer` — reflection makes `root_type`
  optional — after which `plan_columns` / `bind_frame` / `verify_table` all
  dereference the null `root_table()` (UBSan: *member call on null pointer of type
  'reflection::Object'*; ASan: SEGV in `flatbuffers::Table::GetPointer`). Fixed at
  the sole load boundary: `from_bytes` now rejects a schema with a null
  `root_table()`, so every live handle guarantees a non-null root (the access path
  relies on it). After the fix all three targets run crash-free
  (`compile_schema` 842k / `from_bytes` 2.2M / `bind_frame` 12M execs over 30s each,
  mac arm64). This is the [KF-ADR-019f86da-4f90-7a66-b427-f4bcd638d8bc](../../../docs/adr/KF-ADR-019f86da-4f90-7a66-b427-f4bcd638d8bc.md) residual risk paying off — a real spatial-safety
  hole the roundtrip tests never reached.

Teeth check: temporarily skipping `VerifySchemaBuffer` in `from_bytes` makes the
fuzzer catch a crash in seconds (`AddressSanitizer: BUS in
flatbuffers::ReadScalar`) — the net catches real out-of-bounds reflection reads.

## Seeds

`corpus/<target>/` holds one checked-in seed input per target; alpha-run findings
are added back here (deliberately) + fixed. Keep seeds small and representative.
The libFuzzer run does not write back into this directory — it works on a copy.
