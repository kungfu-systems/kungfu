// SPDX-License-Identifier: Apache-2.0

#ifndef KUNGFU_YIJINJING_STORAGE_GENERIC_SERVICE_H
#define KUNGFU_YIJINJING_STORAGE_GENERIC_SERVICE_H

#include <string>
#include <vector>

#include <nlohmann/json.hpp>

namespace kungfu::yijinjing::storage {

inline constexpr const char *STORAGE_SOURCE_RECORD_SCHEMA_V1 = "kungfu.storage.source-record/v1";
inline constexpr const char *STORAGE_IMPORT_MANIFEST_SCHEMA_V1 = "kungfu.storage.import-manifest/v1";
inline constexpr const char *STORAGE_EXPORT_BUNDLE_SCHEMA_V1 = "kungfu.storage.export-bundle/v1";
inline constexpr const char *STORAGE_ACCEPTED_RANGE_SCHEMA_V1 = "kungfu.storage.accepted-range/v1";
inline constexpr const char *STORAGE_PAYLOAD_INVENTORY_SCHEMA_V1 = "kungfu.storage.payload-inventory/v1";
inline constexpr const char *STORAGE_SCHEMA_INVENTORY_SCHEMA_V1 = "kungfu.storage.schema-inventory/v1";

struct storage_issue {
  std::string severity = "error";
  std::string code = {};
  std::string path = {};
  std::string message = {};
  nlohmann::json expected = nullptr;
  nlohmann::json actual = nullptr;
};

[[nodiscard]] nlohmann::json build_storage_source_record(const nlohmann::json &input);

[[nodiscard]] nlohmann::json build_storage_import_manifest(const nlohmann::json &input);

[[nodiscard]] nlohmann::json filter_storage_manifest_entries(const nlohmann::json &entries,
                                                             const nlohmann::json &range_filter);

[[nodiscard]] std::vector<storage_issue> verify_storage_import_manifest(const nlohmann::json &manifest);

[[nodiscard]] nlohmann::json build_storage_export_bundle(const nlohmann::json &manifest, const nlohmann::json &records);

} // namespace kungfu::yijinjing::storage

#endif // KUNGFU_YIJINJING_STORAGE_GENERIC_SERVICE_H
