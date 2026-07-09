// SPDX-License-Identifier: Apache-2.0

#ifndef KUNGFU_RUNTIME_STORAGE_SERVICE_H
#define KUNGFU_RUNTIME_STORAGE_SERVICE_H

#include <string>
#include <vector>

#include <nlohmann/json.hpp>

namespace kungfu::runtime::storage_service_api {

inline constexpr const char *RUNTIME_STORAGE_SERVICE_SCHEMA_V1 = "kungfu.runtime.storage-service/v1";
inline constexpr const char *RUNTIME_STORAGE_SERVICE_OWNER = "libkungfu";

enum class storage_operation {
  Status,
  Fsck,
  ExportBundle,
  ImportBundle,
  RebuildIndex,
  GcPlan,
  CompactPlan,
  VerifySync,
  Query,
  Layout,
  EpisodeBegin,
  EpisodeHeartbeat,
  EpisodeEnd,
  EpisodeAbort,
  EpisodeAttachFrame,
  EpisodeAttachRef,
  EpisodeList,
  EpisodeInspect,
};

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
  std::string query = {};
  std::string kind = {};
  uint64_t episode_id = 0;
  uint64_t limit = 100;
};

class storage_service {
public:
  virtual ~storage_service() = default;

  [[nodiscard]] virtual nlohmann::json status(const storage_service_options &options) const = 0;

  [[nodiscard]] virtual nlohmann::json fsck(const storage_service_options &options) const = 0;

  [[nodiscard]] virtual nlohmann::json export_bundle(const storage_service_options &options) const = 0;

  [[nodiscard]] virtual nlohmann::json import_bundle(const storage_service_options &options) const = 0;

  [[nodiscard]] virtual nlohmann::json rebuild_index(const storage_service_options &options) const = 0;

  [[nodiscard]] virtual nlohmann::json gc_plan(const storage_service_options &options) const = 0;

  [[nodiscard]] virtual nlohmann::json compact_plan(const storage_service_options &options) const = 0;

  [[nodiscard]] virtual nlohmann::json verify_sync(const storage_service_options &options) const = 0;

  [[nodiscard]] virtual nlohmann::json query(const storage_service_options &options) const = 0;

  [[nodiscard]] virtual nlohmann::json layout(const storage_service_options &options) const = 0;

  [[nodiscard]] virtual nlohmann::json episode_begin(const storage_service_options &options) const = 0;

  [[nodiscard]] virtual nlohmann::json episode_heartbeat(const storage_service_options &options) const = 0;

  [[nodiscard]] virtual nlohmann::json episode_end(const storage_service_options &options) const = 0;

  [[nodiscard]] virtual nlohmann::json episode_abort(const storage_service_options &options) const = 0;

  [[nodiscard]] virtual nlohmann::json episode_attach_frame(const storage_service_options &options) const = 0;

  [[nodiscard]] virtual nlohmann::json episode_attach_ref(const storage_service_options &options) const = 0;

  [[nodiscard]] virtual nlohmann::json episode_list(const storage_service_options &options) const = 0;

  [[nodiscard]] virtual nlohmann::json episode_inspect(const storage_service_options &options) const = 0;
};

[[nodiscard]] std::vector<std::string> storage_operation_names();

[[nodiscard]] std::string storage_operation_name(storage_operation operation);

[[nodiscard]] storage_operation parse_storage_operation(const std::string &operation);

[[nodiscard]] storage_service_options parse_storage_service_options(const std::string &runtime_dir,
                                                                    const nlohmann::json &options);

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

[[nodiscard]] nlohmann::json storage_service_capabilities();

} // namespace kungfu::runtime::storage_service_api

#endif // KUNGFU_RUNTIME_STORAGE_SERVICE_H
