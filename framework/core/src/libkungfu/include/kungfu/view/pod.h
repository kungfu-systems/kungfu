// SPDX-License-Identifier: Apache-2.0
//
// kungfu::view regime 1 — zero-cost POD accessor (ADR-0039).
//
// The kernel (libyijinjing) reads journal frames as plain POD over a long-lived
// mmap: `reinterpret_cast<frame_header *>(addr)` then `frame->data<T>()`. That
// access is temporally safe by construction (the mapping outlives every read)
// and carries no FlatBuffers. This accessor is the unified-interface face of
// that read: it wraps the same pointer-plus-offset load with **no owning
// handle and no refcount**, so the lock-free hot path pays nothing. It exists so
// callers reach POD frame payloads through `kungfu::view` like every other view,
// not so the kernel gains a dependency — the kernel keeps using `frame->data<T>()`
// directly and is never forced to include this header.
//
// Regime 2 (borrow-heavy FlatBuffers reflection over the open layer) lives in
// kungfu/view/schema.h; the two regimes never mix ownership models.
#ifndef KUNGFU_VIEW_POD_H
#define KUNGFU_VIEW_POD_H

namespace kungfu::view {

// Zero-cost typed view over a POD frame payload living in a longer-lived buffer
// (the journal mmap). Compiles to the identical load as a direct
// `*reinterpret_cast<const T *>(frame_data)` — no bounds check, no handle, no
// refcount — and is only valid while that backing buffer is mapped. Use for the
// hot path; never for FlatBuffers-backed open-layer data (that goes through the
// owning schema_handle, which co-owns its buffer).
template <class T> [[nodiscard]] inline const T &pod(const void *frame_data) noexcept {
  return *static_cast<const T *>(frame_data);
}

} // namespace kungfu::view

#endif // KUNGFU_VIEW_POD_H
