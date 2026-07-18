---
metadata_schema: kungfu.document-metadata/v1
doc_type: architecture-decision
adr_id: ADR-0001
decision_status: accepted
implementation_status: implemented
implementation_commits: [879e7acfeb23be6c82cd17f1563f9ae412f06a03]
closure_commit: edbcab6980f402b5403fefaf863924c645fdb6be
qualification_refs: [framework/core/src/libyijinjing/tests/mmap_tests.cpp, framework/core/src/libyijinjing/tests/journal_stress_harness.cpp]
review_state: legacy-unreviewed
sensitivity: public
---

# ADR-0001: yijinjing journal frame/page publish protocol → `atomic_ref` release/acquire

- Status: accepted (implemented on this line; ARM adversarial stress test + in-tree compile both pass — see "Gate outcome")
- Date: 2026-06-23
- Category: (b) improvement + latent bug (concurrency correctness)
- Subsystem: yijinjing journal — single-writer / multi-reader, mmap `MAP_SHARED` cross-process page/frame bus
- Related: independent of schema ownership (historical ADR-0002, current
  ADR-0047); this change touches only publish synchronization, not schema or
  on-disk layout

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
- Page initialization uses the same one-token rule. The initializer writes the
  immutable `page_header` facts and initial status first, then stores
  `page_header::last_frame_position` with release. Existing-only readers map
  without create/grow authority, acquire that token before reading the other
  header fields, and reject mismatched lengths, page size, or out-of-range
  offsets before payload access. `status` transitions also use release/acquire.

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
   (`yijinjing schema/types.h`). `length` is promoted to a "publish token" whose
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
- `page_header::last_frame_position` remains a `uint64_t` at offset 24 and is
  now the page-initialization publication token. No page or frame field is
  added, removed, widened, or reordered.
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

### Continued qualification (2026-07-16): from a mirror harness to the production surface

The gate above was decided with a **standalone harness mirroring** the publish
protocol. That proved the protocol choice, but it left the shipped surface
qualified by a model rather than by itself, and it left next direction ① open.
Both are now addressed by `tests/journal_stress_harness.cpp`
(`yijinjing_journal_stress`) and three added `mmap_tests.cpp` cases:

- **Real surface, real processes**: a single writer process and several reader
  processes share the same mmap pages and drive the production `writer` /
  `journal` reader APIs — not a mirror of them. Every frame carries a magic,
  a monotonic sequence and an FNV-1a-64 body hash, so each reader
  content-verifies what the acquire gate let it see. Violations are classified
  as torn body, wrong magic, short frame, gap, or reorder/duplicate.
- **Next direction ① is now covered**: `close_page` must create the next page
  *before* publishing PageEnd — a reader in another process that observes
  PageEnd advances immediately and a plain reader has no authority to create the
  page. That ordering was guarded only by a source comment; it is now pinned by
  a deterministic test that probes from inside the rollover, and it was verified
  against a mutant that publishes PageEnd first (the test fails there). The
  page-switch path is additionally under continuous cross-process load: a 50k
  frame smoke run rolls ~52 pages with three readers verifying every frame.
- **Virgin-page publication**: `page::load` spins on the
  `last_frame_position` token when opening a virgin page without initialization
  authority. A test now proves a concurrent initializer releases that spin and
  that the acquiring reader observes a fully published header rather than the
  zeroed bytes it started from.
- **The evidence can fail**: a clean run proves nothing unless the harness can
  detect. A portable checker self-test (ctest `yijinjing_journal_stress_checker`)
  feeds known-bad streams and asserts each is flagged, and `--inject` modes
  surface corrupt-body / gap / duplicate / reorder faults end-to-end through the
  real cross-process transport; a clean run under injection is reported as a
  failure.

**Boundary — what this does not establish.** These runs execute against the
*fixed* protocol, so they do not reproduce tearing; their value is continuous
detection, not a new verdict. The injections are content and sequence faults,
which prove the reader/checker path surfaces a violation — they are not a
memory-ordering regression. The ARM control equivalent to the volatile-vs-
atomic_ref table above requires rebuilding libyijinjing with a release store
downgraded to relaxed; that procedure is documented in
`tests/JOURNAL_STRESS.md` and is deliberately manual, since the miscompiled
library must never merge.

### Architecture review closeout (2026-07-18)

The follow-up review of the journal layer is closed. It preserved the
release/acquire protocol in this decision and tightened the surrounding code in
three bounded passes:

- [#985](https://github.com/kungfu-systems/kungfu/pull/985) moved concurrency
  evidence onto the production mmap surface, including multi-process stress,
  rollover ordering, virgin-page publication and negative controls.
- [#1024](https://github.com/kungfu-systems/kungfu/pull/1024) removed obsolete
  writer constructors and lock-free adapters, clarified reader merge order, and
  made frame payload capacity checks effective in release builds.
- [#1047](https://github.com/kungfu-systems/kungfu/pull/1047) and
  [#1072](https://github.com/kungfu-systems/kungfu/pull/1072) moved page
  lifecycle selection to an explicit process-boundary policy and replaced the
  reader's log-and-null journal lookup with a typed result mapped at the
  embedding boundary.

**What the closeout established.** Publication correctness is strongest when
the memory-ordering primitive, mutation API, configuration boundary and
failure type all express the same invariant. Tests should exercise the shipped
surface and include a known-bad control; comments remain useful for rationale,
but they are not a substitute for capacity checks, typed results or ownership
boundaries. No frame or page layout, publish token, or release/acquire ordering
changed during this closeout.

## Implementation sites

- `framework/core/src/libkungfu/include/kungfu/yijinjing schema/types.h` (frame_header: drop volatile)
- `framework/core/src/libyijinjing/include/kungfu/yijinjing/journal/frame.h` (acquire/publish/copy)
- `framework/core/src/libyijinjing/src/journal/writer.cpp` (close_frame_lock_free / copy_frame)
- `framework/core/src/libyijinjing/src/journal/page.cpp` (page initialization/status publication and bounds validation)
- `framework/core/src/libyijinjing/src/util/mmap.cpp` (move-only mapping ownership and existing-only reader mapping)
