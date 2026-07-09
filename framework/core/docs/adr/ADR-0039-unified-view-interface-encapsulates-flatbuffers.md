# ADR-0039: a single kungfu view interface is the sole FlatBuffers access point; raw FB is not called elsewhere

- Status: proposed
- Date: 2026-07-09
- Category: (architecture) memory-safety mechanism — how zero-copy views over
  FlatBuffers buffers are made temporally safe by construction instead of by
  discipline.
- Subsystem: `libkungfu/runtime/cache` (the `.bfbs` reflection projector and
  schema registry), `libkungfu/runtime/schema` (schema compiler), the Python/Node
  bindings that consume them, and — for the zero-cost regime only — the
  `libyijinjing` journal POD read path.
- Related: ADR-0002 makes FlatBuffers the runtime schema over the POD layout;
  ADR-0037 keeps kernel records as Hana POD (FB-independent) and FB for the open
  layer; ADR-0023/0025 gate carrier types. This ADR is orthogonal to the
  Hana-vs-FB substrate split: it governs *how FB is accessed*, not *what uses FB*.

## Context

The zero-copy design's temporal-safety hazard lives entirely in **borrow-heavy
FlatBuffers reflection**: a view (`reflection::Schema*`, a `GetAnyRoot` table,
`GetAnyFieldS` result) points *into* a backing buffer (the `.bfbs` bytes, an FB
buffer) that must outlive it. This already bit the codebase — the `.bfbs` bytes
had to outlive the `reflection::Schema*` because `GetSchema` returns a view, and
a registry that dropped the bytes early left the schema pointer dangling. In C++
nothing ties a bare view's lifetime to its buffer, so the bug is silent
use-after-free and can recur anywhere new raw-FB code is added.

A grounded survey of the current tree shows the hazard is small and localized,
not sprawling:

- The **kernel (`libyijinjing`) uses zero FlatBuffers**. Journal frames are read
  as POD — `reinterpret_cast<frame_header *>(addr)` plus `frame->data<T>()`
  (`journal/frame.h`, `journal/assemble.h`). POD/value access over the long-lived
  journal mmap is temporally safe by construction and language-independent; it is
  not a hazard.
- The entire C++ raw-FB / reflection surface is **~4 files, ~25 call sites**, all
  in `libkungfu/runtime/cache` (`fb_projector.h`, `fb_schema_registry.h`,
  `open_layer_projector.h`) and `libkungfu/runtime/schema` (`schema_compiler.cpp`).
  `fb_projector.h` (the `.bfbs` reflection → SQLite projector) holds most of it and
  is exactly where the dangling-view bug lived.
- The downstream C++ consumer is essentially `bindings/python/binding/py-runtime.cpp`.

So the hazard is confined to the open-layer FB-reflection subsystem, currently
reached through raw `flatbuffers::` / `reflection::` calls that hand out bare
views. Fixing individual bugs is discipline; discipline already failed once.

## Decision

All C++ FlatBuffers and reflection access is encapsulated behind **one kungfu
view interface** (`kungfu::view`, a dedicated module). No code outside that module
calls raw `flatbuffers::` / `reflection::` APIs or obtains a bare FB view or
`reflection::Schema*`.

One interface, two internal regimes:

1. **POD / value access (hot path).** A zero-cost accessor over the long-lived
   journal mmap — the existing `frame->data<T>()` POD read, wrapped without an
   owning handle, without a refcount. The interface must not tax the lock-free
   journal; the POD regime compiles to the same direct pointer-plus-offset read.
2. **Borrow-heavy FB reflection / table access (open layer).** A **safe owning
   handle**: the view co-owns its backing buffer (the `.bfbs` bytes / the FB
   buffer) so it cannot outlive it, or a scoped-access form marked
   `[[clang::lifetimebound]]`. Bare `reflection::Schema*` / `GetAnyRoot` views are
   never handed out.

Untrusted-input parsing (import/accept of a foreign FB buffer) runs
`flatbuffers::Verifier` for bounds-checking *before* any field access, inside the
same interface — spatial safety at the same chokepoint as temporal safety.

Enforcement is a mechanism, not a rule:

- FB and reflection headers/symbols are includable and referenceable **only inside
  the view module**; other modules depend on `kungfu::view`, not on FlatBuffers.
