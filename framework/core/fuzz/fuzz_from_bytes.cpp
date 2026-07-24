// SPDX-License-Identifier: Apache-2.0
//
// libFuzzer target: the `.bfbs` load boundary (kungfu::view::schema_handle::
// from_bytes). VerifySchemaBuffer must reject every malformed/truncated buffer
// by throwing — never a UB / out-of-bounds read (KF-ADR-019f86da-4f90-7a66-b427-f4bcd638d8bc). A crash here under
// ASan/UBSan is a real spatial-safety hole in the schema-load boundary.
#include <kungfu/view/schema.h>

#include <cstdint>
#include <exception>
#include <string>

extern "C" int LLVMFuzzerTestOneInput(const uint8_t *data, size_t size) {
  try {
    auto h = kungfu::view::schema_handle::from_bytes(std::string(reinterpret_cast<const char *>(data), size));
    // If from_bytes accepted the buffer, reflecting it must also stay in bounds.
    (void)h.plan_columns(true);
    (void)h.plan_columns(false);
  } catch (const std::exception &) {
    // Expected on malformed input: rejected, not dereferenced.
  }
  return 0;
}
