// SPDX-License-Identifier: Apache-2.0

#ifndef KUNGFU_RUNTIME_STORAGE_SERVICE_H
#define KUNGFU_RUNTIME_STORAGE_SERVICE_H

#include <cstdint>
#include <optional>
#include <string>
#include <variant>
#include <vector>

#include <kungfu/yijinjing/storage/episode_manifest.h>

namespace kungfu::runtime::storage_service_api {

inline constexpr const char *RUNTIME_STORAGE_SERVICE_SCHEMA_V1 = "kungfu.runtime.storage-service/v1";
inline constexpr const char *RUNTIME_STORAGE_SERVICE_OWNER = "libkungfu";

enum class storage_query_kind {
  Sources,
  Manifests,
  Entries,
  Episodes,
  EpisodeRecords,
  EpisodeFrames,
  EpisodeRefs,
};

struct storage_time_range {
  std::string since = {};
  std::string until = {};
};

struct storage_query_request {
  std::string runtime_dir = {};
  std::string provider = {};
  std::string provider_config_source = {};
  std::string source_id = {};
  std::string entry_kind = {};
  storage_time_range range = {};
  storage_query_kind query = storage_query_kind::Entries;
  uint64_t episode_id = 0;
  uint64_t limit = 100;
};

struct storage_sync_root_view {
  std::string algorithm = {};
  std::string value = {};
};

struct storage_source_query_row {
  uint64_t source_uid = 0;
  std::string source_id = {};
  std::string source_type = {};
  std::string coordinate = {};
  std::string manifest_id = {};
  std::string source_head = {};
  int64_t accept_time = 0;
  uint64_t entry_count = 0;
  storage_sync_root_view sync_root = {};
  uint64_t manifest_count = 0;
  uint64_t export_count = 0;
};

struct storage_manifest_query_row {
  std::string source_id = {};
  std::string manifest_id = {};
  int64_t accept_time = 0;
  uint64_t entry_count = 0;
  std::string entries_hash = {};
  storage_sync_root_view sync_root = {};
  std::string status = {};
};

struct storage_entry_query_row {
  std::string kind = {};
  std::string source_id = {};
  std::string source_path = {};
  std::string source_time = {};
  uint32_t schema_version = 0;
  std::string content_type = {};
  std::string payload_hash = {};
  uint64_t byte_len = 0;
  std::string payload_state = {};
  uint64_t entry_index = 0;
  int64_t accept_time = 0;
  std::string storage_source_id = {};
  std::string manifest_id = {};
};

struct storage_query_error {
  std::string code = {};
  std::optional<uint64_t> episode_id = {};
};

using storage_query_rows =
    std::variant<std::vector<storage_source_query_row>, std::vector<storage_manifest_query_row>,
                 std::vector<storage_entry_query_row>, std::vector<yijinjing::storage::episode_current_view>,
                 std::vector<yijinjing::storage::episode_manifest_record>>;

struct storage_query_result {
  bool ok = true;
  std::string scope = "all";
  std::optional<std::string> source_id = {};
  std::optional<uint64_t> episode_id = {};
  std::string projection_name = {};
  std::string projection_schema = {};
  std::string authority = "yijinjing-journal";
  bool rebuildable = false;
  storage_query_kind query = storage_query_kind::Entries;
  std::optional<std::string> entry_kind = {};
  storage_time_range range = {};
  uint64_t limit = 100;
  storage_query_rows rows = std::vector<storage_entry_query_row>{};
  std::vector<storage_query_error> errors = {};

  [[nodiscard]] size_t row_count() const;
};

class storage_service {
public:
  virtual ~storage_service() = default;

  [[nodiscard]] virtual storage_query_result query(const storage_query_request &request) const = 0;
};

[[nodiscard]] std::string storage_query_kind_name(storage_query_kind kind);

[[nodiscard]] storage_query_kind parse_storage_query_kind(const std::string &kind);

[[nodiscard]] const storage_service &default_storage_service();

} // namespace kungfu::runtime::storage_service_api

#endif // KUNGFU_RUNTIME_STORAGE_SERVICE_H