- A **CI gate fails** if `flatbuffers::` or `reflection::` appears outside the view
  module (include-level and symbol-level).
- The reflection and import paths are covered by fuzzing + ASan/UBSan.

| Part | Role |
| --- | --- |
| `kungfu::view` interface | sole entry to FB/reflection; owns buffers; hands out safe handles; runs the verifier on untrusted input |
| POD accessor | zero-cost view over journal mmap frames (hot path) |
| owning FB handle | co-owns the `.bfbs`/FB buffer; no bare `Schema*`/table view escapes |
| CI gate | no raw `flatbuffers::` / `reflection::` outside the view module |

## Consequences

- The `.bfbs`-class dangling-view bug becomes **structurally unrepresentable** in
  kungfu code: you cannot obtain a bare view because you cannot call FB directly.
  The safe pattern is the only pattern.
- FlatBuffers becomes a **swappable implementation detail behind one interface**.
  A future spatial verifier, richer lifetime management, or even reimplementing
  this module in Rust behind FFI happen in one place without touching the rest of
  the tree.
- The **hot path pays nothing** — the POD regime is zero-cost; only the
  low-frequency borrow-heavy reflection paths carry the owning handle, and in the
  per-reader journal model (each reader has its own mapping / is a separate
  process) that handle sees no cross-core refcount contention.
- The surface to audit and fuzz shrinks from "everywhere FB is touched" to one
  module.

## First delivery (staged)

1. **Map** the current raw-FB files and call sites (done: ~4 files, ~25 sites in
   `runtime/cache` + `runtime/schema`; kernel is FB-free).
2. **Define `kungfu::view`** — the zero-cost POD accessor (wrapping
   `frame->data<T>()`), the owning FB handle (co-owns its buffer), and the
   verifier-on-untrusted entry.
3. **Migrate one first slice** — the `fb_projector.h` reflection path (the
   `.bfbs`-bug zone) — through the interface; prove zero-cost POD, safe
   reflection, green build/tests, and no hot-path perf regression (benchmark).
4. **Add the CI gate** allowlisting the view module and failing elsewhere.
5. **Migrate the rest** (`fb_schema_registry`, `open_layer_projector`,
   `schema_compiler`, the `py-runtime` consumer) incrementally, then flip the gate
   to strict.

## Explicitly out of scope

- The kernel POD journal path (`libyijinjing`) — already FB-free and value-safe;
  the POD regime wraps it at zero cost but does not change it.
- Python-side FlatBuffers usage (`rewind`, `work`) — GC-managed, a different
  hazard profile; the principle may extend later, but this ADR is the C++ view
  interface.
- Choosing FB versus another representation, or moving the core to Rust. This ADR
  makes those *contained* future options; it does not decide them.

## Alternatives considered

- **Discipline ("remember to keep the buffer alive").** Rejected. It already
  failed — the `.bfbs` bug — and any API from which a bare view is obtainable rots
  back to discipline.
- **Harden only the import/accept boundary.** Rejected. Too narrow: the `.bfbs`
  bug was internal (the schema registry), not at an import boundary. The hazard is
  "anyone calling raw FB," which is system-wide, so the fix is a system-wide
  chokepoint, not a boundary.
- **`shared_ptr` co-own everywhere, including the hot path.** Rejected. It would
  reintroduce cross-core refcount contention on the lock-free journal; the hot
  path is POD and needs no handle. Co-ownership belongs only on the low-frequency
  borrow-heavy paths.
- **Switch the core to Rust for the borrow checker.** Deferred, and made
  contained: with FB access behind one module, that module could later be
  reimplemented in Rust behind FFI without a whole-core rewrite.

## Residual risk

- The two-regime interface must keep the POD hot path **genuinely zero-cost**; a
  naive design that routes hot frames through the owning handle would tax the
  lock-free journal. Benchmark the hot path before and after.
- The CI gate must catch **include-level leakage** (transitively pulling in
  FlatBuffers through a header), not only direct symbol use.
- Views crossing the binding boundary to a consumer (`py-runtime`, and any Node
  host) must be held as owning handles, not bare pointers, so the backing buffer
  stays alive for the duration of the binding call.
