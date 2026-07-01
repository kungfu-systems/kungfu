# Minimal fact-ledger slice

A minimal, verifiable slice that embeds the yijinjing journal spine in a plain
process **without starting the trading runtime** (no master, no bus drain loop,
no nng sockets), records a causal chain inside the spine, and then proves it can
be reopened and exported by a fully independent tool.

Two standalone executables:

| binary | path | role |
| --- | --- | --- |
| `fact_ledger_host` | `host.cpp` | write path: append N (>=3) `Json` events, chain each to its parent, exit |
| `fact_ledger_export` | `export.cpp` | read path: reopen the directory, emit stable JSONL + a run manifest |

What it demonstrates in one run:

- the journal core can be embedded and driven by hand-fed causality;
- the format opens without the runtime that produced it;
- export is lossless and order-preserving, and carries provenance you can verify
  with a stock `sha256sum`.

## Build

Everything runs from `framework/core`. Dependencies come from conan 2 (warm
cache); node and python bindings are skipped so only `libkungfu` and the two
tools build.

```bash
cd framework/core

# 1. resolve C++ deps + generate the CMake toolchain (conan 2)
uv run --frozen conan install . --output-folder build --build=missing -s build_type=Release

# 2. configure: skip node/python bindings, enable this slice
KUNGFU_BUILD_SKIP_KUNGFU_NODE=1 KUNGFU_BUILD_SKIP_PYKUNGFU=1 \
cmake -S . -B build -G Ninja \
  -DCMAKE_TOOLCHAIN_FILE="$(pwd)/build/conan_toolchain.cmake" \
  -DCMAKE_POLICY_DEFAULT_CMP0091=NEW \
  -DCMAKE_BUILD_TYPE=Release \
  -DKUNGFU_WITH_FACT_LEDGER_SLICE=ON

# 3. build only the two tools (pulls libkungfu as a dependency)
cmake --build build --target fact_ledger_host fact_ledger_export -j 8
```

## Run

```bash
# writes into a fresh temp dir, exports, and checksum-verifies end to end
fact-ledger-slice/run_slice.sh build 5
```

Or by hand:

```bash
work="$(mktemp -d)"
build/fact-ledger-slice/fact_ledger_host "$work" 5     # writes, then exits
build/fact-ledger-slice/fact_ledger_export "$work" fact_ledger_slice host "$work/export"
sha256sum "$work/export.jsonl"                          # matches manifest.event_log.segment_sha256
```

## Expected output

`fact_ledger_host` prints the location identity plus the expected
`(frame_uid, trigger_frame_uid)` chain. `fact_ledger_export` writes:

- `export.jsonl` — one line per event, in written order, each with
  `frame_uid / trigger_frame_uid / gen_time / trigger_time / msg_type / source /
  initial_source / dest / data_type / stream_id / payload_raw / payload /
  payload_sha256`;
- `export.manifest.json` — `spec_version`, `format_version`, `producer`,
  `platform {os, arch}`, `hash_algorithm`, per-event checksums, the whole-segment
  checksum, `causal_chain_verified`, and an explicit `capture_boundary`.

The export tool exits non-zero if nothing was read or the causal chain does not
link back correctly, so CI can gate on it.

## Acceptance criteria mapping

1. **Causal chain in the spine** — `host.cpp` feeds `bus->set_trigger_frame_uid(uid_{k-1})`
   before each frame; event k's `trigger_frame_uid` == event k-1's `frame_uid`.
   `export.cpp` re-checks the link and sets `causal_chain_verified`.
2. **Independent reopen** — `export.cpp` reconstructs the location from directory
   coordinates and iterates via `assemble` (noop bus); no trading runtime.
3. **Stable JSONL** — required fields present, order == write order, payload
   carried verbatim in `payload_raw`.
4. **Run manifest + loss boundary** — `spec/format` versions, platform, per-event
   and whole-segment `sha256`, provenance, and the `capture_boundary` declaration.
5. **No uid recompute** — `export.cpp` reads `frame_uid`/`trigger_frame_uid`
   straight off the header; it never calls `writer::current_frame_uid()`
   (ADR-0010 4.6).
6. **Reproducible build+run** — the commands above, plus `run_slice.sh`.

## Honest capture boundary (what this slice does NOT claim)

- **Runtime-decoupled, not link-decoupled.** The build still links the monolithic
  `libkungfu`; only the *runtime* is cut out (no master/bus/nng). Extracting a
  pure journal-only core is future work.
- **No in-frame content hash yet.** Content commitment lives at the manifest
  layer (checksums over exported payloads), not as a per-frame `payload_hash` in
  the spine (the external hash-blob store of the full design is future work).
- **`msg_type` is an opaque int.** No self-describing schema registry is bundled;
  decoding still assumes the reader knows the meaning of a type.
- **`frame_uid` is stable within a bundle and across re-reads, but not
  reproducible across separate write runs** (per-writer nano-hash low bits;
  ADR-0010 8.2.3 determinism not adopted).
