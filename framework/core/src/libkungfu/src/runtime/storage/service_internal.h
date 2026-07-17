// SPDX-License-Identifier: Apache-2.0

#ifndef KUNGFU_RUNTIME_STORAGE_SERVICE_INTERNAL_H
#define KUNGFU_RUNTIME_STORAGE_SERVICE_INTERNAL_H

#include <atomic>
#include <cstdint>
#include <filesystem>
#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <unordered_map>
#include <vector>

#include <nlohmann/json.hpp>

#include <kungfu/common.h>
#include <kungfu/runtime/storage/json_edge.h>
#include <kungfu/runtime/storage/service.h>
#include <kungfu/yijinjing/storage/content_hash.h>
#include <kungfu/yijinjing/storage/content_store.h>
#include <kungfu/yijinjing/storage/episode_manifest.h>
#include <kungfu/yijinjing/storage/manifest_catalog.h>
#include <kungfu/yijinjing/storage/source_registry.h>

namespace kungfu::runtime::storage_service_api::detail {

inline constexpr const char *PROVIDER_FILE = "content-addressed-file";
inline constexpr const char *PROVIDER_ROCKSDB = "rocksdb";
inline constexpr const char *ENV_STORAGE_PROVIDER = "KUNGFU_STORAGE_PROVIDER";
inline constexpr const char *PAYLOAD_STATE_PRESENT = "present";
inline constexpr const char *PAYLOAD_STATE_REDACTED = "redacted";
inline constexpr const char *PAYLOAD_STATE_ABSENT = "absent";
inline constexpr const char *PROJECTION_SOURCE_REGISTRY = "source-registry-sqlite";
inline constexpr const char *PROJECTION_MANIFEST_CATALOG = "manifest-catalog-sqlite";
inline constexpr const char *CONTENT_TYPE_JSON = "application/json";

struct provider_selection {
  std::string name;
  std::string source;
};

struct stored_payload {
  std::string digest;
  std::string uri;
  uint64_t byte_len = 0;
};

class storage_provider {
public:
  virtual ~storage_provider() = default;
  [[nodiscard]] virtual std::string name() const = 0;
  [[nodiscard]] virtual storage_provider_layout_view layout() const = 0;
  [[nodiscard]] virtual storage_provider_runtime_view runtime() const = 0;
  [[nodiscard]] virtual bool payload_exists(const std::string &digest) const = 0;
  [[nodiscard]] virtual std::string read_payload(const std::string &digest) const = 0;
  virtual void write_payload(const std::string &digest, const std::string &raw) const = 0;
  [[nodiscard]] virtual std::vector<stored_payload> all_payloads() const = 0;
  [[nodiscard]] virtual yijinjing::storage::content_store &content_store() const = 0;
};

[[nodiscard]] std::unique_ptr<storage_provider> make_file_storage_provider(std::string runtime_dir);

class provider_cache {
public:
  static provider_cache &instance();
  [[nodiscard]] std::shared_ptr<storage_provider> acquire(const std::string &runtime, const std::string &provider);
  [[nodiscard]] bool release_temporary(const std::string &runtime, const std::string &provider);
  [[nodiscard]] storage_provider_cache_view stats() const;

private:
  provider_cache() = default;
  mutable std::mutex mutex_;
  std::unordered_map<std::string, std::shared_ptr<storage_provider>> providers_;
  std::atomic<uint64_t> hits_{0};
  std::atomic<uint64_t> misses_{0};
};

struct episode_store_with_provider {
  std::shared_ptr<storage_provider> provider;
  yijinjing::storage::episode_manifest_store store;
};

struct episode_repair_descriptor {
  std::string action = {};
  std::vector<std::string> required_inputs = {};
};

template <size_t N> [[nodiscard]] std::string fixed_string(const kungfu::array<char, N> &value) {
  size_t length = 0;
  while (length < N && value.value[length] != '\0') {
    ++length;
  }
  return std::string(value.value, length);
}

template <size_t N> void assign_fixed(kungfu::array<char, N> &target, const std::string &value) {
  kungfu::copy_string(target, value.c_str());
}

[[nodiscard]] std::string text_or(const nlohmann::json &object, const std::string &field,
                                  const std::string &fallback = {});
[[nodiscard]] std::filesystem::path root_dir(const std::string &runtime_dir);
[[nodiscard]] std::filesystem::path projection_root(const std::string &runtime_dir);
[[nodiscard]] std::filesystem::path payload_path(const std::string &runtime_dir, const std::string &digest);
[[nodiscard]] std::filesystem::path provider_database_path(const std::string &runtime_dir);
[[nodiscard]] std::string payload_uri_for(const std::string &provider, const std::string &runtime_dir,
                                          const std::string &digest);
[[nodiscard]] std::filesystem::path absolute_normalized(std::filesystem::path path);
[[nodiscard]] std::filesystem::path runtime_home_path(const storage_service_options &options);
[[nodiscard]] std::string runtime_home_source(const storage_service_options &options);
[[nodiscard]] std::string optional_absolute_path(const nlohmann::json &object, const std::string &field);
void write_json_file(const std::filesystem::path &path, const nlohmann::json &data);
[[nodiscard]] provider_selection select_provider(std::string provider);
[[nodiscard]] std::shared_ptr<storage_provider> shared_provider(const storage_service_options &options);
[[nodiscard]] std::shared_ptr<storage_provider> shared_provider(const std::string &runtime_dir);
[[nodiscard]] episode_store_with_provider episode_ref_store(const storage_service_options &options);
[[nodiscard]] episode_store_with_provider episode_ref_store(const storage_fsck_request &request);
[[nodiscard]] nlohmann::json provider_runtime_json(const storage_provider_runtime_view &runtime);
[[nodiscard]] nlohmann::json provider_layout_json(const storage_provider_layout_view &layout);
[[nodiscard]] nlohmann::json provider_cache_json(const storage_provider_cache_view &cache);
[[nodiscard]] storage_provider_layout_view provider_layout_for(const std::string &provider);
[[nodiscard]] storage_provider_runtime_view provider_runtime_for(const std::string &provider);
[[nodiscard]] std::vector<std::filesystem::path> all_payload_paths(const std::string &runtime_dir);
[[nodiscard]] std::string payload_digest_from_path(const std::filesystem::path &path);

[[nodiscard]] std::string required_text(const nlohmann::json &object, const std::string &field);
[[nodiscard]] nlohmann::json object_or_empty(const nlohmann::json &object, const std::string &field);
[[nodiscard]] nlohmann::json array_or_empty(const nlohmann::json &object, const std::string &field);
void validate_managed_json_value(const nlohmann::json &schema, const nlohmann::json &value, const std::string &path);
[[nodiscard]] bool bool_or(const nlohmann::json &object, const std::string &field, bool fallback);
[[nodiscard]] uint64_t uint64_or(const nlohmann::json &object, const std::string &field, uint64_t fallback = 0);
[[nodiscard]] int64_t int64_or(const nlohmann::json &object, const std::string &field, int64_t fallback = 0);
[[nodiscard]] uint32_t uint32_or(const nlohmann::json &object, const std::string &field, uint32_t fallback = 0);
[[nodiscard]] int32_t int32_or(const nlohmann::json &object, const std::string &field, int32_t fallback = 0);
[[nodiscard]] std::string canonical_json(const nlohmann::json &value);
[[nodiscard]] std::string base64_encode(const std::string &raw);
[[nodiscard]] std::string base64_decode(const std::string &encoded);
[[nodiscard]] const char *payload_state_text(yijinjing::enums::PayloadState state);
[[nodiscard]] const char *source_kind_text(yijinjing::enums::SourceKind kind);
[[nodiscard]] const char *verification_status_text(yijinjing::enums::SourceVerificationStatus status);
[[nodiscard]] nlohmann::json replace_string_subtree(nlohmann::json value, const std::string &needle,
                                                    const std::string &replacement);
[[nodiscard]] yijinjing::storage::manifest_catalog_store catalog_store(const std::string &runtime_dir);
[[nodiscard]] yijinjing::storage::source_registry_store registry_store(const std::string &runtime_dir);
[[nodiscard]] storage_source_registry_view
source_registry_status_view(const yijinjing::storage::source_registry_current_view &source);
[[nodiscard]] storage_accepted_range_view
accepted_range_status_view(const yijinjing::types::ImportManifestAccepted &manifest);
[[nodiscard]] storage_cursor_view cursor_status_view(const yijinjing::types::ChannelCursorUpdated &cursor);
[[nodiscard]] storage_projection_status_view source_registry_projection_status(const std::string &runtime_dir);
[[nodiscard]] storage_projection_status_view manifest_catalog_projection_status(const std::string &runtime_dir);

[[nodiscard]] yijinjing::storage::episode_manifest_store episode_store(const storage_service_options &options);
[[nodiscard]] yijinjing::storage::episode_begin_options parse_episode_begin_options(const nlohmann::json &value);
[[nodiscard]] yijinjing::storage::episode_heartbeat_options
parse_episode_heartbeat_options(const nlohmann::json &value);
[[nodiscard]] yijinjing::storage::episode_close_options
parse_episode_close_options(const nlohmann::json &value, yijinjing::enums::EpisodeStatus status);
[[nodiscard]] yijinjing::storage::episode_frame_attach_options
parse_episode_frame_attach_options(const nlohmann::json &value);
[[nodiscard]] yijinjing::storage::episode_ref_attach_options
parse_episode_ref_attach_options(const nlohmann::json &value);
[[nodiscard]] yijinjing::storage::episode_recover_options parse_episode_recover_options(const nlohmann::json &value);
[[nodiscard]] yijinjing::storage::source_registry_store source_registry_store(const storage_service_options &options);
[[nodiscard]] yijinjing::storage::source_register_options parse_source_register_options(const nlohmann::json &value);
[[nodiscard]] yijinjing::storage::source_head_update_options
parse_source_head_update_options(const nlohmann::json &value);
[[nodiscard]] yijinjing::storage::accepted_range_options parse_accepted_range_options(const nlohmann::json &value);

[[nodiscard]] nlohmann::json workspace_episode_layout_json(const storage_layout_result &result);
[[nodiscard]] nlohmann::json projection_verification_json(const storage_projection_verify_result &report);
[[nodiscard]] nlohmann::json projection_rebuild_json(const storage_projection_rebuild_result &result);
[[nodiscard]] nlohmann::json episode_projection_rebuild_json(const storage_projection_rebuild_result &result);
[[nodiscard]] nlohmann::json episode_qualification_json(const episode_qualification_result &result);
[[nodiscard]] std::optional<episode_repair_descriptor>
episode_repair_descriptor_for_issue(const episode_qualification_issue &issue);
[[nodiscard]] nlohmann::json
render_episode_close_write_result(const yijinjing::storage::episode_close_write_result &result);
[[nodiscard]] nlohmann::json render_episode_recover_result(const yijinjing::storage::episode_recover_result &result);
[[nodiscard]] nlohmann::json render_storage_episode_bundle_result(const storage_episode_bundle_result &result);
[[nodiscard]] nlohmann::json render_manifest_entry_view(const yijinjing::storage::manifest_entry_view &entry);
[[nodiscard]] nlohmann::json render_manifest_document(const yijinjing::storage::manifest_document_view &manifest);
[[nodiscard]] nlohmann::json render_storage_export_bundle_result(const storage_export_bundle_result &result);
[[nodiscard]] nlohmann::json render_storage_import_bundle_result(const storage_import_bundle_result &result);
[[nodiscard]] nlohmann::json render_storage_verify_sync_result(const storage_verify_sync_result &result);
[[nodiscard]] storage_status_result status_typed_impl(const storage_status_request &request);
[[nodiscard]] storage_fsck_result fsck_typed_impl(const storage_fsck_request &request);
[[nodiscard]] storage_fsck_result episode_fsck_typed_impl(const storage_fsck_request &request);
[[nodiscard]] storage_gc_plan_result gc_plan_typed_impl(const storage_gc_plan_request &request);
[[nodiscard]] storage_rebuild_index_result rebuild_index_typed_impl(const storage_rebuild_index_request &request);
[[nodiscard]] storage_compact_plan_result compact_plan_typed_impl(const storage_compact_plan_request &request);
[[nodiscard]] storage_export_bundle_result export_bundle_typed_impl(const storage_export_bundle_request &request);
[[nodiscard]] storage_import_bundle_result import_bundle_typed_impl(const storage_import_bundle_request &request);
[[nodiscard]] storage_verify_sync_result verify_sync_typed_impl(const storage_verify_sync_request &request);
[[nodiscard]] storage_episode_bundle_result episode_export_bundle_typed_impl(const storage_service_options &options);
[[nodiscard]] storage_repair_plan_result repair_plan_typed_impl(const storage_repair_plan_request &request);
[[nodiscard]] storage_query_result query_journal_projection(const storage_query_request &request);
[[nodiscard]] nlohmann::json episode_record_body_json(const yijinjing::types::EpisodeOpen &record);
[[nodiscard]] nlohmann::json episode_record_body_json(const yijinjing::types::EpisodeHeartbeat &record);
[[nodiscard]] nlohmann::json episode_record_body_json(const yijinjing::types::EpisodeFrameAttached &record);
[[nodiscard]] nlohmann::json episode_record_body_json(const yijinjing::types::EpisodeRefAttached &record);
[[nodiscard]] nlohmann::json episode_record_body_json(const yijinjing::types::EpisodeClosed &record);
[[nodiscard]] nlohmann::json episode_record_body_json(const yijinjing::types::EpisodeRootCommitted &record);
[[nodiscard]] nlohmann::json episode_record_row_json(const yijinjing::storage::episode_manifest_record &record);
[[nodiscard]] nlohmann::json source_registry_record_json(const yijinjing::types::SourceRegistered &record);
[[nodiscard]] nlohmann::json source_registry_record_json(const yijinjing::types::SourceHeadUpdated &record);
[[nodiscard]] nlohmann::json source_registry_record_json(const yijinjing::types::AcceptedRangeRecorded &record);
[[nodiscard]] nlohmann::json content_result_json(const yijinjing::storage::content_store_result &result);

[[nodiscard]] nlohmann::json fsck_impl(const storage_service_options &options);
[[nodiscard]] nlohmann::json repair_plan_impl(const storage_service_options &options);
[[nodiscard]] nlohmann::json repair_fetch_impl(const storage_service_options &options);
[[nodiscard]] nlohmann::json repair_apply_impl(const storage_service_options &options);
[[nodiscard]] nlohmann::json episode_export_bundle_impl(const storage_service_options &options);
[[nodiscard]] nlohmann::json accept_storage_manifest_impl(const std::string &runtime_dir, const nlohmann::json &input);
[[nodiscard]] nlohmann::json export_bundle_generic_impl(const storage_service_options &options, bool record_receipt);
[[nodiscard]] storage_export_bundle_result parse_storage_export_bundle(const nlohmann::json &bundle);
[[nodiscard]] std::pair<nlohmann::json, std::string> load_payload_impl(const storage_provider &provider,
                                                                       const nlohmann::json &entry);
[[nodiscard]] nlohmann::json episode_import_bundle_impl(const storage_service_options &options);
[[nodiscard]] storage_episode_bundle_result parse_storage_episode_bundle(const nlohmann::json &bundle);
[[nodiscard]] nlohmann::json episode_admission_impl(const storage_service_options &options);
[[nodiscard]] nlohmann::json rebuild_index_impl(const storage_service_options &options);
[[nodiscard]] nlohmann::json gc_plan_impl(const storage_service_options &options);
[[nodiscard]] nlohmann::json compact_plan_impl(const storage_service_options &options);

[[nodiscard]] nlohmann::json dispatch_json_edge_operation(storage_operation operation,
                                                          const storage_service_options &options);

} // namespace kungfu::runtime::storage_service_api::detail

#endif // KUNGFU_RUNTIME_STORAGE_SERVICE_INTERNAL_H
