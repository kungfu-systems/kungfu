// SPDX-License-Identifier: Apache-2.0

#ifndef KUNGFU_RUNTIME_STORAGE_JSON_EDGE_H
#define KUNGFU_RUNTIME_STORAGE_JSON_EDGE_H

#include <string>
#include <vector>

#include <nlohmann/json.hpp>

#include <kungfu/runtime/storage/service.h>

namespace kungfu::runtime::storage_service_api {

inline constexpr const char *EPISODE_QUALIFICATION_SCHEMA_V1 = "kungfu.episode.qualification/v1";

enum class storage_operation {
  Status,
  Fsck,
  RepairPlan,
  RepairFetch,
  RepairApply,
  ExportBundle,
  ImportBundle,
  RebuildIndex,
  GcPlan,
  CompactPlan,
  VerifySync,
  Query,
  QueryPlan,
  FactQuery,
  FactChangelog,
  FactContract,
  FactDeclareWorld,
  FactDeclareSurface,
  FactObserve,
  FactState,
  Layout,
  EpisodeBegin,
  EpisodeHeartbeat,
  EpisodeEnd,
  EpisodeAbort,
  EpisodeAttachFrame,
  EpisodeAttachRef,
  EpisodeList,
  EpisodeInspect,
  EpisodeRecover,
  EpisodeProjectionRebuild,
  SourceRegister,
  SourceUpdateHead,
  SourceRecordAcceptedRange,
  SourceList,
  SourceInspect,
  SourceRegistryFsck,
  SourceRegistryRebuild,
};

// Compatibility-parser state. This is deliberately confined to the JSON edge;
// semantic storage operations use operation-specific typed requests/results.
struct storage_service_options {
  std::string runtime_dir = {};
  std::string provider = {};
  std::string provider_config_source = {};
  std::string scope = {};
  std::string source_id = {};
  bool dry_run = true;
  bool verify = true;
  nlohmann::json range = nlohmann::json::object();
  std::string artifact_uri = {};
  nlohmann::json bundle = nlohmann::json::object();
  nlohmann::json manifest = nlohmann::json::object();
  nlohmann::json operation_options = nlohmann::json::object();
  nlohmann::json query_definition = nlohmann::json::object();
  std::string query = {};
  std::string kind = {};
  uint64_t episode_id = 0;
  uint64_t limit = 100;
};

[[nodiscard]] std::vector<std::string> storage_operation_names();

[[nodiscard]] std::string storage_operation_name(storage_operation operation);

[[nodiscard]] storage_operation parse_storage_operation(const std::string &operation);

[[nodiscard]] storage_service_options parse_storage_service_options(const std::string &runtime_dir,
                                                                    const nlohmann::json &options);

[[nodiscard]] storage_query_request parse_storage_query_request(const storage_service_options &options);

[[nodiscard]] nlohmann::json render_storage_query_result(const storage_query_result &result);

[[nodiscard]] storage_status_request parse_storage_status_request(const storage_service_options &options);

[[nodiscard]] nlohmann::json render_storage_status_result(const storage_status_result &result);

[[nodiscard]] storage_fsck_request parse_storage_fsck_request(const storage_service_options &options);

[[nodiscard]] nlohmann::json render_storage_fsck_result(const storage_fsck_result &result);

[[nodiscard]] storage_repair_plan_request parse_storage_repair_plan_request(const storage_service_options &options);

[[nodiscard]] nlohmann::json render_storage_repair_plan_result(const storage_repair_plan_result &result);

[[nodiscard]] storage_gc_plan_request parse_storage_gc_plan_request(const storage_service_options &options);

[[nodiscard]] nlohmann::json render_storage_gc_plan_result(const storage_gc_plan_result &result);

[[nodiscard]] storage_rebuild_index_request parse_storage_rebuild_index_request(const storage_service_options &options);

[[nodiscard]] nlohmann::json render_storage_rebuild_index_result(const storage_rebuild_index_result &result);

[[nodiscard]] storage_compact_plan_request parse_storage_compact_plan_request(const storage_service_options &options);

[[nodiscard]] nlohmann::json render_storage_compact_plan_result(const storage_compact_plan_result &result);

[[nodiscard]] nlohmann::json make_storage_service_request(const std::string &operation, const std::string &runtime_dir,
                                                          const nlohmann::json &options = nlohmann::json::object());

[[nodiscard]] nlohmann::json run_storage_service_operation(const std::string &operation, const std::string &runtime_dir,
                                                           const nlohmann::json &options = nlohmann::json::object());

[[nodiscard]] nlohmann::json accept_storage_manifest(const std::string &runtime_dir, const nlohmann::json &manifest);

[[nodiscard]] nlohmann::json load_storage_latest_manifest(const std::string &runtime_dir, const std::string &source_id);

[[nodiscard]] nlohmann::json export_storage_records(const std::string &runtime_dir, const std::string &source_id,
                                                    const nlohmann::json &range = nlohmann::json::object());

[[nodiscard]] std::string write_storage_payload_bytes(const std::string &runtime_dir, const std::string &digest,
                                                      const std::string &raw);

[[nodiscard]] nlohmann::json content_store_put_if_absent(const std::string &runtime_dir,
                                                         const std::string &content_namespace, const std::string &raw,
                                                         const std::string &expected_hash = {});

[[nodiscard]] bool content_store_has(const std::string &runtime_dir, const std::string &content_namespace,
                                     const std::string &content_hash_text);

[[nodiscard]] nlohmann::json content_store_verify(const std::string &runtime_dir, const std::string &content_namespace,
                                                  const std::string &content_hash_text);

[[nodiscard]] std::string content_store_get(const std::string &runtime_dir, const std::string &content_namespace,
                                            const std::string &content_hash_text);

[[nodiscard]] nlohmann::json content_store_capabilities(const std::string &runtime_dir);

[[nodiscard]] nlohmann::json storage_service_capabilities();

} // namespace kungfu::runtime::storage_service_api

#endif // KUNGFU_RUNTIME_STORAGE_JSON_EDGE_H
