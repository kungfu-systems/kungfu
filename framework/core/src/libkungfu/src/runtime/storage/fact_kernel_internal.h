// SPDX-License-Identifier: Apache-2.0
#pragma once

#include "fact_domain.h"

#include <array>
#include <cstddef>
#include <cstdint>
#include <map>
#include <set>
#include <stdexcept>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include <nlohmann/json.hpp>

namespace kungfu::runtime::storage_service_api::fact_kernel_internal {

inline constexpr uint32_t LEGACY_RECORD_SCHEMA_VERSION = 1;
inline constexpr uint32_t PORTABLE_RECORD_SCHEMA_VERSION = 2;
inline constexpr const char *JOURNAL_NAMESPACE = "facts";
inline constexpr const char *JOURNAL_NAME = "kernel";
inline constexpr const char *METADATA_NAMESPACE = "fact-kernel-metadata";
inline constexpr const char *BODY_NAMESPACE = "fact-bodies";
inline constexpr const char *LEGACY_ROOT_PROTOCOL = "sha256-length-framed-fields-v1";
inline constexpr const char *PORTABLE_ROOT_PROTOCOL = "kungfu.fact-root.canonical/v2";
inline constexpr const char *WRITER_ROOT_PROTOCOL = PORTABLE_ROOT_PROTOCOL;

enum class action_route {
  capabilities,
  canonical_root,
  query,
  authority_export,
  authority_import,
  durability_reconcile,
  mutation,
  unknown
};

struct action_registration {
  std::string_view name;
  action_route route;
};

inline constexpr std::array ACTION_REGISTRY = {
    action_registration{"capabilities", action_route::capabilities},
    action_registration{"canonical-root", action_route::canonical_root},
    action_registration{"object-put", action_route::mutation},
    action_registration{"version-put", action_route::mutation},
    action_registration{"relation-add", action_route::mutation},
    action_registration{"relation-revoke", action_route::mutation},
    action_registration{"cut-put", action_route::mutation},
    action_registration{"ref-cas", action_route::mutation},
    action_registration{"durability-reconcile", action_route::durability_reconcile},
    action_registration{"query", action_route::query},
    action_registration{"authority-export", action_route::authority_export},
    action_registration{"authority-import", action_route::authority_import},
};

inline action_route resolve_action_route(std::string_view name) {
  for (const auto &registration : ACTION_REGISTRY) {
    if (registration.name == name) {
      return registration.route;
    }
  }
  return action_route::unknown;
}

class fact_request_error : public std::invalid_argument {
public:
  fact_request_error(std::string code, const std::string &message)
      : std::invalid_argument(message), code_(std::move(code)) {}

  [[nodiscard]] const std::string &code() const { return code_; }

private:
  std::string code_;
};

class fact_integrity_error : public std::runtime_error {
public:
  fact_integrity_error(std::string code, const std::string &message)
      : std::runtime_error(message), code_(std::move(code)) {}

  [[nodiscard]] const std::string &code() const { return code_; }

private:
  std::string code_;
};

struct kernel_authority_record {
  uint32_t tag = 0;
  uint64_t sequence = 0;
  std::string key;
  std::string record_root;
  fact_document document = fact_object{};
  operation_receipt receipt = {};
  std::string root_protocol;
  std::string mapping_receipt_root;
  root_mapping mapping_receipt = {};
};

struct kernel_fold_issue {
  uint64_t sequence = 0;
  bool sequence_known = false;
  uint32_t frame_tag = 0;
  std::string record_root;
  std::string failure_code;
  std::string message;
  std::string phase;
  std::string recovery;
};

struct kernel_state {
  uint64_t next_sequence = 1;
  size_t unknown_records = 0;
  std::vector<kernel_fold_issue> issues;
  std::map<std::string, fact_object> objects;
  std::map<std::string, fact_version> versions;
  std::map<std::string, fact_relation> relations;
  std::set<std::string> revoked_relations;
  std::map<std::string, fact_revocation> revocations;
  std::map<std::string, fact_cut> cuts;
  std::map<std::string, fact_ref> refs;
  std::map<std::string, fact_transition> transitions;
  std::map<std::string, operation_receipt> receipts;
  std::vector<kernel_authority_record> authority_records;
};

struct mutation_batch_options {
  std::string bundle_root;
  bool inject_import_failure = false;
  size_t fail_after_logical_appends = 0;
};

std::string required_text(const nlohmann::json &, const char *);
std::string text_or(const nlohmann::json &, const char *, const std::string &fallback = {});
uint64_t uint64_or(const nlohmann::json &, const char *, uint64_t fallback = 0);
bool is_nonnegative_integer(const nlohmann::json &);
nlohmann::json array_or_empty(const nlohmann::json &, const char *);
std::string canonical_json(const nlohmann::json &);
std::string content_root(const std::string &);
std::string metadata_root(const std::string &, const nlohmann::json &,
                          const std::string &protocol = WRITER_ROOT_PROTOCOL);
std::string store_metadata(const std::string &, const std::string &, const nlohmann::json &,
                           const std::string &protocol = WRITER_ROOT_PROTOCOL);
nlohmann::json load_metadata(const std::string &, const std::string &, const std::string &expected_domain = {});
nlohmann::json root_mapping_receipt(const std::string &, const nlohmann::json &, const std::string &,
                                    const std::string &);
std::string root_mapping_receipt_root(const nlohmann::json &);
std::vector<std::string> normalized_roots(const nlohmann::json &, const char *);
nlohmann::json root_array(const std::vector<std::string> &);
std::string store_root_set(const std::string &, const std::string &, const std::vector<std::string> &,
                           const std::string &protocol = WRITER_ROOT_PROTOCOL);
void validate_fact_id(const std::string &, const char *);
void validate_root(const std::string &, const char *, bool allow_empty = false);
void validate_ref_name(const std::string &);
void validate_transition_id(const std::string &);
void reject_environment_identity(const nlohmann::json &);
bool qualification_faults_enabled();
void require_qualification_fault_gate();
std::string failure_category_for(const std::string &);
nlohmann::json failure(const std::string &, const std::string &, const std::string &,
                       const nlohmann::json &details = nlohmann::json::object());
nlohmann::json fold_issues_json(const std::vector<kernel_fold_issue> &);
nlohmann::json canonical_root_result(const nlohmann::json &);

kernel_state fold_kernel(const std::string &);
nlohmann::json capabilities_document();
nlohmann::json query_kernel(const std::string &, const kernel_state &, const nlohmann::json &);
nlohmann::json export_authority(const std::string &);
nlohmann::json import_authority(const std::string &, const nlohmann::json &);
nlohmann::json authority_bundle(const std::string &, const kernel_state &);
void validate_durable_ref_cas_admission(const std::string &, const nlohmann::json &);
nlohmann::json apply_default_durable_ref_cas_admission(const nlohmann::json &);
nlohmann::json durably_admit_ref_cas(const std::string &, const nlohmann::json &, const nlohmann::json &);
nlohmann::json reconcile_durable_ref_cas(const std::string &, const nlohmann::json &);
std::string response_record_root(const std::string &, const nlohmann::json &);
nlohmann::json execute_mutation(const std::string &, const nlohmann::json &);
nlohmann::json execute_mutation_with_protocol(const std::string &, const nlohmann::json &, const std::string &);
nlohmann::json execute_mutation_batch(const std::string &, const nlohmann::json &operations,
                                      const std::set<std::string> &expected_existing_roots,
                                      const mutation_batch_options &options);

} // namespace kungfu::runtime::storage_service_api::fact_kernel_internal
