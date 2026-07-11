// SPDX-License-Identifier: Apache-2.0

#include <kungfu/runtime/storage/source_registry_projection.h>

#include <filesystem>
#include <utility>

#include <kungfu/runtime/cache/backend.h>
#include <kungfu/runtime/storage/projection_content.h>
#include <kungfu/runtime/storage/projection_transaction.h>
#include <kungfu/yijinjing/schema/registry.h>
#include <kungfu/yijinjing/storage/source_registry.h>

namespace fs = std::filesystem;

namespace kungfu::runtime::storage_service_api {

namespace {

fs::path projection_path(const std::string &runtime_dir) {
  return fs::path(runtime_dir) / "storage" / "projections" / "source-registry.sqlite";
}

} // namespace

source_registry_projection::source_registry_projection(std::string runtime_dir)
    : runtime_dir_(std::move(runtime_dir)) {}

std::string source_registry_projection::sqlite_path() const { return projection_path(runtime_dir_).string(); }

bool source_registry_projection::exists() const { return fs::exists(projection_path(runtime_dir_)); }

storage_projection_rebuild_result source_registry_projection::rebuild_typed() const {
  const auto path = projection_path(runtime_dir_);
  fs::create_directories(path.parent_path());

  auto storage = cache::make_storage_ptr(path.string(), yijinjing::SourceRegistryDataTypes);
  storage->pragma.journal_mode(sqlite_orm::journal_mode::WAL);
  storage->pragma.synchronous(0);

  const auto records = yijinjing::storage::source_registry_store(runtime_dir_).read_typed_records();
  rebuild_projection_transaction(storage, [&](sqlite3 *) {
    storage->sync_schema();
    // Schema sync, clear, and replay share one connection and transaction. A
    // failed replay therefore leaves the previous readable projection intact.
    storage->remove_all<yijinjing::types::SourceRegistered>();
    storage->remove_all<yijinjing::types::SourceHeadUpdated>();
    storage->remove_all<yijinjing::types::AcceptedRangeRecorded>();
    if (!records.registered.empty()) {
      storage->replace_range(records.registered.begin(), records.registered.end());
    }
    if (!records.head_updates.empty()) {
      storage->replace_range(records.head_updates.begin(), records.head_updates.end());
    }
    if (!records.accepted_ranges.empty()) {
      storage->replace_range(records.accepted_ranges.begin(), records.accepted_ranges.end());
    }
  });

  return {
      true,
      SOURCE_REGISTRY_PROJECTION_SCHEMA_V1,
      runtime_dir_,
      "yijinjing-journal",
      "sqlite",
      path.string(),
      {{"source_registered", static_cast<uint64_t>(storage->count<yijinjing::types::SourceRegistered>())},
       {"source_head_updated", static_cast<uint64_t>(storage->count<yijinjing::types::SourceHeadUpdated>())},
       {"accepted_range_recorded", static_cast<uint64_t>(storage->count<yijinjing::types::AcceptedRangeRecorded>())}},
      {{"source_registered", records.registered.size()},
       {"source_head_updated", records.head_updates.size()},
       {"accepted_range_recorded", records.accepted_ranges.size()}}};
}

storage_projection_verify_result source_registry_projection::verify_typed() const {
  const auto path = projection_path(runtime_dir_);
  const auto records = yijinjing::storage::source_registry_store(runtime_dir_).read_typed_records();
  const auto expected_registered = snapshot_projection_content(records.registered);
  const auto expected_head = snapshot_projection_content(records.head_updates);
  const auto expected_accepted = snapshot_projection_content(records.accepted_ranges);
  const bool has_records =
      !records.registered.empty() || !records.head_updates.empty() || !records.accepted_ranges.empty();

  if (!fs::exists(path)) {
    // Missing projection is a distinct honest state, not a silent ok: if the
    // journal has records, the projection needs a rebuild before SQL queries.
    return {true,
            has_records ? "absent" : "ok",
            SOURCE_REGISTRY_PROJECTION_SCHEMA_V1,
            runtime_dir_,
            "yijinjing-journal",
            false,
            false,
            has_records ? "projection not built; run source_registry_rebuild to enable SQL queries"
                        : "no source-registry records; projection not needed"};
  }

  auto storage = cache::make_storage_ptr(path.string(), yijinjing::SourceRegistryDataTypes);
  storage->on_open = [](sqlite3 *db) { sqlite3_busy_timeout(db, 5000); };
  projection_content_snapshot projected_registered;
  projection_content_snapshot projected_head;
  projection_content_snapshot projected_accepted;
  try {
    projected_registered = snapshot_projection_content(storage->get_all<yijinjing::types::SourceRegistered>());
    projected_head = snapshot_projection_content(storage->get_all<yijinjing::types::SourceHeadUpdated>());
    projected_accepted = snapshot_projection_content(storage->get_all<yijinjing::types::AcceptedRangeRecorded>());
  } catch (const std::exception &error) {
    return {false,
            "degraded",
            SOURCE_REGISTRY_PROJECTION_SCHEMA_V1,
            runtime_dir_,
            "yijinjing-journal",
            true,
            true,
            "projection schema unreadable; rebuild required: " + std::string(error.what()),
            {{"__schema__", 0, 0, "schema_unreadable"}}};
  } catch (...) {
    return {false,
            "degraded",
            SOURCE_REGISTRY_PROJECTION_SCHEMA_V1,
            runtime_dir_,
            "yijinjing-journal",
            true,
            true,
            "projection schema unreadable; rebuild required",
            {{"__schema__", 0, 0, "schema_unreadable"}}};
  }

  std::vector<storage_projection_drift> drift;
  const auto check = [&](const char *table, const projection_content_snapshot &projected,
                         const projection_content_snapshot &journal) {
    if (projected.digest != journal.digest) {
      drift.push_back({table, projected.rows, journal.rows,
                       projected.rows == journal.rows ? "content_mismatch" : "row_count_mismatch", projected.digest,
                       journal.digest});
    }
  };
  check("source_registered", projected_registered, expected_registered);
  check("source_head_updated", projected_head, expected_head);
  check("accepted_range_recorded", projected_accepted, expected_accepted);

  const bool degraded = !drift.empty();
  return {!degraded,
          degraded ? "degraded" : "ok",
          SOURCE_REGISTRY_PROJECTION_SCHEMA_V1,
          runtime_dir_,
          "yijinjing-journal",
          true,
          degraded,
          {},
          std::move(drift),
          {{"source_registered", projected_registered.rows},
           {"source_head_updated", projected_head.rows},
           {"accepted_range_recorded", projected_accepted.rows}},
          {{"source_registered", expected_registered.rows},
           {"source_head_updated", expected_head.rows},
           {"accepted_range_recorded", expected_accepted.rows}}};
}

} // namespace kungfu::runtime::storage_service_api
