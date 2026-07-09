// SPDX-License-Identifier: Apache-2.0

#include <kungfu/runtime/storage/source_registry_projection.h>

#include <filesystem>
#include <set>
#include <utility>

#include <kungfu/runtime/cache/backend.h>
#include <kungfu/yijinjing/schema/registry.h>
#include <kungfu/yijinjing/storage/source_registry.h>

namespace fs = std::filesystem;

namespace kungfu::runtime::storage_service_api {

namespace {

fs::path projection_path(const std::string &runtime_dir) {
  return fs::path(runtime_dir) / "storage" / "projections" / "source-registry.sqlite";
}

// Distinct-primary-key journal counts. The SQLite tables upsert by primary key
// (SourceRegistered by source_uid; SourceHeadUpdated by source_uid+update_time;
// AcceptedRangeRecorded by source_uid+manifest_uid), so the honest expected row
// count is the distinct-PK count, not the raw append count.
struct distinct_counts {
  size_t registered = 0;
  size_t head_updates = 0;
  size_t accepted_ranges = 0;
};

distinct_counts distinct_pk_counts(const yijinjing::storage::source_registry_journal_records &records) {
  std::set<uint64_t> registered_uids;
  for (const auto &record : records.registered) {
    registered_uids.insert(record.source_uid);
  }
  std::set<std::pair<uint64_t, int64_t>> head_keys;
  for (const auto &record : records.head_updates) {
    head_keys.emplace(record.source_uid, record.update_time);
  }
  std::set<std::pair<uint64_t, uint64_t>> accepted_keys;
  for (const auto &record : records.accepted_ranges) {
    accepted_keys.emplace(record.source_uid, record.manifest_uid);
  }
  return {registered_uids.size(), head_keys.size(), accepted_keys.size()};
}

} // namespace

source_registry_projection::source_registry_projection(std::string runtime_dir)
    : runtime_dir_(std::move(runtime_dir)) {}

std::string source_registry_projection::sqlite_path() const { return projection_path(runtime_dir_).string(); }

bool source_registry_projection::exists() const { return fs::exists(projection_path(runtime_dir_)); }

nlohmann::json source_registry_projection::rebuild() const {
  const auto path = projection_path(runtime_dir_);
  fs::create_directories(path.parent_path());

  auto storage = cache::make_storage_ptr(path.string(), yijinjing::SourceRegistryDataTypes);
  storage->pragma.journal_mode(sqlite_orm::journal_mode::WAL);
  storage->pragma.synchronous(0);
  storage->sync_schema();

  // The journal is the authority; the projection is a full rebuild over it.
  storage->remove_all<yijinjing::types::SourceRegistered>();
  storage->remove_all<yijinjing::types::SourceHeadUpdated>();
  storage->remove_all<yijinjing::types::AcceptedRangeRecorded>();

  const auto records = yijinjing::storage::source_registry_store(runtime_dir_).read_typed_records();
  for (const auto &record : records.registered) {
    storage->replace(record);
  }
  for (const auto &record : records.head_updates) {
    storage->replace(record);
  }
  for (const auto &record : records.accepted_ranges) {
    storage->replace(record);
  }

  return {
      {"ok", true},
      {"schema", SOURCE_REGISTRY_PROJECTION_SCHEMA_V1},
      {"runtime_dir", runtime_dir_},
      {"authority", "yijinjing-journal"},
      {"projection", "sqlite"},
      {"sqlite_path", path.string()},
      {"rows",
       {{"source_registered", storage->count<yijinjing::types::SourceRegistered>()},
        {"source_head_updated", storage->count<yijinjing::types::SourceHeadUpdated>()},
        {"accepted_range_recorded", storage->count<yijinjing::types::AcceptedRangeRecorded>()}}},
      {"journal_records",
       {{"source_registered", records.registered.size()},
        {"source_head_updated", records.head_updates.size()},
        {"accepted_range_recorded", records.accepted_ranges.size()}}},
  };
}

nlohmann::json source_registry_projection::verify() const {
  const auto path = projection_path(runtime_dir_);
  const auto records = yijinjing::storage::source_registry_store(runtime_dir_).read_typed_records();
  const auto expected = distinct_pk_counts(records);
  const bool has_records =
      !records.registered.empty() || !records.head_updates.empty() || !records.accepted_ranges.empty();

  if (!fs::exists(path)) {
    // Missing projection is a distinct honest state, not a silent ok: if the
    // journal has records, the projection needs a rebuild before SQL queries.
    return {
        {"ok", true},
        {"status", has_records ? "absent" : "ok"},
        {"schema", SOURCE_REGISTRY_PROJECTION_SCHEMA_V1},
        {"runtime_dir", runtime_dir_},
        {"authority", "yijinjing-journal"},
        {"projection_present", false},
        {"note", has_records ? "projection not built; run source_registry_rebuild to enable SQL queries"
                             : "no source-registry records; projection not needed"},
    };
  }

  auto storage = cache::make_storage_ptr(path.string(), yijinjing::SourceRegistryDataTypes);
  storage->on_open = [](sqlite3 *db) { sqlite3_busy_timeout(db, 5000); };
  storage->sync_schema();

  const size_t projected_registered = storage->count<yijinjing::types::SourceRegistered>();
  const size_t projected_head = storage->count<yijinjing::types::SourceHeadUpdated>();
  const size_t projected_accepted = storage->count<yijinjing::types::AcceptedRangeRecorded>();

  nlohmann::json drift = nlohmann::json::array();
  const auto check = [&](const char *table, size_t projected, size_t journal_expected) {
    if (projected != journal_expected) {
      drift.push_back({{"table", table}, {"projection_rows", projected}, {"journal_distinct", journal_expected}});
    }
  };
  check("source_registered", projected_registered, expected.registered);
  check("source_head_updated", projected_head, expected.head_updates);
  check("accepted_range_recorded", projected_accepted, expected.accepted_ranges);

  const bool degraded = !drift.empty();
  return {
      {"ok", !degraded},
      {"status", degraded ? "degraded" : "ok"},
      {"schema", SOURCE_REGISTRY_PROJECTION_SCHEMA_V1},
      {"runtime_dir", runtime_dir_},
      {"authority", "yijinjing-journal"},
      {"projection_present", true},
      {"degraded", degraded},
      {"drift", drift},
      {"rows",
       {{"source_registered", projected_registered},
        {"source_head_updated", projected_head},
        {"accepted_range_recorded", projected_accepted}}},
      {"journal_distinct",
       {{"source_registered", expected.registered},
        {"source_head_updated", expected.head_updates},
        {"accepted_range_recorded", expected.accepted_ranges}}},
  };
}

} // namespace kungfu::runtime::storage_service_api
