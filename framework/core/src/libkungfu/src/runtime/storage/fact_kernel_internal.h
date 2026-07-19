// SPDX-License-Identifier: Apache-2.0
#pragma once

#include <array>
#include <cstdint>
#include <map>
#include <set>
#include <string>
#include <string_view>
#include <vector>

#include <nlohmann/json.hpp>

namespace kungfu::runtime::storage_service_api::fact_kernel_internal {

inline constexpr uint32_t SCHEMA_VERSION = 1;
inline constexpr const char *JOURNAL_NAMESPACE = "facts";
inline constexpr const char *JOURNAL_NAME = "kernel";
inline constexpr const char *METADATA_NAMESPACE = "fact-kernel-metadata";
inline constexpr const char *BODY_NAMESPACE = "fact-bodies";
inline constexpr const char *ROOT_PROTOCOL = "sha256-length-framed-fields-v1";
inline constexpr const char *PORTABLE_ROOT_PROTOCOL = "kungfu.fact-root.canonical/v2";

enum class action_route { capabilities, canonical_root, query, authority_export, authority_import, mutation };

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
  return action_route::mutation;
}

struct kernel_authority_record {
  uint32_t tag = 0;
  uint64_t sequence = 0;
  std::string key;
  std::string record_root;
  nlohmann::json document = nlohmann::json::object();
  nlohmann::json receipt = nlohmann::json::object();
};

struct kernel_state {
  uint64_t next_sequence = 1;
  size_t unknown_records = 0;
  std::map<std::string, nlohmann::json> objects;
  std::map<std::string, nlohmann::json> versions;
  std::map<std::string, nlohmann::json> relations;
  std::set<std::string> revoked_relations;
  std::map<std::string, nlohmann::json> revocations;
  std::map<std::string, nlohmann::json> cuts;
  std::map<std::string, nlohmann::json> refs;
  std::map<std::string, nlohmann::json> transitions;
  std::map<std::string, nlohmann::json> receipts;
  std::vector<kernel_authority_record> authority_records;
};

std::string required_text(const nlohmann::json &, const char *);
std::string text_or(const nlohmann::json &, const char *, const std::string &fallback = {});
uint64_t uint64_or(const nlohmann::json &, const char *, uint64_t fallback = 0);
bool is_nonnegative_integer(const nlohmann::json &);
nlohmann::json array_or_empty(const nlohmann::json &, const char *);
std::string canonical_json(const nlohmann::json &);
std::string content_root(const std::string &);
std::string metadata_root(const std::string &, const nlohmann::json &);
std::string store_metadata(const std::string &, const std::string &, const nlohmann::json &);
nlohmann::json load_metadata(const std::string &, const std::string &, const std::string &expected_domain = {});
std::vector<std::string> normalized_roots(const nlohmann::json &, const char *);
nlohmann::json root_array(const std::vector<std::string> &);
std::string store_root_set(const std::string &, const std::string &, const std::vector<std::string> &);
void validate_fact_id(const std::string &, const char *);
void validate_root(const std::string &, const char *, bool allow_empty = false);
void validate_ref_name(const std::string &);
void validate_transition_id(const std::string &);
void reject_environment_identity(const nlohmann::json &);
nlohmann::json failure(const std::string &, const std::string &, const std::string &,
                       const nlohmann::json &details = nlohmann::json::object());
nlohmann::json canonical_root_result(const nlohmann::json &);

kernel_state fold_kernel(const std::string &);
nlohmann::json capabilities_document();
nlohmann::json query_kernel(const std::string &, const kernel_state &, const nlohmann::json &);
nlohmann::json export_authority(const std::string &);
nlohmann::json import_authority(const std::string &, const nlohmann::json &);
std::string response_record_root(const std::string &, const nlohmann::json &);
nlohmann::json execute_mutation(const std::string &, const nlohmann::json &);
nlohmann::json execute_mutation_batch(const std::string &, const nlohmann::json &operations,
                                      const std::set<std::string> &expected_existing_roots);

} // namespace kungfu::runtime::storage_service_api::fact_kernel_internal
