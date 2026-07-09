// SPDX-License-Identifier: Apache-2.0

#ifndef KUNGFU_YIJINJING_STORAGE_SOURCE_REGISTRY_H
#define KUNGFU_YIJINJING_STORAGE_SOURCE_REGISTRY_H

#include <cstdint>
#include <string>
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

class source_registry_store {
public:
  explicit source_registry_store(std::string runtime_dir);

  [[nodiscard]] std::string runtime_dir() const { return runtime_dir_; }

  // Read the journal back as typed POD records (append order). Authority for
  // rebuildable projections such as the SQLite cache.
  [[nodiscard]] source_registry_journal_records read_typed_records() const;

  // Append-only writers. Each writes one POD record to the journal and returns
  // its JSON edge projection.
  [[nodiscard]] nlohmann::json register_source(const source_register_options &options) const;

  [[nodiscard]] nlohmann::json update_head(const source_head_update_options &options) const;

  [[nodiscard]] nlohmann::json record_accepted_range(const accepted_range_options &options) const;

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
