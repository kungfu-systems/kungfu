// SPDX-License-Identifier: Apache-2.0

#include "fact_actions.h"

#include <algorithm>
#include <map>
#include <set>
#include <stdexcept>
#include <tuple>
#include <type_traits>

#include <kungfu/common.h>
#include <kungfu/runtime/storage/fact_kernel.h>
#include <kungfu/runtime/storage/json_edge.h>

namespace kungfu::runtime::storage_service_api::fact_kernel_internal {

using namespace kungfu::yijinjing::types;

namespace {

class relation_endpoint_error : public fact_request_error {
public:
  explicit relation_endpoint_error(const std::string &message) : fact_request_error("invalid-field", message) {}
};

const std::map<std::string, std::set<std::string>> MUTATION_REQUEST_FIELDS = {
    {"object-put", {"action", "object_id", "object_type", "created_by_receipt_root"}},
    {"version-put",
     {"action", "object_id", "body", "schema_root", "parent_version_roots", "declaration_roots", "admission_roots"}},
    {"relation-add",
     {"action", "relation_id", "relation_type", "source", "target", "attributes_root", "admission_roots"}},
    {"relation-revoke", {"action", "relation_root", "reason_root"}},
    {"cut-put",
     {"action", "parent_cut_roots", "object_versions", "active_relation_roots", "declaration_roots", "admission_roots",
      "episode_frontier", "omission_roots", "conflict_roots"}},
    {"ref-cas",
     {"action", "transition_id", "ref_name", "expected_old_cut_root", "expected_old_revision", "new_cut_root", "kind",
      "reason_root"}},
};

void validate_closed_fields(const nlohmann::json &value, const std::set<std::string> &allowed,
                            const std::string &path) {
  if (!value.is_object()) {
    throw fact_request_error("invalid-field", path + " must be an object");
  }
  for (const auto &[key, unused] : value.items()) {
    (void)unused;
    if (allowed.count(key) == 0) {
      throw fact_request_error("invalid-field", path + " contains unknown field: " + key);
    }
  }
}

template <size_t N> void set_fixed(kungfu::array<char, N> &target, const std::string &value, const char *field) {
  if (value.size() >= N) {
    throw fact_request_error("invalid-field", std::string(field) + " exceeds native record capacity");
  }
  kungfu::copy_string(target, value.c_str());
}

relation_endpoint_request parse_endpoint(const nlohmann::json &endpoint) {
  if (!endpoint.is_object()) {
    throw fact_request_error("invalid-field", "relation endpoint must be an object");
  }
  relation_endpoint_request result{required_text(endpoint, "kind"), required_text(endpoint, "id"), std::nullopt};
  const auto external = result.kind == "external-identity-with-mapping-receipt";
  try {
    validate_closed_fields(endpoint,
                           external ? std::set<std::string>{"kind", "id", "mapping_receipt_root"}
                                    : std::set<std::string>{"kind", "id"},
                           "relation endpoint");
  } catch (const fact_request_error &error) {
    throw relation_endpoint_error(error.what());
  }
  if (external) {
    const auto mapping = text_or(endpoint, "mapping_receipt_root");
    if (!mapping.empty()) {
      result.mapping_receipt_root = mapping;
    }
  }
  return result;
}

nlohmann::json endpoint_json(const relation_endpoint_request &endpoint) {
  auto result = nlohmann::json{{"kind", endpoint.kind}, {"id", endpoint.id}};
  if (endpoint.mapping_receipt_root) {
    result["mapping_receipt_root"] = *endpoint.mapping_receipt_root;
  }
  return result;
}

bool endpoint_is_valid(const kernel_state &state, const relation_endpoint_request &endpoint) {
  if (endpoint.kind == "logical-object") {
    return state.objects.count(endpoint.id) != 0;
  }
  if (endpoint.kind == "pinned-version") {
    return state.versions.count(endpoint.id) != 0;
  }
  if (endpoint.kind != "external-identity-with-mapping-receipt" || !endpoint.mapping_receipt_root) {
    return false;
  }
  try {
    validate_root(*endpoint.mapping_receipt_root, "mapping_receipt_root");
    return true;
  } catch (const std::invalid_argument &) {
    return false;
  }
}

mutation_outcome handle_object_put(const std::string &runtime_dir, const kernel_state &state,
                                   const object_put_request &request, const std::string &root_protocol) {
  const nlohmann::json document = {{"schema", "kungfu.fact.object/v1"},
                                   {"objectId", request.object_id},
                                   {"objectType", request.object_type},
                                   {"createdByReceiptRoot", request.created_by_receipt_root}};
  const auto object_root = metadata_root("kungfu.fact.object/v1", document, root_protocol);
  const auto existing = state.objects.find(request.object_id);
  if (existing != state.objects.end()) {
    const auto existing_root = metadata_root("kungfu.fact.object/v1", existing->second, root_protocol);
    if (existing_root == object_root) {
      const auto authority =
          std::find_if(state.authority_records.begin(), state.authority_records.end(), [&](const auto &record) {
            return record.tag == FactObjectRecorded::tag && record.key == request.object_id;
          });
      return mutation_noop{"idempotent", object_put_result{request.object_id, authority == state.authority_records.end()
                                                                                  ? object_root
                                                                                  : authority->record_root}};
    } else {
      return action_failure{
          "invalid-identity",
          "object_id already names different immutable metadata",
          {{"object_id", request.object_id}, {"existing_root", existing_root}, {"requested_root", object_root}}};
    }
  }
  FactObjectRecorded record{};
  set_fixed(record.object_id, request.object_id, "object_id");
  set_fixed(record.object_type, request.object_type, "object_type");
  set_fixed(record.created_by_receipt_root, request.created_by_receipt_root, "created_by_receipt_root");
  set_fixed(record.object_root, object_root, "object_root");
  if (store_metadata(runtime_dir, "kungfu.fact.object/v1", document, root_protocol) != object_root) {
    throw std::runtime_error("fact object root changed during admission");
  }
  return mutation_commit{object_root, object_put_result{request.object_id, object_root}, record};
}

mutation_outcome handle_version_put(const std::string &runtime_dir, const kernel_state &state,
                                    const version_put_request &request, const std::string &root_protocol) {
  if (state.objects.count(request.object_id) == 0) {
    return action_failure{"unknown-object", "version object does not exist", {{"object_id", request.object_id}}};
  }
  if (request.declaration_roots.empty() || request.admission_roots.empty()) {
    return action_failure{"admission-missing", "version requires exact declaration and admission support"};
  }
  for (const auto &parent : request.parent_version_roots) {
    if (state.versions.count(parent) == 0) {
      return action_failure{"unknown-version", "parent version is unavailable", {{"version_root", parent}}};
    }
  }
  const auto body_root = content_root(request.body);
  const auto stored = content_store_put_if_absent(runtime_dir, BODY_NAMESPACE, request.body, body_root);
  if (!stored.value("ok", false)) {
    throw std::runtime_error("fact body store failed");
  }
  const auto parents_root =
      store_root_set(runtime_dir, "fact-version-parents/v1", request.parent_version_roots, root_protocol);
  const auto declarations_root =
      store_root_set(runtime_dir, "fact-declaration-roots/v1", request.declaration_roots, root_protocol);
  const auto admissions_root =
      store_root_set(runtime_dir, "fact-admission-roots/v1", request.admission_roots, root_protocol);
  const nlohmann::json document = {{"schema", "kungfu.fact.version/v1"},
                                   {"objectId", request.object_id},
                                   {"bodyRoot", body_root},
                                   {"schemaRoot", request.schema_root},
                                   {"parentVersionRoots", root_array(request.parent_version_roots)},
                                   {"declarationRoots", root_array(request.declaration_roots)},
                                   {"admissionRoots", root_array(request.admission_roots)}};
  const auto version_root = store_metadata(runtime_dir, "kungfu.fact.version/v1", document, root_protocol);
  const auto result = version_put_result{request.object_id, version_root, body_root};
  if (state.versions.count(version_root) != 0) {
    return mutation_noop{"idempotent", result};
  }
  FactVersionRecorded record{};
  set_fixed(record.object_id, request.object_id, "object_id");
  set_fixed(record.version_root, version_root, "version_root");
  set_fixed(record.body_root, body_root, "body_root");
  set_fixed(record.schema_root, request.schema_root, "schema_root");
  set_fixed(record.parent_versions_root, parents_root, "parent_versions_root");
  set_fixed(record.declaration_roots_root, declarations_root, "declaration_roots_root");
  set_fixed(record.admission_roots_root, admissions_root, "admission_roots_root");
  return mutation_commit{version_root, result, record};
}

mutation_outcome handle_relation_add(const std::string &runtime_dir, const kernel_state &state,
                                     const relation_add_request &request, const std::string &root_protocol) {
  if (request.admission_roots.empty()) {
    return action_failure{"admission-missing", "relation requires exact admission support"};
  }
  if (!endpoint_is_valid(state, request.source) || !endpoint_is_valid(state, request.target)) {
    return action_failure{"relation-endpoint-invalid", "relation endpoint is absent or not explicitly external"};
  }
  const auto admissions_root =
      store_root_set(runtime_dir, "fact-admission-roots/v1", request.admission_roots, root_protocol);
  const nlohmann::json document = {{"schema", "kungfu.fact.relation-add/v1"},
                                   {"relationId", request.relation_id},
                                   {"relationType", request.relation_type},
                                   {"source", endpoint_json(request.source)},
                                   {"target", endpoint_json(request.target)},
                                   {"attributesRoot", request.attributes_root},
                                   {"admissionRoots", root_array(request.admission_roots)}};
  const auto relation_root = metadata_root("kungfu.fact.relation-add/v1", document, root_protocol);
  const auto result = relation_add_result{request.relation_id, relation_root};
  if (state.relations.count(relation_root) != 0) {
    return mutation_noop{"idempotent", result};
  }
  for (const auto &[root, relation] : state.relations) {
    if (relation.value("relationId", std::string{}) == request.relation_id) {
      if (metadata_root("kungfu.fact.relation-add/v1", relation, root_protocol) == relation_root)
        return mutation_noop{"idempotent", relation_add_result{request.relation_id, root}};
      return action_failure{"invalid-identity", "relation_id already names different immutable metadata"};
    }
  }
  FactRelationAdded record{};
  set_fixed(record.relation_id, request.relation_id, "relation_id");
  set_fixed(record.relation_type, request.relation_type, "relation_type");
  set_fixed(record.source_kind, request.source.kind, "source.kind");
  set_fixed(record.source_id, request.source.id, "source.id");
  set_fixed(record.target_kind, request.target.kind, "target.kind");
  set_fixed(record.target_id, request.target.id, "target.id");
  set_fixed(record.attributes_root, request.attributes_root, "attributes_root");
  set_fixed(record.admission_roots_root, admissions_root, "admission_roots_root");
  set_fixed(record.relation_root, relation_root, "relation_root");
  if (store_metadata(runtime_dir, "kungfu.fact.relation-add/v1", document, root_protocol) != relation_root) {
    throw std::runtime_error("fact relation root changed during admission");
  }
  return mutation_commit{relation_root, result, record};
}

mutation_outcome handle_relation_revoke(const std::string &runtime_dir, const kernel_state &state,
                                        const relation_revoke_request &request, const std::string &root_protocol) {
  if (state.relations.count(request.relation_root) == 0) {
    return action_failure{"unknown-relation", "relation root does not exist"};
  }
  if (state.revoked_relations.count(request.relation_root) != 0) {
    return action_failure{"relation-already-revoked", "relation has already been revoked"};
  }
  const nlohmann::json document = {{"schema", "kungfu.fact.relation-revoke/v1"},
                                   {"relationRoot", request.relation_root},
                                   {"reasonRoot", request.reason_root}};
  const auto revoke_root = store_metadata(runtime_dir, "kungfu.fact.relation-revoke/v1", document, root_protocol);
  FactRelationRevoked record{};
  set_fixed(record.relation_root, request.relation_root, "relation_root");
  set_fixed(record.reason_root, request.reason_root, "reason_root");
  set_fixed(record.revoke_root, revoke_root, "revoke_root");
  return mutation_commit{revoke_root, relation_revoke_result{request.relation_root, revoke_root}, record};
}

mutation_outcome handle_cut_put(const std::string &runtime_dir, const kernel_state &state,
                                const cut_put_request &request, const std::string &root_protocol) {
  auto object_versions = nlohmann::json::array();
  for (const auto &member : request.object_versions) {
    const auto version = state.versions.find(member.version_root);
    if (version == state.versions.end() || version->second.value("objectId", std::string{}) != member.object_id) {
      return action_failure{"unknown-version",
                            "cut member version is not admitted for object",
                            {{"object_id", member.object_id}, {"version_root", member.version_root}}};
    }
    object_versions.push_back({member.object_id, member.version_root});
  }
  for (const auto &root : request.active_relation_roots) {
    if (state.relations.count(root) == 0 || state.revoked_relations.count(root) != 0) {
      return action_failure{"unknown-relation", "cut relation is missing or revoked", {{"relation_root", root}}};
    }
  }
  for (const auto &root : request.parent_cut_roots) {
    if (state.cuts.count(root) == 0) {
      return action_failure{"unknown-cut", "parent cut is unavailable", {{"parent_cut_root", root}}};
    }
  }
  auto frontier = nlohmann::json::array();
  for (const auto &entry : request.episode_frontier) {
    frontier.push_back({entry.episode_id, entry.sealed_content_root, entry.accepted_manifest_frame_uid});
  }
  const nlohmann::json document = {{"schema", "kungfu.fact.cut/v1"},
                                   {"parentCutRoots", root_array(request.parent_cut_roots)},
                                   {"objectVersions", object_versions},
                                   {"activeRelationRoots", root_array(request.active_relation_roots)},
                                   {"declarationRoots", root_array(request.declaration_roots)},
                                   {"admissionRoots", root_array(request.admission_roots)},
                                   {"episodeFrontier", frontier},
                                   {"omissionRoots", root_array(request.omission_roots)},
                                   {"conflictRoots", root_array(request.conflict_roots)}};
  const auto cut_root = store_metadata(runtime_dir, "kungfu.fact.cut/v1", document, root_protocol);
  const auto result = cut_put_result{cut_root};
  if (state.cuts.count(cut_root) != 0) {
    return mutation_noop{"idempotent", result};
  }
  FactCutCommitted record{};
  set_fixed(record.cut_root, cut_root, "cut_root");
  set_fixed(record.parent_cuts_root,
            store_root_set(runtime_dir, "fact-parent-cuts/v1", request.parent_cut_roots, root_protocol),
            "parent_cuts_root");
  set_fixed(record.object_versions_root,
            store_metadata(runtime_dir, "fact-object-versions/v1", object_versions, root_protocol),
            "object_versions_root");
  set_fixed(record.active_relations_root,
            store_root_set(runtime_dir, "fact-active-relations/v1", request.active_relation_roots, root_protocol),
            "active_relations_root");
  set_fixed(record.declaration_roots_root,
            store_root_set(runtime_dir, "fact-declaration-roots/v1", request.declaration_roots, root_protocol),
            "declaration_roots_root");
  set_fixed(record.admission_roots_root,
            store_root_set(runtime_dir, "fact-admission-roots/v1", request.admission_roots, root_protocol),
            "admission_roots_root");
  set_fixed(record.episode_frontier_root,
            store_metadata(runtime_dir, "fact-episode-frontier/v1", frontier, root_protocol), "episode_frontier_root");
  set_fixed(record.omission_roots_root,
            store_root_set(runtime_dir, "fact-omission-roots/v1", request.omission_roots, root_protocol),
            "omission_roots_root");
  set_fixed(record.conflict_roots_root,
            store_root_set(runtime_dir, "fact-conflict-roots/v1", request.conflict_roots, root_protocol),
            "conflict_roots_root");
  return mutation_commit{cut_root, result, record};
}

mutation_outcome handle_ref_cas(const std::string &runtime_dir, const kernel_state &state,
                                const ref_cas_request &request, const std::string &root_protocol) {
  if (state.cuts.count(request.new_cut_root) == 0) {
    return action_failure{"unknown-cut", "new cut is not admitted", {{"new_cut_root", request.new_cut_root}}};
  }
  const auto expected_old = request.expected_old_cut_root.value_or("");
  const nlohmann::json document = {{"schema", "kungfu.fact.ref-transition/v1"},
                                   {"transitionId", request.transition_id},
                                   {"refName", request.ref_name},
                                   {"expectedOldCutRoot", expected_old},
                                   {"expectedOldRevision", request.expected_old_revision},
                                   {"newCutRoot", request.new_cut_root},
                                   {"kind", request.kind},
                                   {"reasonRoot", request.reason_root}};
  const auto transition_root = metadata_root("kungfu.fact.ref-transition/v1", document, root_protocol);
  const auto replay = state.transitions.find(request.transition_id);
  if (replay != state.transitions.end()) {
    if (replay->second.at("transition_root").get<std::string>() != transition_root) {
      return action_failure{"transition-id-reused",
                            "transition_id was reused for different bytes",
                            {{"transition_id", request.transition_id}}};
    }
    const auto &value = replay->second;
    return mutation_noop{
        "idempotent-replay",
        ref_cas_result{value.value("transition_id", std::string{}), value.value("transition_root", std::string{}),
                       value.value("ref_name", std::string{}), value.value("prior_cut_root", std::string{}),
                       value.value("current_cut_root", std::string{}), value.value("prior_revision", uint64_t{0}),
                       value.value("current_revision", uint64_t{0})}};
  }
  const auto current = state.refs.find(request.ref_name);
  const auto current_cut =
      current == state.refs.end() ? std::string{} : current->second.at("cut_root").get<std::string>();
  const auto current_revision =
      current == state.refs.end() ? uint64_t{0} : current->second.at("revision").get<uint64_t>();
  if (!request.has_expected_old_cut_root || !request.has_expected_old_revision ||
      (current == state.refs.end() &&
       (request.expected_old_cut_root.has_value() || request.expected_old_revision != 0)) ||
      (current != state.refs.end() && !request.expected_old_cut_root.has_value())) {
    return action_failure{"expected-old-required", "exact expected-old cut root and revision are required"};
  }
  if (current_cut != expected_old || current_revision != request.expected_old_revision) {
    return action_failure{"stale-ref",
                          "ref changed since expected-old was observed",
                          {{"ref_name", request.ref_name},
                           {"expected_old_cut_root", expected_old},
                           {"expected_old_revision", request.expected_old_revision},
                           {"current_cut_root", current_cut},
                           {"current_revision", current_revision}}};
  }
  if (store_metadata(runtime_dir, "kungfu.fact.ref-transition/v1", document, root_protocol) != transition_root) {
    throw std::runtime_error("fact transition root changed during admission");
  }
  FactRefTransition record{};
  record.expected_old_revision = request.expected_old_revision;
  set_fixed(record.transition_id, request.transition_id, "transition_id");
  set_fixed(record.ref_name, request.ref_name, "ref_name");
  set_fixed(record.expected_old_cut_root, expected_old, "expected_old_cut_root");
  set_fixed(record.new_cut_root, request.new_cut_root, "new_cut_root");
  set_fixed(record.transition_kind, request.kind, "kind");
  set_fixed(record.reason_root, request.reason_root, "reason_root");
  set_fixed(record.transition_root, transition_root, "transition_root");
  return mutation_commit{transition_root,
                         ref_cas_result{request.transition_id, transition_root, request.ref_name, current_cut,
                                        request.new_cut_root, current_revision, current_revision + 1},
                         record};
}

} // namespace

std::string action_name(const mutation_request &request) {
  return std::visit(
      [](const auto &value) -> std::string {
        using request_type = std::decay_t<decltype(value)>;
        if constexpr (std::is_same_v<request_type, object_put_request>) {
          return "object-put";
        } else if constexpr (std::is_same_v<request_type, version_put_request>) {
          return "version-put";
        } else if constexpr (std::is_same_v<request_type, relation_add_request>) {
          return "relation-add";
        } else if constexpr (std::is_same_v<request_type, relation_revoke_request>) {
          return "relation-revoke";
        } else if constexpr (std::is_same_v<request_type, cut_put_request>) {
          return "cut-put";
        } else {
          return "ref-cas";
        }
      },
      request);
}

parsed_mutation parse_mutation_request(const nlohmann::json &input, const std::string &action) {
  const auto schema = MUTATION_REQUEST_FIELDS.find(action);
  if (schema == MUTATION_REQUEST_FIELDS.end()) {
    return action_failure{"unsupported-version", "unsupported Fact kernel action"};
  }
  validate_closed_fields(input, schema->second, action + " request");
  if (action == "object-put") {
    object_put_request request{required_text(input, "object_id"), required_text(input, "object_type"),
                               required_text(input, "created_by_receipt_root")};
    validate_fact_id(request.object_id, "object_id");
    validate_root(request.created_by_receipt_root, "created_by_receipt_root");
    return mutation_request{std::move(request)};
  }
  if (action == "version-put") {
    if (!input.contains("body") || !input.at("body").is_string()) {
      return action_failure{"body-missing", "body must be an opaque string"};
    }
    version_put_request request{required_text(input, "object_id"),
                                input.at("body").get<std::string>(),
                                required_text(input, "schema_root"),
                                normalized_roots(input, "parent_version_roots"),
                                normalized_roots(input, "declaration_roots"),
                                normalized_roots(input, "admission_roots")};
    validate_fact_id(request.object_id, "object_id");
    validate_root(request.schema_root, "schema_root");
    return mutation_request{std::move(request)};
  }
  if (action == "relation-add") {
    if (!input.contains("source") || !input.contains("target")) {
      throw fact_request_error("invalid-field", "source and target endpoint objects are required");
    }
    relation_add_request request;
    request.relation_id = required_text(input, "relation_id");
    request.relation_type = required_text(input, "relation_type");
    try {
      request.source = parse_endpoint(input.at("source"));
      request.target = parse_endpoint(input.at("target"));
    } catch (const relation_endpoint_error &error) {
      return action_failure{"invalid-field", error.what()};
    }
    request.attributes_root = required_text(input, "attributes_root");
    request.admission_roots = normalized_roots(input, "admission_roots");
    validate_fact_id(request.relation_id, "relation_id");
    validate_root(request.attributes_root, "attributes_root");
    return mutation_request{std::move(request)};
  }
  if (action == "relation-revoke") {
    relation_revoke_request request{required_text(input, "relation_root"), required_text(input, "reason_root")};
    validate_root(request.relation_root, "relation_root");
    validate_root(request.reason_root, "reason_root");
    return mutation_request{std::move(request)};
  }
  if (action == "cut-put") {
    cut_put_request request{
        normalized_roots(input, "parent_cut_roots"),      {},
        normalized_roots(input, "active_relation_roots"), normalized_roots(input, "declaration_roots"),
        normalized_roots(input, "admission_roots"),       {},
        normalized_roots(input, "omission_roots"),        normalized_roots(input, "conflict_roots")};
    std::set<std::string> object_ids;
    for (const auto &member : array_or_empty(input, "object_versions")) {
      validate_closed_fields(member, {"object_id", "version_root"}, "object_versions member");
      cut_object_version value{required_text(member, "object_id"), required_text(member, "version_root")};
      validate_fact_id(value.object_id, "object_versions.object_id");
      validate_root(value.version_root, "object_versions.version_root");
      if (!object_ids.insert(value.object_id).second) {
        throw fact_request_error("invalid-field", "object_versions contains duplicate object_id");
      }
      request.object_versions.push_back(std::move(value));
    }
    std::sort(request.object_versions.begin(), request.object_versions.end(), [](const auto &left, const auto &right) {
      return std::tie(left.object_id, left.version_root) < std::tie(right.object_id, right.version_root);
    });
    std::set<uint64_t> episode_ids;
    for (const auto &entry : array_or_empty(input, "episode_frontier")) {
      validate_closed_fields(entry, {"episode_id", "sealed_content_root", "accepted_manifest_frame_uid"},
                             "episode_frontier member");
      if (!entry.contains("episode_id") ||
          !(entry.at("episode_id").is_number_unsigned() ||
            (entry.at("episode_id").is_number_integer() && entry.at("episode_id").get<int64_t>() >= 0))) {
        return action_failure{"invalid-cut", "episode_frontier.episode_id must be an unsigned 64-bit integer"};
      }
      cut_episode_frontier_entry value{uint64_or(entry, "episode_id"), required_text(entry, "sealed_content_root"),
                                       required_text(entry, "accepted_manifest_frame_uid")};
      validate_root(value.sealed_content_root, "episode_frontier.sealed_content_root");
      if (!episode_ids.insert(value.episode_id).second) {
        return action_failure{"invalid-cut", "episode_frontier contains duplicate episode_id"};
      }
      request.episode_frontier.push_back(std::move(value));
    }
    std::sort(request.episode_frontier.begin(), request.episode_frontier.end(),
              [](const auto &left, const auto &right) {
                return std::tie(left.episode_id, left.sealed_content_root, left.accepted_manifest_frame_uid) <
                       std::tie(right.episode_id, right.sealed_content_root, right.accepted_manifest_frame_uid);
              });
    return mutation_request{std::move(request)};
  }
  ref_cas_request request;
  request.transition_id = required_text(input, "transition_id");
  request.ref_name = required_text(input, "ref_name");
  request.has_expected_old_cut_root =
      input.contains("expected_old_cut_root") &&
      (input.at("expected_old_cut_root").is_null() || input.at("expected_old_cut_root").is_string());
  if (request.has_expected_old_cut_root && input.at("expected_old_cut_root").is_string()) {
    request.expected_old_cut_root = input.at("expected_old_cut_root").get<std::string>();
  }
  request.has_expected_old_revision =
      input.contains("expected_old_revision") && is_nonnegative_integer(input.at("expected_old_revision"));
  request.expected_old_revision = uint64_or(input, "expected_old_revision");
  request.new_cut_root = required_text(input, "new_cut_root");
  request.kind = required_text(input, "kind");
  request.reason_root = required_text(input, "reason_root");
  validate_transition_id(request.transition_id);
  validate_ref_name(request.ref_name);
  validate_root(request.expected_old_cut_root.value_or(""), "expected_old_cut_root", true);
  validate_root(request.new_cut_root, "new_cut_root");
  static const std::set<std::string> kinds = {"create", "advance", "fork", "merge-view", "rollback"};
  if (kinds.count(request.kind) == 0) {
    throw fact_request_error("invalid-field", "kind is not a supported ref transition");
  }
  validate_root(request.reason_root, "reason_root");
  return mutation_request{std::move(request)};
}

mutation_outcome handle_mutation(const std::string &runtime_dir, const kernel_state &state,
                                 const mutation_request &request, const std::string &root_protocol) {
  return std::visit(
      [&](const auto &value) -> mutation_outcome {
        using request_type = std::decay_t<decltype(value)>;
        if constexpr (std::is_same_v<request_type, object_put_request>) {
          return handle_object_put(runtime_dir, state, value, root_protocol);
        } else if constexpr (std::is_same_v<request_type, version_put_request>) {
          return handle_version_put(runtime_dir, state, value, root_protocol);
        } else if constexpr (std::is_same_v<request_type, relation_add_request>) {
          return handle_relation_add(runtime_dir, state, value, root_protocol);
        } else if constexpr (std::is_same_v<request_type, relation_revoke_request>) {
          return handle_relation_revoke(runtime_dir, state, value, root_protocol);
        } else if constexpr (std::is_same_v<request_type, cut_put_request>) {
          return handle_cut_put(runtime_dir, state, value, root_protocol);
        } else {
          return handle_ref_cas(runtime_dir, state, value, root_protocol);
        }
      },
      request);
}

nlohmann::json result_json(const mutation_result &result) {
  return std::visit(
      [](const auto &value) -> nlohmann::json {
        using result_type = std::decay_t<decltype(value)>;
        if constexpr (std::is_same_v<result_type, object_put_result>) {
          return {{"object_id", value.object_id}, {"object_root", value.object_root}};
        } else if constexpr (std::is_same_v<result_type, version_put_result>) {
          return {{"object_id", value.object_id}, {"version_root", value.version_root}, {"body_root", value.body_root}};
        } else if constexpr (std::is_same_v<result_type, relation_add_result>) {
          return {{"relation_id", value.relation_id}, {"relation_root", value.relation_root}};
        } else if constexpr (std::is_same_v<result_type, relation_revoke_result>) {
          return {{"relation_root", value.relation_root}, {"revoke_root", value.revoke_root}};
        } else if constexpr (std::is_same_v<result_type, cut_put_result>) {
          return {{"cut_root", value.cut_root}};
        } else {
          return {{"transition_id", value.transition_id},
                  {"transition_root", value.transition_root},
                  {"ref_name", value.ref_name},
                  {"prior_cut_root", value.prior_cut_root},
                  {"current_cut_root", value.current_cut_root},
                  {"prior_revision", value.prior_revision},
                  {"current_revision", value.current_revision}};
        }
      },
      result);
}

} // namespace kungfu::runtime::storage_service_api::fact_kernel_internal
