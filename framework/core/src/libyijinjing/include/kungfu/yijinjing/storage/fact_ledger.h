// SPDX-License-Identifier: Apache-2.0
#pragma once

#include <cstddef>
#include <cstdint>
#include <filesystem>
#include <string>
#include <variant>
#include <vector>

#include <kungfu/yijinjing/schema/types.h>

namespace kungfu::yijinjing::storage {

inline constexpr uint32_t FACT_LEDGER_RECORD_SCHEMA_V1 = 1;
inline constexpr uint32_t FACT_LEDGER_RECORD_SCHEMA_V2 = 2;
inline constexpr const char *FACT_LEDGER_NAMESPACE = "facts";
inline constexpr const char *FACT_LEDGER_NAME = "kernel";
inline constexpr const char *FACT_LEDGER_SNAPSHOT_V1 = "kungfu.fact-ledger.snapshot/v1";

using fact_record_variant =
    std::variant<types::FactObjectRecorded, types::FactVersionRecorded, types::FactRelationAdded,
                 types::FactRelationRevoked, types::FactCutCommitted, types::FactRefTransition>;

struct fact_authority_record {
  uint32_t tag = 0;
  uint32_t schema_version = 0;
  uint64_t sequence = 0;
  std::string record_root;
  fact_record_variant value;
};

struct fact_authority_pair {
  fact_authority_record record;
  types::FactOperationReceipt receipt{};
};

struct fact_ledger_issue {
  uint32_t frame_tag = 0;
  uint64_t sequence = 0;
  bool sequence_known = false;
  std::string record_root;
  std::string code;
};

struct fact_ledger_view {
  uint64_t next_sequence = 1;
  std::vector<fact_authority_pair> accepted;
  std::vector<fact_ledger_issue> issues;

  [[nodiscard]] bool verified() const noexcept { return issues.empty(); }
};

struct fact_ledger_recovery_plan {
  bool authority_readable = false;
  bool mutation_allowed = false;
  std::string action;
  std::vector<fact_ledger_issue> issues;
};

// Provider-neutral authority over the generic Fact POD journal. This class
// owns append pairing, replay verification, and exact snapshot export. It does
// not parse JSON, load Profile vocabulary, select a concrete backend, or own a
// shared-library ABI; libkungfu supplies those adapters above this surface.
class fact_ledger_store final {
public:
  explicit fact_ledger_store(std::filesystem::path runtime_root);

  [[nodiscard]] fact_ledger_view replay() const;
  [[nodiscard]] fact_ledger_recovery_plan recovery_plan() const;
  void append(const fact_authority_record &record, const types::FactOperationReceipt &receipt) const;
  [[nodiscard]] std::string export_snapshot(const std::filesystem::path &destination) const;

private:
  std::filesystem::path runtime_root_;
};

template <typename Record>
fact_authority_record make_fact_record(const Record &record, const std::string &record_root) {
  fact_authority_record result;
  result.tag = static_cast<uint32_t>(Record::tag);
  result.schema_version = record.schema_version;
  result.sequence = record.sequence;
  result.record_root = record_root;
  result.value = record;
  return result;
}

inline fact_authority_record fact_record(const types::FactObjectRecorded &record) {
  return make_fact_record(record, record.object_root.value);
}

inline fact_authority_record fact_record(const types::FactVersionRecorded &record) {
  return make_fact_record(record, record.version_root.value);
}

inline fact_authority_record fact_record(const types::FactRelationAdded &record) {
  return make_fact_record(record, record.relation_root.value);
}

inline fact_authority_record fact_record(const types::FactRelationRevoked &record) {
  return make_fact_record(record, record.revoke_root.value);
}

inline fact_authority_record fact_record(const types::FactCutCommitted &record) {
  return make_fact_record(record, record.cut_root.value);
}

inline fact_authority_record fact_record(const types::FactRefTransition &record) {
  return make_fact_record(record, record.transition_root.value);
}

} // namespace kungfu::yijinjing::storage
