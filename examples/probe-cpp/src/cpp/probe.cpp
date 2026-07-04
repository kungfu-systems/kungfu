// SPDX-License-Identifier: Apache-2.0
//
// C++ dogfood coverage probe for the v4 kfx build path.
//
// Purpose: prove — at build time — that a standalone kfx extension can compile
// C++ against the libkungfu API, reference its FlatBuffers-generated data
// structures, and link into a native pybind11 module (.so / .dylib / .pyd).
//
// It is deliberately neutral: it depends only on libkungfu (no libwingchun) and
// consumes libkungfu's already-generated FlatBuffers accessors directly, so the
// build needs no separate flatc invocation. Building this module *is* the probe
// — if FlatBuffers codegen or the libkungfu include/ABI surface regresses, this
// stops compiling, so a core capability break shows up as a build failure.

#include <cstdint>

#include <flatbuffers/flatbuffers.h>
#include <kungfu/longfist/fb/order_generated.h> // libkungfu's flatc-generated FB accessors
#include <kungfu/yijinjing/time.h>              // a real (non-inline) libkungfu API symbol

#include <pybind11/pybind11.h>

namespace py = pybind11;
namespace fb = kungfu::longfist::fb;

// Build a FlatBuffers payload with libkungfu's generated schema, then read the
// field back. This exercises, at C++ compile time, the generated header, the
// FlatBuffers runtime, and the libkungfu public include surface.
static std::uint64_t fb_roundtrip(std::uint64_t order_id) {
  flatbuffers::FlatBufferBuilder fbb;
  fb::OrderBuilder builder(fbb);
  builder.add_order_id(order_id);
  fbb.Finish(builder.Finish());
  const fb::Order *decoded = fb::GetOrder(fbb.GetBufferPointer());
  return decoded->order_id();
}

// Call a real libkungfu symbol (not header-only) so the module genuinely links
// against libkungfu — proving the link surface, not just the headers.
static std::int64_t now_in_nano() { return kungfu::yijinjing::time::now_in_nano(); }

PYBIND11_MODULE(probe_cpp, m) {
  m.doc() = "kfx C++ build-time coverage probe: libkungfu + FlatBuffers -> native module";
  m.def("fb_roundtrip", &fb_roundtrip, py::arg("order_id"),
        "Round-trip a value through a libkungfu FlatBuffers Order table.");
  m.def("now_in_nano", &now_in_nano, "Call into libkungfu (yijinjing::time) to prove the link surface.");
}
