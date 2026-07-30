// SPDX-License-Identifier: Apache-2.0
//
// C++ dogfood coverage probe for the v4 kfx build path.
//
// Purpose: prove — at build time — that a standalone kfx extension can compile
// C++ against the libkungfu API, reference the public yijinjing schema registry,
// and link into a native pybind11 module (.so / .dylib / .pyd).
//
// It is deliberately neutral: it depends only on libkungfu (no product-specific
// trading layer) and consumes libkungfu's public schema/journal headers directly.
// Building this module *is* the probe: if the libkungfu include/ABI surface
// regresses, this stops compiling, so a core capability break shows up as a
// build failure.

#include <cstdint>

#include <kungfu/yijinjing/schema/registry.h> // public yijinjing schema registry
#include <kungfu/yijinjing/time.h>            // a real (non-inline) libkungfu API symbol

#include <pybind11/pybind11.h>

namespace py = pybind11;

// Exercise the public schema registry at C++ compile time.
static std::uint64_t schema_type_count() { return kungfu::yijinjing::AllTypesTags.size(); }

// Call a real libkungfu symbol (not header-only) so the module genuinely links
// against libkungfu — proving the link surface, not just the headers.
static std::int64_t now_in_nano() { return kungfu::yijinjing::time::now_in_nano(); }

PYBIND11_MODULE(probe_cpp, m) {
  m.doc() = "kfx C++ build-time coverage probe: libkungfu + yijinjing schema -> native module";
  m.def("schema_type_count", &schema_type_count, "Return the public yijinjing schema registry size.");
  m.def("now_in_nano", &now_in_nano, "Call into libkungfu (yijinjing::time) to prove the link surface.");
}
