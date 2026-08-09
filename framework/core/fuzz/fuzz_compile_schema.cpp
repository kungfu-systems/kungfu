// SPDX-License-Identifier: Apache-2.0
//
// libFuzzer target: the `.fbs` -> `.bfbs` compile path (kungfu::view::
// compile_schema). The FlatBuffers parser must never crash / UB on arbitrary
// (including hostile) schema text — a sandboxed kfx author supplies this
// (KF-ADR-019f86da-4f90-7e5e-ae22-2a8fc24086f1). On a successful compile the emitted `.bfbs` must round-trip
// through the load boundary in bounds.
#include <kungfu/view/schema.h>

#include <cstdint>
#include <exception>
#include <string>

extern "C" int LLVMFuzzerTestOneInput(const uint8_t *data, size_t size) {
  auto r = kungfu::view::compile_schema(std::string(reinterpret_cast<const char *>(data), size),
                                        /*allow_includes*/ false);
  if (r.ok) {
    try {
      auto h = kungfu::view::schema_handle::from_bytes(r.bfbs);
      (void)h.plan_columns(false);
    } catch (const std::exception &) {
    }
  }
  return 0;
}
