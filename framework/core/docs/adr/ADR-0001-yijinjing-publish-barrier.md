# ADR-0001: yijinjing journal frame-publish protocol → `atomic_ref` release/acquire

- Status: accepted (implemented on this line; ARM adversarial stress test + in-tree compile both pass — see "Gate outcome")
- Date: 2026-06-23
- Category: (b) improvement + latent bug (concurrency correctness)
- Subsystem: yijinjing journal — single-writer / multi-reader, mmap `MAP_SHARED` cross-process frame bus
- Related: independent of ADR-0002 (longfist hana→FlatBuffers); this change touches only the publish-synchronization semantics, not the schema or on-disk format

## Decision

Change the journal frame "publish / visible" protocol from "`volatile` field +
ordinary reads/writes" to **`std::atomic_ref` release/acquire**:

- Writer side: after the payload and every header field are written, and the
  next frame's header has been zeroed, store the publish token
  `frame_header::length` (`frame::publish_data_length`) with
  `memory_order_release`, and make it the **last** write.
- Reader side: read `length` with `memory_order_acquire` as the "is there a new
  frame" gate (`frame::acquire_length` → `frame::has_data`); only after the gate
  holds may it read payload / gen_time / frame_uid.

## Context

The journal is kungfu's core IPC: a single writer sequentially appends
"fixed-size header + variable-size body" to mmap pages, and many readers poll it
lock-free. The original implementation used `volatile uint32_t length` /
`volatile int32_t msg_type` as the publish flag, paired with the program order
"writer writes payload then length, reader reads length then payload." It was
stable and correct on **x86 (TSO)** for a long time.

## Verdict at the time ((b) + latent bug)

C++ `volatile` is **not a thread-synchronization primitive**: it only constrains
the compiler's accesses to that object itself; it **emits no hardware memory
barrier and establishes no happens-before** with the adjacent non-volatile
accesses (payload / gen_time / frame_uid / zeroing of the next header). Its
correctness actually depended on x86-TSO's implicit guarantee that "stores are
not reordered with stores, loads are not reordered with loads" — a platform
accident, not a protocol guarantee. This is a "correct-but-fragile" latent bug.

On **ARM** (weak memory ordering; the v4 target platform — Apple Silicon /
aarch64 servers), the writer's store to `length` may become visible to another
core before the payload / other header fields; the reader's load of `length` may
also be reordered with the subsequent payload load. A reader can then decide "a
frame is present" while the payload is not yet visible, and read a **torn frame /
stale frame**.

## Today's recommendation (landed)

1. Drop `volatile` from `length` / `msg_type` in `frame_header`
   (`longfist/types.h`). `length` is promoted to a "publish token" whose
   semantics are carried by `atomic_ref`.
2. `frame.h`:
   - `publish_data_length()`:
     `atomic_ref<uint32_t>(length).store(header_length+len, release)`;
   - `acquire_length()`: `atomic_ref<uint32_t>(length).load(acquire)`;
   - `has_data()` now uses `acquire_length() > 0 && msg_type > 0` (the acquire
     precedes the `msg_type` read; `&&` short-circuit preserves the order);
   - `copy()` now copies every byte except `length` (offset 0); the caller
     publishes `length` last with release (guarded by
     `static_assert(offsetof(frame_header,length)==0)`).
3. `writer.cpp`:
   - `close_frame_lock_free()`: move the `length` publish to **after** gen_time /
     frame_uid / trigger_frame_uid / last_frame_position / next-header zeroing
     are all done, using `publish_data_length()` (release) as the finalizer;
   - `copy_frame()`: after `copy()`, compute the next-frame address from the
     **source** size, zero it, then `publish_data_length()`.
4. Unchanged: `replay_writer`'s `cloned_frame_->copy()` targets a private
   heap buffer (not shared memory), with no cross-process polling reader, so it
   needs no barrier; `journal.cpp`'s page-tail `set_data_length(0)` is an
   "un-publish" and keeps an ordinary write.

## Contract impact

