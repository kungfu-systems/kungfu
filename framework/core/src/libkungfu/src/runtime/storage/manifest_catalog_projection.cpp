// SPDX-License-Identifier: Apache-2.0

#include <kungfu/runtime/storage/manifest_catalog_projection.h>

#include <filesystem>
#include <utility>

#include <kungfu/runtime/projection/hana_sqlite.h>
#include <kungfu/runtime/storage/projection_content.h>
#include <kungfu/runtime/storage/projection_transaction.h>
#include <kungfu/yijinjing/schema/registry.h>
#include <kungfu/yijinjing/storage/manifest_catalog.h>

namespace fs = std::filesystem;

namespace kungfu::runtime::storage_service_api {

namespace {

fs::path projection_path(const std::string &runtime_dir) {
  return fs::path(runtime_dir) / "storage" / "projections" / "manifest-catalog.sqlite";
}

} // namespace

manifest_catalog_projection::manifest_catalog_projection(std::string runtime_dir)
    : runtime_dir_(std::move(runtime_dir)) {}

std::string manifest_catalog_projection::sqlite_path() const { return projection_path(runtime_dir_).string(); }

bool manifest_catalog_projection::exists() const { return fs::exists(projection_path(runtime_dir_)); }

storage_projection_rebuild_result manifest_catalog_projection::rebuild_typed() const {
  const auto path = projection_path(runtime_dir_);
  fs::create_directories(path.parent_path());

  auto storage = projection::make_storage_ptr(path.string(), yijinjing::ManifestCatalogDataTypes);
  storage->pragma.journal_mode(sqlite_orm::journal_mode::WAL);
  storage->pragma.synchronous(0);

  const auto records = yijinjing::storage::manifest_catalog_store(runtime_dir_).read_typed_records();
  rebuild_projection_transaction(storage, [&](sqlite3 *) {
    storage->sync_schema();
    storage->remove_all<yijinjing::types::ImportManifestAccepted>();
    storage->remove_all<yijinjing::types::ManifestEntryRecorded>();
    storage->remove_all<yijinjing::types::ExportBundleRecorded>();
    storage->remove_all<yijinjing::types::ChannelCursorUpdated>();
    if (!records.manifests.empty()) {
      storage->replace_range(records.manifests.begin(), records.manifests.end());
    }
    if (!records.entries.empty()) {
      storage->replace_range(records.entries.begin(), records.entries.end());
    }
    if (!records.exports.empty()) {
      storage->replace_range(records.exports.begin(), records.exports.end());
    }
    if (!records.cursors.empty()) {
      storage->replace_range(records.cursors.begin(), records.cursors.end());
    }
  });

  return {
      true,
      MANIFEST_CATALOG_PROJECTION_SCHEMA_V1,
      runtime_dir_,
      "yijinjing-journal",
      "sqlite",
      path.string(),
      {{"import_manifest_accepted", static_cast<uint64_t>(storage->count<yijinjing::types::ImportManifestAccepted>())},
       {"manifest_entry_recorded", static_cast<uint64_t>(storage->count<yijinjing::types::ManifestEntryRecorded>())},
       {"export_bundle_recorded", static_cast<uint64_t>(storage->count<yijinjing::types::ExportBundleRecorded>())},
       {"channel_cursor_updated", static_cast<uint64_t>(storage->count<yijinjing::types::ChannelCursorUpdated>())}},
      {{"import_manifest_accepted", records.manifests.size()},
       {"manifest_entry_recorded", records.entries.size()},
       {"export_bundle_recorded", records.exports.size()},
       {"channel_cursor_updated", records.cursors.size()}}};
}

storage_projection_verify_result manifest_catalog_projection::verify_typed() const {
  const auto path = projection_path(runtime_dir_);
  const auto records = yijinjing::storage::manifest_catalog_store(runtime_dir_).read_typed_records();
  const auto expected_manifests = snapshot_projection_content(records.manifests);
  const auto expected_entries = snapshot_projection_content(records.entries);
  const auto expected_exports = snapshot_projection_content(records.exports);
  const auto expected_cursors = snapshot_projection_content(records.cursors);
  const bool has_records =
      !records.manifests.empty() || !records.entries.empty() || !records.exports.empty() || !records.cursors.empty();

  if (!fs::exists(path)) {
    // Missing projection is a distinct honest state, not a silent ok: if the
    // journal has records, the projection needs a rebuild before SQL queries.
    return {true,
            has_records ? "absent" : "ok",
            MANIFEST_CATALOG_PROJECTION_SCHEMA_V1,
            runtime_dir_,
            "yijinjing-journal",
            false,
            false,
            has_records ? "projection not built; run rebuild_index to enable SQL queries"
                        : "no manifest-catalog records; projection not needed"};
  }

  auto storage = projection::make_storage_ptr(path.string(), yijinjing::ManifestCatalogDataTypes);
  storage->on_open = [](sqlite3 *db) { sqlite3_busy_timeout(db, 5000); };
  projection_content_snapshot projected_manifests;
  projection_content_snapshot projected_entries;
  projection_content_snapshot projected_exports;
  projection_content_snapshot projected_cursors;
  std::vector<yijinjing::types::ExportBundleRecorded> projected_export_records;
  try {
    projected_manifests = snapshot_projection_content(storage->get_all<yijinjing::types::ImportManifestAccepted>());
    projected_entries = snapshot_projection_content(storage->get_all<yijinjing::types::ManifestEntryRecorded>());
    projected_export_records = storage->get_all<yijinjing::types::ExportBundleRecorded>();
    projected_exports = snapshot_projection_content(projected_export_records);
    projected_cursors = snapshot_projection_content(storage->get_all<yijinjing::types::ChannelCursorUpdated>());
  } catch (const std::exception &error) {
    return {false,
            "degraded",
            MANIFEST_CATALOG_PROJECTION_SCHEMA_V1,
            runtime_dir_,
            "yijinjing-journal",
            true,
            true,
            "projection schema unreadable; rebuild required: " + std::string(error.what()),
            {{"__schema__", 0, 0, "schema_unreadable"}}};
  } catch (...) {
    return {false,
            "degraded",
            MANIFEST_CATALOG_PROJECTION_SCHEMA_V1,
            runtime_dir_,
            "yijinjing-journal",
            true,
            true,
            "projection schema unreadable; rebuild required",
            {{"__schema__", 0, 0, "schema_unreadable"}}};
  }

  // Freshness is judged on the current-view families (manifests, entries,
  // cursors): those change only when new content is accepted, and a stale
  // cache there means queries answer from old facts. Export receipts are an
  // append-only audit stream on the read path — every export appends one —
  // so receipt lag between rebuilds is expected and is not drift.
  std::vector<storage_projection_drift> drift;
  const auto check = [&](const char *table, const projection_content_snapshot &projected,
                         const projection_content_snapshot &journal) {
    if (projected.digest != journal.digest) {
      drift.push_back({table, projected.rows, journal.rows,
                       projected.rows == journal.rows ? "content_mismatch" : "row_count_mismatch", projected.digest,
                       journal.digest});
    }
  };
  check("import_manifest_accepted", projected_manifests, expected_manifests);
  check("manifest_entry_recorded", projected_entries, expected_entries);
  if (!projection_content_is_subset(projected_export_records, records.exports)) {
    drift.push_back({"export_bundle_recorded", projected_exports.rows, expected_exports.rows, "content_mismatch",
                     projected_exports.digest, expected_exports.digest});
  }
  check("channel_cursor_updated", projected_cursors, expected_cursors);

  const bool degraded = !drift.empty();
  return {!degraded,
          degraded ? "degraded" : "ok",
          MANIFEST_CATALOG_PROJECTION_SCHEMA_V1,
          runtime_dir_,
          "yijinjing-journal",
          true,
          degraded,
          {},
          std::move(drift),
          {{"import_manifest_accepted", projected_manifests.rows},
           {"manifest_entry_recorded", projected_entries.rows},
           {"channel_cursor_updated", projected_cursors.rows}},
          {{"import_manifest_accepted", expected_manifests.rows},
           {"manifest_entry_recorded", expected_entries.rows},
           {"channel_cursor_updated", expected_cursors.rows}}};
}

} // namespace kungfu::runtime::storage_service_api
