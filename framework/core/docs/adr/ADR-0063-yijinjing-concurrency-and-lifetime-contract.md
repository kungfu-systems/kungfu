# ADR-0063: yijinjing separates lock-free publication from cursor, write, and page-lifetime ownership

- Status: proposed
- Date: 2026-07-12
- Category: (b) correctness + contract clarification
- Subsystem: `libyijinjing` journal writer, reader cursor, page resource management
- Related: [ADR-0001](ADR-0001-yijinjing-publish-barrier.md),
  [ADR-0058](ADR-0058-yijinjing-explicit-mapping-policies.md),
  [ADR-0062](ADR-0062-journal-container-epoch-and-offline-conversion.md),
  [ADR-0064](ADR-0064-runtime-error-propagation-and-stop-ownership.md)

## Context

ADR-0001 gives yijinjing a correct release/acquire publication protocol: one
writer publishes a frame by storing its `length` token last, and readers acquire
that token before inspecting the frame. That decision makes frame visibility
tear-free and lets many processes poll a published tail without a coordinating
mutex. It does not make every operation on `writer`, `reader`, `journal`, or
`page` lock-free or generally thread-safe.

The current object model blurs those boundaries:

- `writer::open_frame()` acquires `writer_mtx_` manually and
  `writer::close_frame()` releases it. Exceptions during page rollover, hooks,
  payload construction, or commit can strand the lock. A caller that never
  closes an opened frame has the same effect. The `*_lock_free` variants expose
  mutable writer/journal state without serialization and may still map pages,
  allocate, take other locks, or perform file operations.
- `reader` owns a mutable journal map, current cursor, and sort buffers. It
  declares a recursive mutex but does not use it. The live resource-management
  worker concurrently calls `preload_next_page()` and `release_page()` while the
  pump thread can join, disjoin, or advance journals, so unsynchronised map
  iteration is a real execution path rather than a hypothetical API misuse.
- Passed pages are retained in shared ownership and released by polling
  `shared_ptr::use_count()` every microsecond until one owner remains. A held
  page can block the resource worker indefinitely, and reference-count
  observation has become an implicit scheduling protocol.
- `recursive_mutex` hides ownership and re-entry questions in paths whose
  current call graph does not require recursive locking.

These are separate from the on-disk layout and publication barrier. Fixing them
must not put a contended lock or refcount increment into the cross-process frame
publication/read hot path.

## Proposed decision

### 1. Preserve the single-logical-writer, multi-reader publication model

One logical writer owns a journal append cursor. Many readers may observe
published frames through the ADR-0001 acquire gate. "Lock-free" is reserved for
that publication/tail-read protocol and for operations whose complete call path
is demonstrably lock-free.

The writer object itself, page rollover, mapping, discovery, reader membership,
and page reclamation are not claimed to be lock-free.

### 2. Make a frame write an RAII transaction

The primary writer API returns a move-only write transaction that owns the
writer serialization token from reservation until commit or abort:

```cpp
auto tx = writer.reserve_frame(trigger_time, carrier_type, length, stream_id);
std::memcpy(tx.data(), payload, length);
tx.commit(length, gen_time);
```

- `commit()` completes header/payload writes, publishes `length` last with the
  ADR-0001 release store, advances the cursor, releases serialization, and only
  then notifies the publisher.
- Destruction before commit aborts the reservation: the frame remains
  unpublished, transient writer state is cleared, and serialization is
  released. Abort does not advance the journal cursor.
- Hook failures and page-rollover failures follow the same abort path.
- High-level `write`, `mark`, recorder, replay, and binding surfaces migrate to
  the transaction API so ordinary callers cannot accidentally split ownership
  across two unrelated calls.

The existing `open_frame()` / `close_frame()` pair remains temporarily as a
deprecated compatibility adapter. The existing `open_frame_lock_free()` /
`close_frame_lock_free()` names are deprecated; any necessary internal
single-owner primitive is private and named `*_unserialized`, not lock-free.

### 3. Define reader as a single-consumer cursor with a concurrent management boundary

The current `reader` cursor is thread-affine:

- `data_available()`, `current_frame()`, `next()`, sorting, and seeking are
  driven by one consumer thread.
- A returned frame view is valid only under its documented page lease and must
  not imply that the mutable cursor can be advanced concurrently.
- Debug builds record/assert the cursor owner thread so accidental cross-thread
  consumption fails close during development.

Management operations are made safe without locking the read hot path:

- journal membership and the map are protected by a non-recursive mutex;
- the resource worker obtains a snapshot of `shared_ptr<journal>` values under
  that mutex, releases the mutex, then preloads or releases pages from the
  snapshot;
