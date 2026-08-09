// SPDX-License-Identifier: Apache-2.0

#ifndef KUNGFU_YIJINJING_STORAGE_MANIFEST_CATALOG_H
#define KUNGFU_YIJINJING_STORAGE_MANIFEST_CATALOG_H

#include <string>
#include <vector>

#include <nlohmann/json.hpp>

#include <kungfu/yijinjing/storage/content_store.h>
#include <kungfu/yijinjing/storage/manifest_catalog_types.h>

namespace kungfu::yijinjing::storage {

// KF-ADR-019f86da-4f90-7828-9142-46f9bca4b0f5 (final slice): the KF-ADR-019f86da-4f90-70c5-b572-89ec183b37de
// import-manifest / export-bundle / channel-cursor record family is Hana-core kernel metadata. The authoritative store
// is an append-only yijinjing journal of POD records (ImportManifestAccepted / ManifestEntryRecorded /
// ExportBundleRecorded / ChannelCursorUpdated) folded into a current view, the sibling of the source-registry journal.
// Variable-length manifest entries grow as append-only per-entry delta records; the exact accepted entries document is
// committed by content hash into the content store so the JSON edge and the
// cross-store sync root stay byte-reproducible. JSON is an edge projection
// only, never the contract.
// JSON edge schemas. These name edge projections and exchange documents over
// the journal records, not stored contracts.
inline constexpr const char *STORAGE_SOURCE_RECORD_SCHEMA_V1 = "kungfu.storage.source-record/v1";
inline constexpr const char *STORAGE_IMPORT_MANIFEST_SCHEMA_V1 = "kungfu.storage.import-manifest/v1";
inline constexpr const char *STORAGE_EXPORT_BUNDLE_SCHEMA_V1 = "kungfu.storage.export-bundle/v1";
inline constexpr const char *STORAGE_ACCEPTED_RANGE_SCHEMA_V1 = "kungfu.storage.accepted-range/v1";
inline constexpr const char *STORAGE_PAYLOAD_INVENTORY_SCHEMA_V1 = "kungfu.storage.payload-inventory/v1";
inline constexpr const char *STORAGE_SCHEMA_INVENTORY_SCHEMA_V1 = "kungfu.storage.schema-inventory/v1";
inline constexpr const char *STORAGE_CHANNEL_CURSOR_SCHEMA_V1 = "kungfu.storage.channel-cursor/v1";

struct storage_issue {
  std::string severity = "error";
  std::string code = {};
  std::string path = {};
  std::string message = {};
  nlohmann::json expected = nullptr;
  nlohmann::json actual = nullptr;
};

// Edge validation of an import-manifest document (an incoming bundle manifest
// or a freshly built edge projection). Structural checks plus sync-root
// verification over the document's own entries.
[[nodiscard]] std::vector<storage_issue> verify_storage_import_manifest(const nlohmann::json &manifest);

// Edge helper: filter manifest entries by an ISO-string time range
// ({"since", "until"}); entries without a source_time never match a
// non-empty filter.
[[nodiscard]] nlohmann::json filter_storage_manifest_entries(const nlohmann::json &entries,
                                                             const nlohmann::json &range_filter);

// Edge assembler for the export exchange document
// (kungfu.storage.export-bundle/v1) over a manifest edge projection and its
// exported records.
[[nodiscard]] nlohmann::json build_storage_export_bundle(const nlohmann::json &manifest, const nlohmann::json &records);

// Edge assemblers for the derived inventories over a set of manifest entries
// (used when projecting a range-filtered manifest edge for export).
[[nodiscard]] nlohmann::json build_storage_payload_inventory(const nlohmann::json &entries);

[[nodiscard]] nlohmann::json build_storage_schema_inventory(const nlohmann::json &entries);

class manifest_catalog_store {
public:
  explicit manifest_catalog_store(std::string runtime_dir);

  [[nodiscard]] std::string runtime_dir() const { return runtime_dir_; }

  // Read the journal back as typed POD records (append order). Authority for
  // rebuildable projections such as the SQLite cache.
  [[nodiscard]] manifest_catalog_journal_records read_typed_records() const;

  // Typed semantic entrypoints. JSON methods below are compatibility edge
  // adapters over these owned views.
  [[nodiscard]] manifest_document_view accept_manifest_typed(const manifest_document_view &input,
                                                             content_store &store) const;

  [[nodiscard]] std::optional<manifest_document_view> latest_manifest_typed(const std::string &source_id,
                                                                            content_store &store) const;

  void record_export_typed(const manifest_document_view &manifest, uint64_t exported_records,
                           const std::string &range_since = {}, const std::string &range_until = {}) const;

  // Accept one import manifest. `input` is the adapter-edge document (the
  // same vocabulary the retired JSON builder took: manifest_id, source ids,
  // type, coordinate, head, scope, range, entries, optional sync_root).
  // Validates the input, verifies a caller-supplied sync root against the
  // recomputed one, commits the canonical entries document into the content
  // store, then appends the header record, one delta record per entry, and
  // the channel cursor. Returns the accepted manifest JSON edge projection.
  [[nodiscard]] nlohmann::json accept_manifest(const nlohmann::json &input, content_store &store) const;

  // Append an export-bundle receipt for a manifest this catalog folded.
  [[nodiscard]] nlohmann::json record_export(const nlohmann::json &manifest, uint64_t exported_records,
                                             const nlohmann::json &range_filter = {}) const;

  // Fold the journal into the latest accepted manifest for one source and
  // project it as the import-manifest JSON edge (entries read back from the
  // content store). Returns null when the source has no accepted manifest.
  [[nodiscard]] nlohmann::json latest_manifest(const std::string &source_id, content_store &store) const;

  // Current catalog view (JSON edge): one summary per source.
  [[nodiscard]] nlohmann::json list() const;

  [[nodiscard]] nlohmann::json inspect(const std::string &source_id) const;

  // The channel-cursor edge for one source's latest accepted manifest.
  [[nodiscard]] nlohmann::json latest_cursor(const std::string &source_id) const;

  // Payload hashes referenced by every accepted manifest's entry records
  // (union over history, for gc planning and orphan detection).
  [[nodiscard]] std::vector<std::string> referenced_payload_hashes(const std::string &source_id = {}) const;

  // Verify the journal fold, the committed entries documents, and the
  // payload references: header/entry count consistency, the sync-root chain
  // recomputed from the per-entry commitment hashes, the entries document
  // re-fetched and cross-checked field by field against the delta records,
  // and each present payload verified through the content store. Projection
  // drift is the runtime projection's own verify; this checks the journal
  // and the content-addressed facts.
  [[nodiscard]] manifest_catalog_fsck_result fsck_typed(const std::string &source_id, content_store &store) const;

  [[nodiscard]] nlohmann::json fsck(const std::string &source_id, content_store &store) const;

private:
  std::string runtime_dir_;
};

} // namespace kungfu::yijinjing::storage

#endif // KUNGFU_YIJINJING_STORAGE_MANIFEST_CATALOG_H
