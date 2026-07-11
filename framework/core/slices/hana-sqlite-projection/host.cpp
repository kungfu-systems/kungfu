// SPDX-License-Identifier: Apache-2.0

#include <kungfu/runtime/cache/sqlite_orm_ext.h>

#include <array>
#include <cstdint>
#include <cstdio>
#include <stdexcept>
#include <vector>

namespace {

enum class sample_state : int32_t { ready = 7 };

bool exec(sqlite3 *db, const char *sql) { return sqlite3_exec(db, sql, nullptr, nullptr, nullptr) == SQLITE_OK; }

} // namespace

int main() {
  sqlite3 *db = nullptr;
  if (sqlite3_open(":memory:", &db) != SQLITE_OK ||
      !exec(db, "CREATE TABLE roundtrip (state INTEGER, fixed BLOB, dynamic BLOB)")) {
    return 1;
  }

  sqlite3_stmt *insert = nullptr;
  if (sqlite3_prepare_v2(db, "INSERT INTO roundtrip VALUES (?, ?, ?)", -1, &insert, nullptr) != SQLITE_OK) {
    return 2;
  }
  const uint32_t fixed_values[] = {UINT32_C(0x01020304), UINT32_C(0xa0b0c0d0), UINT32_C(0xffffffff)};
  const kungfu::array<uint32_t, 3> fixed{fixed_values};
  const std::vector<uint32_t> dynamic{UINT32_C(0x11223344), UINT32_C(0x55667788), UINT32_C(0x99aabbcc)};
  sqlite_orm::statement_binder<sample_state>{}.bind(insert, 1, sample_state::ready);
  sqlite_orm::statement_binder<kungfu::array<uint32_t, 3>>{}.bind(insert, 2, fixed);
  sqlite_orm::statement_binder<std::vector<uint32_t>>{}.bind(insert, 3, dynamic);
  if (sqlite3_step(insert) != SQLITE_DONE) {
    return 3;
  }
  sqlite3_finalize(insert);

  sqlite3_stmt *select = nullptr;
  if (sqlite3_prepare_v2(db, "SELECT state, fixed, dynamic FROM roundtrip", -1, &select, nullptr) != SQLITE_OK ||
      sqlite3_step(select) != SQLITE_ROW) {
    return 4;
  }
  const auto extracted_state = sqlite_orm::row_extractor<sample_state>{}.extract(select, 0);
  const auto extracted_fixed = sqlite_orm::row_extractor<kungfu::array<uint32_t, 3>>{}.extract(select, 1);
  const auto extracted_dynamic = sqlite_orm::row_extractor<std::vector<uint32_t>>{}.extract(select, 2);
  sqlite3_finalize(select);
  sqlite3_close(db);

  if (extracted_state != sample_state::ready || extracted_dynamic != dynamic) {
    return 5;
  }
  for (size_t index = 0; index < std::size(fixed_values); ++index) {
    if (extracted_fixed.value[index] != fixed_values[index]) {
      return 6;
    }
  }

  if (sqlite3_open(":memory:", &db) != SQLITE_OK || !exec(db, "CREATE TABLE malformed (value BLOB)") ||
      !exec(db, "INSERT INTO malformed VALUES (x'010203')")) {
    return 7;
  }
  if (sqlite3_prepare_v2(db, "SELECT value FROM malformed", -1, &select, nullptr) != SQLITE_OK ||
      sqlite3_step(select) != SQLITE_ROW) {
    return 8;
  }
  bool malformed_rejected = false;
  try {
    static_cast<void>(sqlite_orm::row_extractor<std::vector<uint32_t>>{}.extract(select, 0));
  } catch (const std::runtime_error &) {
    malformed_rejected = true;
  }
  sqlite3_finalize(select);
  sqlite3_close(db);
  if (!malformed_rejected) {
    return 9;
  }

  std::printf("{\"enum\":true,\"fixed_blob\":true,\"vector_blob\":true,\"malformed_rejected\":true,\"ok\":true}\n");
  return 0;
}