- `get_journals()` no longer exposes a reference to the mutable internal map;
  callers receive a snapshot or a bounded visitation API;
- joins/disjoins that must change cursor order are applied on the cursor owner
  thread or through an explicit command handoff, rather than racing `next()`.

This ADR does not promise a generally multi-consumer reader. A future
`synchronized_reader` may provide that surface with immutable frame/page leases,
but it must be a separate type so the zero-copy single-consumer cost remains
visible.

### 4. Reclaim pages by ownership completion, not refcount polling

`release_page()` drops the journal/resource-manager ownership promptly and does
not wait for external page leases.

If unmapping must occur on a designated resource thread, page allocation uses a
custom deleter backed by a `page_reclaimer` queue:

- the final shared owner enqueues the page for destruction;
- a condition-variable-driven worker performs destruction/unmap;
- shutdown stops admission, drains the queue, and joins the worker;
- a deleter that outlives the reclaimer has an explicit safe fallback rather
  than dereferencing destroyed queue state.

If qualification proves that unmapping on the final owner's thread is safe and
cheap on every supported host, the smaller implementation is allowed: rely on
ordinary `shared_ptr` last-owner destruction and remove the reclaimer entirely.
Both valid implementations eliminate `use_count()` polling; the qualification
decides whether designated-thread unmapping is necessary.

### 5. Use non-recursive locks and explicit locked/unlocked helpers

Reader membership, page-load coordination, and passed-page collection use
`std::mutex` unless a reviewed call graph demonstrates unavoidable re-entry.
Nested operations are expressed as private `*_locked` / `*_unlocked` helpers
instead of selecting `recursive_mutex` as insurance.

## Compatibility and migration

- No page/frame field, alignment, epoch, publication token, or mmap format
  changes.
- The first implementation slice adds the RAII transaction and migrates
  in-tree callers while retaining deprecated compatibility methods.
- The second slice establishes the reader management snapshot and thread-affine
  cursor contract.
- The third slice qualifies and replaces page reclamation, then removes
  recursive locking and stale compatibility names.
- Python and Node bindings keep their current high-level write/read behavior;
  they surface the safer C++ ownership model rather than exposing a raw
  transaction unless a consumer requirement justifies it.

Removal of deprecated methods requires a separately declared compatibility
window and a repository-wide consumer scan.

## Alternatives considered

- **Add a coarse recursive mutex to every reader method.** Rejected: it hides
  cursor ownership, does not make returned mutable frame pointers safe after the
  lock is released, and taxes the common single-consumer path.
- **Store a `unique_lock` inside `writer` between open and close.** Rejected as
  the primary model: it still leaves transaction ownership implicit and cannot
  reliably distinguish caller abandonment from an active reservation.
- **Keep microsecond polling but add a timeout/backoff.** Rejected: it bounds
  one symptom while retaining refcount observation as a scheduling protocol.
- **Adopt hazard pointers or epoch-based reclamation immediately.** Deferred:
  page rollover is not yet shown to need that complexity. A custom deleter or
  ordinary last-owner destruction is easier to audit and sufficient unless
  benchmarks falsify it.
- **Rename only the lock-free methods.** Rejected as incomplete: terminology is
  one symptom of missing ownership and thread-affinity contracts.

## Acceptance and verification gates

Before this ADR can become accepted/implemented:

1. Exception-injection tests cover reservation, page rollover, open/close hooks,
   payload construction, commit, and publisher notification; a subsequent write
   must succeed after every injected failure.
2. ThreadSanitizer stress covers pump-thread cursor use concurrent with resource
   snapshots, join/disjoin handoff, preload, release, and shutdown.
3. A held page lease must not make `release_page()` busy-wait or block the
   resource worker; final release must unmap exactly once.
4. Reclaimer shutdown/drain and late-deleter fallback are deterministic and
   leak-free on macOS, Linux, and Windows, or qualification chooses ordinary
   last-owner destruction instead.
5. ARM and x86 publication stress from ADR-0001 remains tear-free.
6. Before/after benchmarks report append throughput, tail-read throughput,
   page-rollover latency, CPU time, and allocation/refcount cost. The transaction
   wrapper must not add synchronization to published-frame reads.
7. Public docs and API names describe single-writer, reader cursor affinity,
   and the exact lock-free boundary consistently.

## Consequences

- Failure paths become recoverable without deadlocking a writer or resource
  worker.
- Thread safety is stated as a composable contract instead of inferred from a
  mutex member or `shared_ptr` use.
- The page lifecycle gains an explicit owner and shutdown protocol.
- Migration adds temporary API surface and tests, but the compatibility period
  is bounded and observable.
- The lock-free claim becomes narrower and stronger: publication and tail reads
  retain their proof; unrelated operations stop borrowing that label.
