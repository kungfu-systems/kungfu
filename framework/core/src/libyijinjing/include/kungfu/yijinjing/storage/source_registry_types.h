// SPDX-License-Identifier: Apache-2.0

#ifndef KUNGFU_YIJINJING_STORAGE_SOURCE_REGISTRY_TYPES_H
#define KUNGFU_YIJINJING_STORAGE_SOURCE_REGISTRY_TYPES_H

#include <cstdint>
#include <functional>
#include <map>
#include <optional>
#include <string>
#include <variant>
#include <vector>

#include <kungfu/yijinjing/schema/types.h>

namespace kungfu::yijinjing::storage {

// Typed source-registry contracts shared by the journal store, storage
// service, projections, and language bindings. JSON renderers stay in the
// source_registry facade.
inline constexpr const char *SOURCE_REGISTRY_SCHEMA_V1 = "kungfu.storage.source-registry/v1";
inline constexpr const char *SOURCE_REGISTRY_NAMESPACE = "storage";
inline constexpr const char *SOURCE_REGISTRY_NAME = "source-registry";

// Ergonomic edge inputs copied into fixed-layout journal POD records.
struct source_register_options {
  std::string source_id = {};
  yijinjing::enums::SourceKind kind = yijinjing::enums::SourceKind::Local;
  std::string coordinate = {};
  std::string head = {};
  uint32_t location_uid = 0;
  int64_t register_time = 0;
};

struct source_head_update_options {
  std::string source_id = {};
  uint32_t location_uid = 0;
  int64_t update_time = 0;
  uint64_t first_frame_uid = 0;
  uint64_t last_frame_uid = 0;
  int64_t since = 0;
  int64_t until = 0;
  std::string head = {};
  std::string inventory_hash_algo = {};
  std::string inventory_hash = {};
};

struct accepted_range_options {
  std::string source_id = {};
  std::string manifest_id = {};
  uint32_t location_uid = 0;
  int64_t accept_time = 0;
  uint64_t first_frame_uid = 0;
  uint64_t last_frame_uid = 0;
  int64_t since = 0;
  int64_t until = 0;
  yijinjing::enums::SourceVerificationStatus status = yijinjing::enums::SourceVerificationStatus::Ok;
};

struct source_registry_journal_records {
  std::vector<yijinjing::types::SourceRegistered> registered = {};
  std::vector<yijinjing::types::SourceHeadUpdated> head_updates = {};
  std::vector<yijinjing::types::AcceptedRangeRecorded> accepted_ranges = {};
};

struct source_registry_unknown_record {
  int32_t carrier_type = 0;
};

struct source_registry_record {
  uint64_t registry_frame_uid = 0;
  int64_t registry_gen_time = 0;
  std::variant<source_registry_unknown_record, yijinjing::types::SourceRegistered, yijinjing::types::SourceHeadUpdated,
               yijinjing::types::AcceptedRangeRecorded>
      body = source_registry_unknown_record{};
};

using source_registry_record_visitor = std::function<void(const source_registry_record &)>;

struct source_registry_current_view {
  uint64_t source_uid = 0;
  bool registered = false;
  size_t register_count = 0;
  yijinjing::types::SourceRegistered registration = {};
  bool head_update_seen = false;
  yijinjing::types::SourceHeadUpdated head_update = {};
  std::string current_head = {};
  std::vector<source_registry_record> records = {};
  std::vector<size_t> accepted_range_indices = {};

  [[nodiscard]] const yijinjing::types::AcceptedRangeRecorded &accepted_range_at(size_t position) const {
    return std::get<yijinjing::types::AcceptedRangeRecorded>(records[accepted_range_indices[position]].body);
  }
};

struct source_registry_fold {
  std::map<uint64_t, source_registry_current_view> sources = {};
  size_t total_record_count = 0;
  size_t unknown_record_count = 0;
  size_t unfolded_record_count = 0;
};

struct source_registry_fsck_issue {
  std::string code = {};
  std::optional<uint64_t> source_uid = {};
  std::optional<std::string> source_id = {};
  std::optional<uint64_t> count = {};
};

struct source_registry_fsck_result {
  bool ok = true;
  std::string status = "ok";
  std::string schema = SOURCE_REGISTRY_SCHEMA_V1;
  std::string runtime_dir = {};
  std::string authority = "yijinjing-journal";
  std::vector<source_registry_fsck_issue> errors = {};
  std::vector<source_registry_fsck_issue> warnings = {};
  uint64_t source_registry_records = 0;
  uint64_t sources = 0;
};

} // namespace kungfu::yijinjing::storage

#endif // KUNGFU_YIJINJING_STORAGE_SOURCE_REGISTRY_TYPES_H