- **Binary / on-disk format unchanged**: `length` is still the same offset, same
  width uint32; dropping `volatile` does not change size or alignment. The byte
  contract for cross-language / cross-process readers is unchanged.
- **Alignment verified**: on non-Windows targets `KF_DEFINE_PACK_TYPE` lands on
  `__attribute__((aligned(8)))` (not byte-packed); `length` is the first field
  (offset 0), and the frame start address is always 8-byte aligned
  (`verify_cpu_word_length` pads to 8 + header `aligned(8)`) → `std::atomic_ref<uint32_t>`
  satisfies alignment and is not UB.

## Reversibility

High. The change is confined to the publish point + reader-side gate + field
qualifiers, with no data migration; it can be reverted in one step.

## Cost-benefit

- Cost: one release/acquire per frame on ARM (`stlr`/`ldar`), negligible
  overhead; plus a one-time cognitive cost and a new stress-test maintenance
  surface.
- Benefit: eliminates the ARM torn-frame / stale-frame risk, turning the
  "single-writer multi-reader collapse" from accidentally-correct on a platform
  into a protocol guarantee. For a low-latency trading bus this is a hard
  correctness requirement.

## SOTA comparison

- LMAX **Disruptor**: publishes the cursor sequence with release/acquire,
  consumers acquire — isomorphic.
- **Aeron**: the term-buffer frame-header length uses an ordered/release put as
  the commit flag, consumer acquires — "length as publish token, release written
  last" is exactly this design.
- **Chronicle Queue**: header-word release write + acquire read for record
  commit.
- Conclusion: single-token release/acquire publish is the industry standard for
  this class of mmap SPMC/SPSC bus; the original `volatile` lagged the SOTA.

## Gate outcome

**Adversarial stress test** (a standalone harness mirroring the publish protocol:
token + payload, append-only ring, single writer / multi reader, back-pressure to
prevent lapping):

| Platform | volatile (original) | atomic_ref (fixed) |
|---|---|---|
| Mac arm64 (Apple M1 Ultra) | **14,630,379 tears / 75M reads** (rc=1) | **0 tears / 290M+ reads** (rc=0) |
| Linux x86_64 (i9-13900K, TSO) | **0 tears / 180M reads** (rc=0) | **0 tears / 148M reads** (rc=0) |

- **What we learned**:
  1. The tearing is **real and reproducible** — under ARM weak ordering the
     volatile protocol tears millions of times per second (token visible but
     payload not yet visible).
  2. **x86-TSO confirmation**: the same volatile protocol tears zero times on
     x86 — which is exactly why this latent bug never surfaced in production
     (x86 deployment), and confirms the "accidentally correct on a platform"
     verdict.
  3. atomic_ref release/acquire tears zero times on both ARM and x86, with no
     functional regression; on ARM the cost is one `stlr`/`ldar` per frame, and
     throughput is still in the tens of millions of frames per second.
- **In-tree compile (passed)**: using the exact compile flags from a warm v4
  build, the three `frame.h` consumers (`writer.cpp` / `reader.cpp` /
  `journal.cpp`) were compiled `-fsyntax-only` in the real tree (arm64, gnu++20,
  full conan dependencies) — 0 errors, and the compiler confirmed
  `static_assert(offsetof(frame_header,length)==0)` holds. (Front-end semantic
  compile only; full object/link goes through the node/.gyp orchestration — risk
  is very low for a header + inline-only change.)
- **Next directions**: ① whether to give the same scrutiny to the
  `close_page` / page-switch path's visibility; ② whether the ADR-0002 born-FB
  publish path should share the same `publish_data_length` / `acquire_length`
  atomic_ref wrapper.

## Implementation sites

- `framework/core/src/libkungfu/include/kungfu/longfist/types.h` (frame_header: drop volatile)
- `framework/core/src/libyijinjing/include/kungfu/yijinjing/journal/frame.h` (acquire/publish/copy)
- `framework/core/src/libyijinjing/src/journal/writer.cpp` (close_frame_lock_free / copy_frame)
