// SPDX-License-Identifier: Apache-2.0
#pragma once

#include "fact_domain.h"

#include <optional>
#include <stdexcept>
#include <string>
#include <variant>

namespace kungfu::runtime::storage_service_api::fact_kernel_internal {

class fact_authority_mismatch : public std::runtime_error {
public:
  explicit fact_authority_mismatch(const std::string &field)
      : std::runtime_error("Fact Hana authority record differs from typed metadata at " + field), field_(field) {}

  [[nodiscard]] const std::string &field() const { return field_; }

private:
  std::string field_;
};

struct object_record_authority {
  std::string object_id;
  std::string object_type;
  std::string created_by_receipt_root;
  std::string object_root;
};

struct version_record_authority {
  std::string object_id;
  std::string version_root;
  std::string body_root;
  std::string schema_root;
  std::string parent_versions_root;
  std::string declaration_roots_root;
  std::string admission_roots_root;
};

struct relation_record_authority {
  std::string relation_id;
  std::string relation_type;
  std::string source_kind;
  std::string source_id;
  std::string target_kind;
  std::string target_id;
  std::string attributes_root;
  std::string admission_roots_root;
  std::string relation_root;
};

struct revocation_record_authority {
  std::string relation_root;
  std::string reason_root;
  std::string revoke_root;
};

struct cut_record_authority {
  std::string cut_root;
  std::string parent_cuts_root;
  std::string object_versions_root;
  std::string active_relations_root;
  std::string declaration_roots_root;
  std::string admission_roots_root;
  std::string episode_frontier_root;
  std::string omission_roots_root;
  std::string conflict_roots_root;
};

struct transition_record_authority {
  std::string transition_id;
  std::string ref_name;
  std::string expected_old_cut_root;
  uint64_t expected_old_revision = 0;
  std::string new_cut_root;
  std::string kind;
  std::string reason_root;
  std::string transition_root;
};

using fact_record_authority =
    std::variant<object_record_authority, version_record_authority, relation_record_authority,
                 revocation_record_authority, cut_record_authority, transition_record_authority>;

struct operation_receipt_authority {
  std::string operation_id;
  std::string operation;
  std::string status;
  std::optional<std::string> failure_code;
  std::string request_root;
  std::string record_root;
  std::string prior_cut_root;
  std::string current_cut_root;
  uint64_t prior_revision = 0;
  uint64_t current_revision = 0;
  bool write_occurred = false;
  std::string receipt_root;
};

void validate_fact_record_authority(const fact_document &document, const fact_record_authority &authority,
                                    const std::string &root_protocol);
void validate_operation_receipt_authority(const operation_receipt &receipt,
                                          const operation_receipt_authority &authority);

} // namespace kungfu::runtime::storage_service_api::fact_kernel_internal
