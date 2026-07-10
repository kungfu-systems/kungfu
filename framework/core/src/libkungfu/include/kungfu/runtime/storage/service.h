// SPDX-License-Identifier: Apache-2.0

#ifndef KUNGFU_RUNTIME_STORAGE_SERVICE_H
#define KUNGFU_RUNTIME_STORAGE_SERVICE_H

#include <cstdint>
#include <optional>
#include <string>
#include <variant>
#include <vector>

#include <kungfu/runtime/storage/projection_types.h>
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

struct storage_provider_runtime_view {
  std::string lifecycle = {};
  std::string instance_lifecycle = {};
  std::string handle = {};
  bool readonly_open_creates_backend = false;
  bool write_open_creates_backend = true;
  std::optional<bool> read_fill_cache = {};
  std::optional<bool> write_sync = {};
};

struct storage_provider_cache_view {
  std::string lifecycle = "process";
  uint64_t entries = 0;
  uint64_t hits = 0;
  uint64_t misses = 0;
};

struct storage_frame_range_view {
  uint64_t first_frame_uid = 0;
  uint64_t last_frame_uid = 0;
  int64_t since = 0;
  int64_t until = 0;
};

struct storage_source_registry_view {
  uint64_t source_uid = 0;
  std::string source_id = {};
  bool registered = false;
  uint64_t record_count = 0;
  uint64_t accepted_range_count = 0;
  std::optional<std::string> kind = {};
  std::optional<std::string> coordinate = {};
  std::optional<std::string> head = {};
  std::optional<uint32_t> location_uid = {};
  std::optional<int64_t> register_time = {};
  std::optional<storage_frame_range_view> current_range = {};
  std::optional<storage_sync_root_view> inventory_hash = {};
  std::optional<int64_t> update_time = {};
};

struct storage_accepted_range_view {
  std::string source_id = {};
  std::string manifest_id = {};
  storage_time_range range = {};
  std::string source_head = {};
  storage_sync_root_view sync_root = {};
  uint64_t entry_count = 0;
  std::string status = {};
};

struct storage_cursor_view {
  std::string source_id = {};
  std::string manifest_id = {};
  std::string source_head = {};
  storage_time_range range = {};
  storage_sync_root_view sync_root = {};
  uint64_t entry_count = 0;
};

struct storage_manifest_source_view {
  std::string source_id = {};
  std::string source_type = {};
  std::string kind = {};
  std::string coordinate = {};
  std::string source_head = {};
  storage_time_range range = {};
  std::string inventory_hash = {};
  storage_accepted_range_view accepted_range = {};
  std::string manifest_id = {};
};

struct storage_source_status_view {
  std::string source_id = {};
  bool ok = false;
  std::optional<std::string> reason = {};
  storage_source_registry_view source = {};
  std::optional<std::string> manifest_id = {};
  std::optional<std::string> source_type = {};
  std::optional<std::string> source_head = {};
  std::optional<storage_accepted_range_view> accepted_range = {};
  std::optional<storage_cursor_view> accepted_cursor = {};
  std::optional<storage_sync_root_view> sync_root = {};
  uint64_t entries = 0;
  uint64_t payload_inventory = 0;
  uint64_t schema_inventory = 0;
  std::optional<storage_manifest_source_view> source_record = {};
};

struct storage_projection_status_view {
  std::string name = {};
  std::string path = {};
  bool rebuildable = true;
  storage_projection_verify_result verification = {};
};

struct storage_status_request {
  std::string runtime_dir = {};
  std::string provider = {};
  std::string provider_config_source = {};
  std::string source_id = {};
};

struct storage_status_result {
  bool ok = true;
  std::string backend = {};
  std::string provider = {};
  std::string provider_config_source = {};
  storage_provider_runtime_view provider_runtime = {};
  storage_provider_cache_view provider_cache = {};
  std::string scope = "all";
  std::optional<std::string> source_id = {};
  std::string authority = "yijinjing-journal";
  std::vector<storage_source_registry_view> sources = {};
  std::vector<storage_projection_status_view> projections = {};
  std::vector<storage_source_status_view> source_status = {};
};

class storage_service {
public:
  virtual ~storage_service() = default;

  [[nodiscard]] virtual storage_status_result status(const storage_status_request &request) const = 0;

  [[nodiscard]] virtual storage_query_result query(const storage_query_request &request) const = 0;
};

[[nodiscard]] std::string storage_query_kind_name(storage_query_kind kind);

[[nodiscard]] storage_query_kind parse_storage_query_kind(const std::string &kind);

[[nodiscard]] const storage_service &default_storage_service();

} // namespace kungfu::runtime::storage_service_api

#endif // KUNGFU_RUNTIME_STORAGE_SERVICE_H
