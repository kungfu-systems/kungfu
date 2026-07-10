// SPDX-License-Identifier: Apache-2.0

#include <kungfu/runtime/storage/manifest_catalog_projection.h>

#include <filesystem>
#include <set>
#include <utility>

#include <kungfu/runtime/cache/backend.h>
#include <kungfu/yijinjing/schema/registry.h>
#include <kungfu/yijinjing/storage/manifest_catalog.h>

namespace fs = std::filesystem;

namespace kungfu::runtime::storage_service_api {

namespace {

fs::path projection_path(const std::string &runtime_dir) {
  return fs::path(runtime_dir) / "storage" / "projections" / "manifest-catalog.sqlite";
}

// Distinct-primary-key journal counts. The SQLite tables upsert by primary key
// (ImportManifestAccepted by manifest_uid; ManifestEntryRecorded by
// manifest_uid+entry_index; ExportBundleRecorded by bundle_uid+export_time;
// ChannelCursorUpdated by channel_uid+update_time), so the honest expected row
// count is the distinct-PK count, not the raw append count.
struct distinct_counts {
  size_t manifests = 0;
  size_t entries = 0;
  size_t exports = 0;
  size_t cursors = 0;
};

distinct_counts distinct_pk_counts(const yijinjing::storage::manifest_catalog_journal_records &records) {
  std::set<uint64_t> manifest_uids;
  for (const auto &record : records.manifests) {
    manifest_uids.insert(record.manifest_uid);
  }
  std::set<std::pair<uint64_t, uint64_t>> entry_keys;
  for (const auto &record : records.entries) {
    entry_keys.emplace(record.manifest_uid, record.entry_index);
  }
  std::set<std::pair<uint64_t, int64_t>> export_keys;
  for (const auto &record : records.exports) {
    export_keys.emplace(record.bundle_uid, record.export_time);
  }
  std::set<std::pair<uint64_t, int64_t>> cursor_keys;
  for (const auto &record : records.cursors) {
    cursor_keys.emplace(record.channel_uid, record.update_time);
  }
  return {manifest_uids.size(), entry_keys.size(), export_keys.size(), cursor_keys.size()};
}

} // namespace

manifest_catalog_projection::manifest_catalog_projection(std::string runtime_dir)
    : runtime_dir_(std::move(runtime_dir)) {}

std::string manifest_catalog_projection::sqlite_path() const { return projection_path(runtime_dir_).string(); }

bool manifest_catalog_projection::exists() const { return fs::exists(projection_path(runtime_dir_)); }

nlohmann::json manifest_catalog_projection::rebuild() const {
  const auto path = projection_path(runtime_dir_);
  fs::create_directories(path.parent_path());

  auto storage = cache::make_storage_ptr(path.string(), yijinjing::ManifestCatalogDataTypes);
  storage->pragma.journal_mode(sqlite_orm::journal_mode::WAL);
  storage->pragma.synchronous(0);
  storage->sync_schema();

  // The journal is the authority; the projection is a full rebuild over it.
  storage->remove_all<yijinjing::types::ImportManifestAccepted>();
  storage->remove_all<yijinjing::types::ManifestEntryRecorded>();
  storage->remove_all<yijinjing::types::ExportBundleRecorded>();
  storage->remove_all<yijinjing::types::ChannelCursorUpdated>();

  const auto records = yijinjing::storage::manifest_catalog_store(runtime_dir_).read_typed_records();
  for (const auto &record : records.manifests) {
    storage->replace(record);
  }
  for (const auto &record : records.entries) {
    storage->replace(record);
  }
  for (const auto &record : records.exports) {
    storage->replace(record);
  }
  for (const auto &record : records.cursors) {
    storage->replace(record);
  }

  return {
      {"ok", true},
      {"schema", MANIFEST_CATALOG_PROJECTION_SCHEMA_V1},
      {"runtime_dir", runtime_dir_},
      {"authority", "yijinjing-journal"},
      {"projection", "sqlite"},
      {"sqlite_path", path.string()},
      {"rows",
       {{"import_manifest_accepted", storage->count<yijinjing::types::ImportManifestAccepted>()},
        {"manifest_entry_recorded", storage->count<yijinjing::types::ManifestEntryRecorded>()},
        {"export_bundle_recorded", storage->count<yijinjing::types::ExportBundleRecorded>()},
        {"channel_cursor_updated", storage->count<yijinjing::types::ChannelCursorUpdated>()}}},
      {"journal_records",
       {{"import_manifest_accepted", records.manifests.size()},
        {"manifest_entry_recorded", records.entries.size()},
        {"export_bundle_recorded", records.exports.size()},
        {"channel_cursor_updated", records.cursors.size()}}},
  };
}

nlohmann::json manifest_catalog_projection::verify() const {
  const auto path = projection_path(runtime_dir_);
  const auto records = yijinjing::storage::manifest_catalog_store(runtime_dir_).read_typed_records();
  const auto expected = distinct_pk_counts(records);
  const bool has_records =
      !records.manifests.empty() || !records.entries.empty() || !records.exports.empty() || !records.cursors.empty();

  if (!fs::exists(path)) {
    // Missing projection is a distinct honest state, not a silent ok: if the
    // journal has records, the projection needs a rebuild before SQL queries.
    return {
        {"ok", true},
        {"status", has_records ? "absent" : "ok"},
        {"schema", MANIFEST_CATALOG_PROJECTION_SCHEMA_V1},
        {"runtime_dir", runtime_dir_},
        {"authority", "yijinjing-journal"},
        {"projection_present", false},
        {"note", has_records ? "projection not built; run rebuild_index to enable SQL queries"
                             : "no manifest-catalog records; projection not needed"},
    };
  }

  auto storage = cache::make_storage_ptr(path.string(), yijinjing::ManifestCatalogDataTypes);
  storage->on_open = [](sqlite3 *db) { sqlite3_busy_timeout(db, 5000); };
  storage->sync_schema();

  const size_t projected_manifests = storage->count<yijinjing::types::ImportManifestAccepted>();
  const size_t projected_entries = storage->count<yijinjing::types::ManifestEntryRecorded>();
  const size_t projected_cursors = storage->count<yijinjing::types::ChannelCursorUpdated>();

  // Freshness is judged on the current-view families (manifests, entries,
  // cursors): those change only when new content is accepted, and a stale
  // cache there means queries answer from old facts. Export receipts are an
  // append-only audit stream on the read path — every export appends one —
  // so receipt lag between rebuilds is expected and is not drift.
  nlohmann::json drift = nlohmann::json::array();
  const auto check = [&](const char *table, size_t projected, size_t journal_expected) {
    if (projected != journal_expected) {
      drift.push_back({{"table", table}, {"projection_rows", projected}, {"journal_distinct", journal_expected}});
    }
  };
  check("import_manifest_accepted", projected_manifests, expected.manifests);
  check("manifest_entry_recorded", projected_entries, expected.entries);
  check("channel_cursor_updated", projected_cursors, expected.cursors);

  const bool degraded = !drift.empty();
  return {
      {"ok", !degraded},
      {"status", degraded ? "degraded" : "ok"},
      {"schema", MANIFEST_CATALOG_PROJECTION_SCHEMA_V1},
      {"runtime_dir", runtime_dir_},
      {"authority", "yijinjing-journal"},
      {"projection_present", true},
      {"degraded", degraded},
      {"drift", drift},
      {"rows",
       {{"import_manifest_accepted", projected_manifests},
        {"manifest_entry_recorded", projected_entries},
        {"channel_cursor_updated", projected_cursors}}},
      {"journal_distinct",
       {{"import_manifest_accepted", expected.manifests},
        {"manifest_entry_recorded", expected.entries},
        {"channel_cursor_updated", expected.cursors}}},
  };
}

} // namespace kungfu::runtime::storage_service_api
