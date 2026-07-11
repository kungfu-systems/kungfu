// SPDX-License-Identifier: Apache-2.0

#ifndef KUNGFU_YIJINJING_STORAGE_MANIFEST_CATALOG_TYPES_H
#define KUNGFU_YIJINJING_STORAGE_MANIFEST_CATALOG_TYPES_H

#include <cstdint>
#include <optional>
#include <string>
#include <vector>

#include <kungfu/yijinjing/schema/types.h>

namespace kungfu::yijinjing::storage {

// Typed manifest-catalog contracts. JSON exchange documents and renderers
// remain in the manifest_catalog facade and are not service-layer currency.
inline constexpr const char *MANIFEST_CATALOG_SCHEMA_V1 = "kungfu.storage.manifest-catalog/v1";
inline constexpr const char *MANIFEST_CATALOG_NAMESPACE = "storage";
inline constexpr const char *MANIFEST_CATALOG_NAME = "manifest-catalog";
inline constexpr const char *MANIFEST_ENTRIES_CONTENT_NAMESPACE = "manifests";

struct manifest_catalog_journal_records {
  std::vector<yijinjing::types::ImportManifestAccepted> manifests = {};
  std::vector<yijinjing::types::ManifestEntryRecorded> entries = {};
  std::vector<yijinjing::types::ExportBundleRecorded> exports = {};
  std::vector<yijinjing::types::ChannelCursorUpdated> cursors = {};
};

struct manifest_catalog_fsck_issue {
  std::string code = {};
  std::optional<std::string> source_id = {};
  std::optional<std::string> manifest_id = {};
  std::optional<std::string> error = {};
  std::optional<std::string> subject = {};
  std::optional<std::string> payload_hash = {};
  std::optional<std::string> state = {};
  std::optional<std::string> kind = {};
  std::optional<std::string> entry_source_id = {};
  std::optional<uint64_t> manifest_uid = {};
  std::optional<uint64_t> entry_index = {};
  std::optional<uint64_t> expected = {};
  std::optional<uint64_t> actual = {};
  std::optional<std::string> expected_text = {};
  std::optional<std::string> actual_text = {};
  std::optional<bool> intentional = {};
};

struct manifest_catalog_fsck_result {
  bool ok = true;
  std::string status = "ok";
  bool degraded = false;
  std::string schema = MANIFEST_CATALOG_SCHEMA_V1;
  std::string runtime_dir = {};
  std::string authority = "yijinjing-journal";
  std::vector<manifest_catalog_fsck_issue> errors = {};
  std::vector<manifest_catalog_fsck_issue> warnings = {};
  uint64_t manifests = 0;
  uint64_t manifest_entries = 0;
  uint64_t payloads = 0;
  uint64_t entries_documents = 0;
  uint64_t exports = 0;
  uint64_t cursors = 0;
};

} // namespace kungfu::yijinjing::storage

#endif // KUNGFU_YIJINJING_STORAGE_MANIFEST_CATALOG_TYPES_H
