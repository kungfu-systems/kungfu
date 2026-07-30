// SPDX-License-Identifier: Apache-2.0
//
// libFuzzer target: the data-frame access boundary (kungfu::view::schema_handle::
// bind_frame). Against a fixed schema, feed arbitrary frame bytes: bind_frame
// verifies the buffer before any field access, so a malformed/truncated frame
// must be skipped (returns nullopt), never drive an out-of-bounds reflection
// read (KF-ADR-019f86da-4f90-7a66-b427-f4bcd638d8bc spatial safety). A crash under ASan/UBSan is a hole in that
// verify-before-access boundary.
#include <kungfu/view/schema.h>

#include <sqlite3.h>

#include <cstdint>
#include <string>
#include <vector>

using namespace kungfu;

namespace {
// Built once: a valid schema + its column plan + an in-memory prepared insert.
struct fixture {
  view::schema_handle handle;
  std::vector<view::col_plan> cols;
  sqlite3 *db = nullptr;
  sqlite3_stmt *ins = nullptr;

  fixture() {
    auto compiled = view::compile_schema(
        "attribute \"pk\";\ntable Q { id: long (pk); ts: long; price: double; sym: string; }\nroot_type Q;\n", false);
    handle = view::schema_handle::from_bytes(compiled.bfbs);
    cols = handle.plan_columns(false);
    sqlite3_open(":memory:", &db);
    const std::string ddl = view::create_ddl(cols, "q", false);
    sqlite3_exec(db, ddl.c_str(), nullptr, nullptr, nullptr);
    const std::string sql = view::insert_sql(cols, "q", false);
    sqlite3_prepare_v2(db, sql.c_str(), -1, &ins, nullptr);
  }
};
} // namespace

extern "C" int LLVMFuzzerTestOneInput(const uint8_t *data, size_t size) {
  static fixture fx;
  sqlite3_reset(fx.ins);
  sqlite3_clear_bindings(fx.ins);
  // verify-before-access: a bad buffer returns nullopt and binds nothing; a
  // good one binds + steps. Neither may read out of bounds.
  if (fx.handle.bind_frame(fx.ins, fx.cols, data, size).has_value())
    sqlite3_step(fx.ins);
  return 0;
}
