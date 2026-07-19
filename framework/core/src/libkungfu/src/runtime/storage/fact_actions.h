// SPDX-License-Identifier: Apache-2.0
#pragma once

#include "fact_kernel_internal.h"

#include <cstdint>
#include <optional>
#include <string>
#include <variant>
#include <vector>

#include <kungfu/yijinjing/schema/types.h>

namespace kungfu::runtime::storage_service_api::fact_kernel_internal {

struct relation_endpoint_request {
  std::string kind;
  std::string id;
  std::optional<std::string> mapping_receipt_root;
};

struct object_put_request {
  std::string object_id;
  std::string object_type;
  std::string created_by_receipt_root;
};

struct version_put_request {
  std::string object_id;
  std::string body;
  std::string schema_root;
  std::vector<std::string> parent_version_roots;
  std::vector<std::string> declaration_roots;
  std::vector<std::string> admission_roots;
};

struct relation_add_request {
  std::string relation_id;
  std::string relation_type;
  relation_endpoint_request source;
  relation_endpoint_request target;
  std::string attributes_root;
  std::vector<std::string> admission_roots;
};

struct relation_revoke_request {
  std::string relation_root;
  std::string reason_root;
};

struct cut_object_version {
  std::string object_id;
  std::string version_root;
};

struct cut_episode_frontier_entry {
  uint64_t episode_id = 0;
  std::string sealed_content_root;
  std::string accepted_manifest_frame_uid;
};

struct cut_put_request {
  std::vector<std::string> parent_cut_roots;
  std::vector<cut_object_version> object_versions;
  std::vector<std::string> active_relation_roots;
  std::vector<std::string> declaration_roots;
  std::vector<std::string> admission_roots;
  std::vector<cut_episode_frontier_entry> episode_frontier;
  std::vector<std::string> omission_roots;
  std::vector<std::string> conflict_roots;
};

struct ref_cas_request {
  std::string transition_id;
  std::string ref_name;
  bool has_expected_old_cut_root = false;
  std::optional<std::string> expected_old_cut_root;
  bool has_expected_old_revision = false;
  uint64_t expected_old_revision = 0;
  std::string new_cut_root;
  std::string kind;
  std::string reason_root;
};

using mutation_request = std::variant<object_put_request, version_put_request, relation_add_request,
                                      relation_revoke_request, cut_put_request, ref_cas_request>;

struct object_put_result {
  std::string object_id;
  std::string object_root;
};
struct version_put_result {
  std::string object_id;
  std::string version_root;
  std::string body_root;
};
struct relation_add_result {
  std::string relation_id;
  std::string relation_root;
};
struct relation_revoke_result {
  std::string relation_root;
  std::string revoke_root;
};
struct cut_put_result {
  std::string cut_root;
};
struct ref_cas_result {
  std::string transition_id;
  std::string transition_root;
  std::string ref_name;
  std::string prior_cut_root;
  std::string current_cut_root;
  uint64_t prior_revision = 0;
  uint64_t current_revision = 0;
};

using mutation_result = std::variant<object_put_result, version_put_result, relation_add_result, relation_revoke_result,
                                     cut_put_result, ref_cas_result>;
using mutation_record =
    std::variant<kungfu::yijinjing::types::FactObjectRecorded, kungfu::yijinjing::types::FactVersionRecorded,
                 kungfu::yijinjing::types::FactRelationAdded, kungfu::yijinjing::types::FactRelationRevoked,
                 kungfu::yijinjing::types::FactCutCommitted, kungfu::yijinjing::types::FactRefTransition>;

struct action_failure {
  std::string code;
  std::string message;
  nlohmann::json details = nlohmann::json::object();
};

struct mutation_noop {
  std::string status;
  mutation_result result;
};

struct mutation_commit {
  std::string record_root;
  mutation_result result;
  mutation_record record;
};

using parsed_mutation = std::variant<mutation_request, action_failure>;
using mutation_outcome = std::variant<mutation_noop, mutation_commit, action_failure>;

std::string action_name(const mutation_request &request);
parsed_mutation parse_mutation_request(const nlohmann::json &input, const std::string &action);
mutation_outcome handle_mutation(const std::string &runtime_dir, const kernel_state &state,
                                 const mutation_request &request, const std::string &root_protocol);
nlohmann::json result_json(const mutation_result &result);

} // namespace kungfu::runtime::storage_service_api::fact_kernel_internal
