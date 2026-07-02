# Capability Slices

A slice is a minimal, independently runnable program that proves one core
capability end to end. Slices are regression probes, not products: when a
slice goes red, a capability the project depends on has regressed — the
build should say so before any human notices.

## Layout

Every slice is a self-contained directory:

```
slices/<name>/
  README.md      probe statement: what capability this proves, what a
                 regression here means, and which design invariants it pins
  CMakeLists.txt slice targets (kept small; link only what the proof needs)
  run.sh         one-command replay: builds nothing, runs the slice tools
                 end to end and asserts the proof (exit 0 = capability holds)
  *.cpp / *.h    slice sources
```

`slices/CMakeLists.txt` aggregates the subdirectories. All slices build under
a single switch:

```bash
cmake -S . -B build -DKUNGFU_WITH_SLICES=ON
cmake --build build
slices/<name>/run.sh
```

Slices are wired into the repository verification gate: `./kungfu-code verify
--full` configures with `KUNGFU_WITH_SLICES=ON`, builds the slices, executes
each `run.sh`, and runs the yijinjing dependency-direction guard
(`src/libyijinjing/check-deps.sh`). The quick `verify` path does not build or
run slices.

## Rules

- **Every slice states its proof.** The README must say which capability or
  design invariant the slice pins, precisely enough that a red run tells the
  reader what was lost.
- **Link only what the proof needs.** A slice that quietly links the full
  runtime no longer proves the boundary it was written for; assertions such
  as the zero-extra-dylib check belong inside `run.sh` so a one-command
  replay carries the proof.
- **Retiring a slice needs a replacement.** When a capability gains a
  first-class product surface, the slice may retire — but only if a neutral
  check covers the same regression path. Deleting a probe without a
  replacement removes the regression signal, not the risk.

## Current slices

| Slice | Proof |
| --- | --- |
| `fact-ledger/` | The journal spine (yijinjing static core) is embeddable without the trading runtime: a standalone host writes a causal chain of events, an independent tool reopens the directory and exports a checksummed, provenance-carrying JSONL — with zero dynamic dependencies beyond the system runtime. |
| `embedding/` | The core's distribution form holds: a standalone CMake project (not part of this build; see its README) consumes `src/libyijinjing` via `add_subdirectory`, builds from scratch, and round-trips a causal chain — pinning the `EMBEDDING.md` contract. Its probe runs through `run.sh` like every other slice, but its targets are deliberately absent from this aggregate. |
| `schema-registry/` | Events are decodable without the runtime that wrote them: content-addressed `.bfbs` blobs + per-run manifest bindings let an independent tool print named fields via FlatBuffers runtime reflection — no generated code, no compiled type registry — across two coexisting schema versions. |
