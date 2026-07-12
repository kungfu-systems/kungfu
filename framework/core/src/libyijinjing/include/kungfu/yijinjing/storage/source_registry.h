// SPDX-License-Identifier: Apache-2.0

#ifndef KUNGFU_YIJINJING_STORAGE_SOURCE_REGISTRY_H
#define KUNGFU_YIJINJING_STORAGE_SOURCE_REGISTRY_H

#include <optional>
#include <string>
#include <vector>

#include <nlohmann/json.hpp>

#include <kungfu/yijinjing/storage/source_registry_types.h>

namespace kungfu::yijinjing::storage {

// ADR-0037: the ADR-0018 storage-service source-registry record family is
// Hana-core kernel metadata. The authoritative store is an append-only
// yijinjing journal of POD records (SourceRegistered / SourceHeadUpdated /
// AcceptedRangeRecorded) folded into a current view. JSON is an edge
// projection only, never the contract.
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

  // Inspect by the registry's stable source identity, including a dangling
  // source that has head/range records but no SourceRegistered record.
  [[nodiscard]] std::optional<source_registry_current_view> inspect_typed(const std::string &source_id) const;

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
  [[nodiscard]] source_registry_fsck_result fsck_typed(const std::string &source_id = {}) const;

  [[nodiscard]] nlohmann::json fsck(const std::string &source_id = {}) const;

private:
  std::string runtime_dir_;
};

} // namespace kungfu::yijinjing::storage

#endif // KUNGFU_YIJINJING_STORAGE_SOURCE_REGISTRY_H
