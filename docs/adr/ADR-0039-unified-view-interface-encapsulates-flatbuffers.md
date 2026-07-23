---
metadata_schema: kungfu.document-metadata/v1
doc_type: architecture-decision
adr_id: ADR-0039
decision_status: accepted
implementation_status: partial
review_state: legacy-unreviewed
sensitivity: public
---

# ADR-0039: a single kungfu view interface is the sole FlatBuffers access point; raw FB is not called elsewhere

- Status: accepted
- Date: 2026-07-09
- Category: (architecture) memory-safety mechanism — how zero-copy views over
  FlatBuffers buffers are made temporally safe by construction instead of by
  discipline.
- Subsystem: `libkungfu/runtime/projection` (the `.bfbs` reflection projector and
  schema registry), `libkungfu/runtime/schema` (schema compiler), the Python/Node
  bindings that consume them, and — for the zero-cost regime only — the
  `libyijinjing` journal POD read path.
- Related: ADR-0047 assigns authoritative facts to either Hana POD or the
  FlatBuffers open layer; ADR-0037 applies that split to storage records;
  ADR-0023/0025 gate carrier types. This ADR is orthogonal to the
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
  in `libkungfu/runtime/projection` (`flatbuffer.h`,
  `flatbuffer_schema_registry.h`) and `libkungfu/runtime/schema`
  (`schema_compiler.cpp`). The projector holds most of it and
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

1. **Map** the current raw-FB files and call sites (done: 4 files, 25 sites in
   `runtime/projection` + `runtime/schema`; kernel is FB-free). Confirmed against live
   `dev/v4/v4.0`.
2. **Define `kungfu::view`** (done, slice 1) — `pod.h` zero-cost POD accessor
   (wraps `frame->data<T>()`; proven to compile to the identical
   pointer-plus-offset load); `schema_handle` co-owns its `.bfbs` bytes
   (`shared_ptr<const std::string>`) and keeps `reflection::Schema *` private, so
   no bare view escapes; `col_plan` is reflection-free; `VerifySchemaBuffer` runs
   at the `.bfbs` load boundary and `verify_table` guards data frames.
3. **Migrate the first slice** (done, slice 1) — `fb_projector.h` (retired) and
   `fb_schema_registry` onto the handle, plus `open_layer_projector`'s file load;
   full core build green, the projection roundtrip (thin/full/evolve/verify)
   matches the pre-migration behavior, and the POD hot path is unchanged.
4. **Add the CI gate** (done, slice 1) — `check-view-boundary.mjs` (include- and
   symbol-level) wired into `verify.mjs`; allowlists the view module and fails
   elsewhere. `runtime/schema/schema_compiler.cpp` is temporarily allowlisted.
   A `slices/view-encapsulation` probe proves the roundtrip + boundary.
5. **Migrate the rest** (done, slice 2) — `schema_compiler` now delegates the
   `.fbs` -> `.bfbs` compile to `kungfu::view::compile_schema` (keeping only its
   trust-tier policy), and the schema_compiler allowlist is removed so the gate
   is **strict**: no `flatbuffers::` / `reflection::` appears anywhere outside
   `kungfu::view`. The `py-runtime` consumer needs no change — it marshals the
   compiled `.bfbs` bytes across the binding boundary and never holds a bare
   reflection view.

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
