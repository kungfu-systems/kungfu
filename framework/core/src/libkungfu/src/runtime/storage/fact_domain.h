// SPDX-License-Identifier: Apache-2.0
#pragma once

#include <cstdint>
#include <map>
#include <optional>
#include <string>
#include <variant>
#include <vector>

#include <nlohmann/json.hpp>

namespace kungfu::runtime::storage_service_api::fact_kernel_internal {

struct relation_endpoint {
  std::string kind;
  std::string id;
  std::optional<std::string> mapping_receipt_root;
};

struct fact_object {
  std::string object_id;
  std::string object_type;
  std::string created_by_receipt_root;
};

struct fact_version {
  std::string object_id;
  std::string body_root;
  std::string schema_root;
  std::vector<std::string> parent_version_roots;
  std::vector<std::string> declaration_roots;
  std::vector<std::string> admission_roots;
};

struct fact_relation {
  std::string relation_id;
  std::string relation_type;
  relation_endpoint source;
  relation_endpoint target;
  std::string attributes_root;
  std::vector<std::string> admission_roots;
};

struct fact_revocation {
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

struct fact_cut {
  std::vector<std::string> parent_cut_roots;
  std::vector<cut_object_version> object_versions;
  std::vector<std::string> active_relation_roots;
  std::vector<std::string> declaration_roots;
  std::vector<std::string> admission_roots;
  std::vector<cut_episode_frontier_entry> episode_frontier;
  std::vector<std::string> omission_roots;
  std::vector<std::string> conflict_roots;
};

struct fact_transition {
  std::string transition_id;
  std::string ref_name;
  std::string expected_old_cut_root;
  uint64_t expected_old_revision = 0;
  std::string new_cut_root;
  std::string kind;
  std::string reason_root;
  std::string transition_root;
  uint64_t revision = 0;
};

using fact_document =
    std::variant<fact_object, fact_version, fact_relation, fact_revocation, fact_cut, fact_transition>;

struct fact_ref {
  std::string ref_name;
  std::string cut_root;
  uint64_t revision = 0;
  std::string transition_id;
  std::string transition_root;
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
  relation_endpoint source;
  relation_endpoint target;
  std::string attributes_root;
  std::vector<std::string> admission_roots;
};

struct relation_revoke_request {
  std::string relation_root;
  std::string reason_root;
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

struct operation_receipt {
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
  mutation_result result = cut_put_result{};
  std::string receipt_root;
};

struct operation_receipt_authority;

struct root_mapping {
  std::string legacy_root;
  std::string legacy_protocol;
  std::string successor_root;
  std::string successor_protocol;
  std::string admission_root;
};

[[nodiscard]] const char *fact_document_domain(const fact_document &document);
[[nodiscard]] nlohmann::json fact_document_json(const fact_document &document);
[[nodiscard]] fact_document parse_fact_document(const std::string &domain, const nlohmann::json &document,
                                                const std::string &record_root = {}, uint64_t revision = 0);
[[nodiscard]] nlohmann::json mutation_result_json(const mutation_result &result);
[[nodiscard]] mutation_result parse_mutation_result(const std::string &operation, const nlohmann::json &result);
[[nodiscard]] nlohmann::json operation_receipt_json(const operation_receipt &receipt);
[[nodiscard]] nlohmann::json operation_receipt_state_json(const operation_receipt &receipt);
[[nodiscard]] operation_receipt parse_operation_receipt(const nlohmann::json &document,
                                                        const fact_document &authority_document,
                                                        const operation_receipt_authority &authority);
[[nodiscard]] nlohmann::json fact_transition_state_json(const fact_transition &transition);
[[nodiscard]] nlohmann::json fact_ref_json(const fact_ref &ref);
[[nodiscard]] nlohmann::json fact_refs_json(const std::map<std::string, fact_ref> &refs);
[[nodiscard]] root_mapping parse_root_mapping(const nlohmann::json &document);
[[nodiscard]] nlohmann::json root_mapping_json(const root_mapping &mapping);

} // namespace kungfu::runtime::storage_service_api::fact_kernel_internal
