// SPDX-License-Identifier: Apache-2.0

#ifndef KUNGFU_YIJINJING_STORAGE_SOURCE_REGISTRY_H
#define KUNGFU_YIJINJING_STORAGE_SOURCE_REGISTRY_H

#include <cstdint>
#include <functional>
#include <map>
#include <string>
#include <variant>
#include <vector>

#include <nlohmann/json.hpp>

#include <kungfu/yijinjing/schema/types.h>

namespace kungfu::yijinjing::storage {

// ADR-0037: the ADR-0018 storage-service source-registry record family is
// Hana-core kernel metadata. The authoritative store is an append-only
// yijinjing journal of POD records (SourceRegistered / SourceHeadUpdated /
// AcceptedRangeRecorded) folded into a current view. JSON is an edge
// projection only, never the contract.
inline constexpr const char *SOURCE_REGISTRY_SCHEMA_V1 = "kungfu.storage.source-registry/v1";
inline constexpr const char *SOURCE_REGISTRY_NAMESPACE = "storage";
inline constexpr const char *SOURCE_REGISTRY_NAME = "source-registry";

// Edge-level input options. These carry std::string for ergonomic callers; the
// store copies them into fixed-layout POD journal records. They are not the
// stored record and never become the fact substrate.
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

// Typed POD records folded off the journal, in append order. The store stays
// the journal authority: higher layers (e.g. the libkungfu SQLite projection)
// read POD records through here rather than re-opening the journal themselves.
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

class source_registry_store {
public:
  explicit source_registry_store(std::string runtime_dir);

  [[nodiscard]] std::string runtime_dir() const { return runtime_dir_; }

  // Read the journal back as typed POD records (append order). Authority for
  // rebuildable projections such as the SQLite cache.
  [[nodiscard]] source_registry_journal_records read_typed_records() const;

  void for_each_typed_record(const source_registry_record_visitor &visit) const;

  [[nodiscard]] std::vector<source_registry_record> read_typed_stream() const;

  [[nodiscard]] source_registry_fold fold_typed_records() const;

  // Append-only writers. Each writes and returns the authoritative POD record;
  // compatibility JSON is rendered by the caller's edge adapter.
  [[nodiscard]] yijinjing::types::SourceRegistered register_source(const source_register_options &options) const;

  [[nodiscard]] yijinjing::types::SourceHeadUpdated update_head(const source_head_update_options &options) const;

  [[nodiscard]] yijinjing::types::AcceptedRangeRecorded
  record_accepted_range(const accepted_range_options &options) const;

  // Fold the journal into the current source-registry view (JSON edge).
  [[nodiscard]] nlohmann::json list() const;

  [[nodiscard]] nlohmann::json inspect(const std::string &source_id) const;

  // Verify the journal by reopening frames and checking fold consistency.
  [[nodiscard]] nlohmann::json fsck(const std::string &source_id = {}) const;

private:
  std::string runtime_dir_;
};

} // namespace kungfu::yijinjing::storage

#endif // KUNGFU_YIJINJING_STORAGE_SOURCE_REGISTRY_H
