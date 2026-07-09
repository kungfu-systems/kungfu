// SPDX-License-Identifier: Apache-2.0
//
// view-encapsulation slice probe (ADR-0039).
//
// Proves the open-layer FlatBuffers reflection projection works end to end
// through the kungfu::view chokepoint — and that the module needs ONLY
// FlatBuffers + SQLite, not the trading runtime (this target links neither
// yijinjing nor libkungfu; it compiles src/view/schema.cpp directly). A red run
// means the sole-FB-access-point interface regressed: the projection roundtrip,
// the schema-evolution path, or the untrusted-input verifier.
#include <kungfu/view/schema.h>

#include <flatbuffers/idl.h>
#include <sqlite3.h>

#include <cassert>
#include <cstdint>
#include <cstdio>
#include <string>

using namespace kungfu;

static const char *FBS = R"fbs(
attribute "pk";
attribute "ts";
attribute "status";
table Quote {
  id: long (pk);
  ts_ns: long (ts);
  state: int (status);
  price: double;
  symbol: string;
}
root_type Quote;
)fbs";

static const char *FBS2 = R"fbs(
attribute "pk";
attribute "ts";
attribute "status";
table Quote {
  id: long (pk);
  ts_ns: long (ts);
  state: int (status);
  price: double;
  symbol: string;
  volume: long;
}
root_type Quote;
)fbs";

static const char *JSON = R"({ "id": 42, "ts_ns": 1000, "state": 3, "price": 3.5, "symbol": "AAPL" })";

static std::string make_bfbs(const char *fbs) {
  flatbuffers::Parser p;
  assert(p.Parse(fbs));
  p.Serialize();
  return std::string(reinterpret_cast<const char *>(p.builder_.GetBufferPointer()), p.builder_.GetSize());
}

static std::string make_data(const char *fbs, const char *json) {
  flatbuffers::Parser p;
  assert(p.Parse(fbs));
  assert(p.ParseJson(json));
  return std::string(reinterpret_cast<const char *>(p.builder_.GetBufferPointer()), p.builder_.GetSize());
}

int main() {
  // compile .fbs -> .bfbs through the view chokepoint (the sole FB compile entry)
  auto compiled = view::compile_schema(FBS, /*allow_includes*/ false);
  assert(compiled.ok && !compiled.bfbs.empty() && compiled.error.empty());
  auto bad = view::compile_schema("table Broken { : }", false);
  assert(!bad.ok && !bad.error.empty() && bad.bfbs.empty()); // never throws on bad input
  const std::string bfbs = compiled.bfbs;

  const std::string data = make_data(FBS, JSON);
  const auto *dbuf = reinterpret_cast<const uint8_t *>(data.data());

  // construct + verifier at the untrusted-input boundary
  auto h = view::schema_handle::from_bytes(bfbs);
  assert(h.valid());
  assert(h.verify_table(dbuf, data.size()));
  assert(!h.verify_table(dbuf, 4)); // truncated → rejected
  bool threw = false;
  try {
    view::schema_handle::from_bytes(std::string("not a bfbs buffer"));
  } catch (const std::exception &) {
    threw = true;
  }
  assert(threw); // malformed .bfbs rejected, not dereferenced

  // column planning: thin projects pk/ts/status only; full projects all
  auto thin = h.plan_columns(true);
  auto full = h.plan_columns(false);
  assert(thin.size() == 3);
  assert(full.size() == 5);

  sqlite3 *db = nullptr;
  assert(sqlite3_open(":memory:", &db) == SQLITE_OK);

  // thin projection roundtrip (business columns + journal loop-back coordinates)
  auto ddl = view::create_ddl(thin, "quote", true);
  assert(sqlite3_exec(db, ddl.c_str(), nullptr, nullptr, nullptr) == SQLITE_OK);
  auto ins = view::insert_sql(thin, "quote", true);
  sqlite3_stmt *st = nullptr;
  assert(sqlite3_prepare_v2(db, ins.c_str(), -1, &st, nullptr) == SQLITE_OK);
  auto next = h.bind_frame(st, thin, dbuf, data.size());
  assert(next.has_value()); // valid frame verifies + binds
  sqlite3_bind_int64(st, *next, 1000);
  sqlite3_bind_int64(st, *next + 1, 7);
  sqlite3_bind_int64(st, *next + 2, 9);
  assert(sqlite3_step(st) == SQLITE_DONE);
  sqlite3_finalize(st);
  assert(sqlite3_prepare_v2(db, "SELECT id, ts_ns, state, kf_gen_time, kf_frame_uid, kf_stream_id FROM quote", -1, &st,
                            nullptr) == SQLITE_OK);
  assert(sqlite3_step(st) == SQLITE_ROW);
  assert(sqlite3_column_int64(st, 0) == 42);
  assert(sqlite3_column_int64(st, 1) == 1000);
  assert(sqlite3_column_int64(st, 2) == 3);
  assert(sqlite3_column_int64(st, 3) == 1000);
  assert(sqlite3_column_int64(st, 4) == 7);
  assert(sqlite3_column_int64(st, 5) == 9);
  sqlite3_finalize(st);

  // full projection: double + string bind via reflection
  auto ddl2 = view::create_ddl(full, "quote_full", false);
  assert(sqlite3_exec(db, ddl2.c_str(), nullptr, nullptr, nullptr) == SQLITE_OK);
  auto ins2 = view::insert_sql(full, "quote_full", false);
  assert(sqlite3_prepare_v2(db, ins2.c_str(), -1, &st, nullptr) == SQLITE_OK);
  assert(h.bind_frame(st, full, dbuf, data.size()).has_value());
  assert(sqlite3_step(st) == SQLITE_DONE);
  sqlite3_finalize(st);
  assert(sqlite3_prepare_v2(db, "SELECT price, symbol FROM quote_full", -1, &st, nullptr) == SQLITE_OK);
  assert(sqlite3_step(st) == SQLITE_ROW);
  assert(sqlite3_column_double(st, 0) == 3.5);
  assert(std::string(reinterpret_cast<const char *>(sqlite3_column_text(st, 1))) == "AAPL");
  sqlite3_finalize(st);

  // spatial safety: a malformed/truncated frame is verified-and-skipped, never
  // dereferenced — bind_frame returns nullopt and binds nothing.
  assert(sqlite3_prepare_v2(db, ins.c_str(), -1, &st, nullptr) == SQLITE_OK);
  assert(!h.bind_frame(st, thin, dbuf, 4).has_value()); // truncated
  const uint8_t garbage[16] = {0xff, 0xff, 0xff, 0xff, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0};
  assert(!h.bind_frame(st, thin, garbage, sizeof(garbage)).has_value()); // bad offsets
  sqlite3_finalize(st);

  // schema evolution: co-owned bytes swap, re-plan, ALTER picks up the new column
  h.evolve(make_bfbs(FBS2));
  auto full2 = h.plan_columns(false);
  assert(full2.size() == 6);
  auto added = view::alter_add_missing(db, full2, "quote_full");
  assert(added.size() == 1 && added[0] == "volume");

  sqlite3_close(db);
  std::printf("OK: kungfu::view projection roundtrip (thin+full+evolve+verify) holds; no runtime linked\n");
  return 0;
}
