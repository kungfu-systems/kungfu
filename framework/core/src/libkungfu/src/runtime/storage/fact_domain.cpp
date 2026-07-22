// SPDX-License-Identifier: Apache-2.0

#include "fact_domain.h"
#include "fact_authority.h"

#include <set>
#include <stdexcept>
#include <type_traits>

namespace kungfu::runtime::storage_service_api::fact_kernel_internal {

namespace {

void require_exact_fields(const nlohmann::json &value, const std::set<std::string> &fields, const char *domain) {
  if (!value.is_object()) {
    throw std::runtime_error(std::string(domain) + " metadata must be an object");
  }
  std::set<std::string> actual;
  for (const auto &[key, unused] : value.items()) {
    (void)unused;
    actual.insert(key);
  }
  if (actual != fields) {
    throw std::runtime_error(std::string(domain) + " metadata fields do not match the typed contract");
  }
}

std::string required_string(const nlohmann::json &value, const char *field) {
  if (!value.contains(field) || !value.at(field).is_string()) {
    throw std::runtime_error(std::string(field) + " must be a string");
  }
  return value.at(field).get<std::string>();
}

uint64_t required_uint64(const nlohmann::json &value, const char *field) {
  if (!value.contains(field) || !(value.at(field).is_number_unsigned() ||
                                  (value.at(field).is_number_integer() && value.at(field).get<int64_t>() >= 0))) {
    throw std::runtime_error(std::string(field) + " must be an unsigned 64-bit integer");
  }
  return value.at(field).get<uint64_t>();
}

std::vector<std::string> string_array(const nlohmann::json &value, const char *field) {
  if (!value.contains(field) || !value.at(field).is_array()) {
    throw std::runtime_error(std::string(field) + " must be an array");
  }
  std::vector<std::string> result;
  for (const auto &item : value.at(field)) {
    if (!item.is_string()) {
      throw std::runtime_error(std::string(field) + " must contain only strings");
    }
    result.push_back(item.get<std::string>());
  }
  return result;
}

relation_endpoint parse_endpoint(const nlohmann::json &value) {
  const auto kind = required_string(value, "kind");
  const auto has_mapping = value.contains("mapping_receipt_root");
  require_exact_fields(value,
                       has_mapping ? std::set<std::string>{"kind", "id", "mapping_receipt_root"}
                                   : std::set<std::string>{"kind", "id"},
                       "kungfu.fact.relation-endpoint/v1");
  relation_endpoint result{kind, required_string(value, "id"), std::nullopt};
  if (has_mapping) {
    result.mapping_receipt_root = required_string(value, "mapping_receipt_root");
  }
  return result;
}

nlohmann::json endpoint_json(const relation_endpoint &endpoint) {
  auto value = nlohmann::json{{"kind", endpoint.kind}, {"id", endpoint.id}};
  if (endpoint.mapping_receipt_root) {
    value["mapping_receipt_root"] = *endpoint.mapping_receipt_root;
  }
  return value;
}

} // namespace

const char *fact_document_domain(const fact_document &document) {
  return std::visit(
      [](const auto &value) {
        using value_type = std::decay_t<decltype(value)>;
        if constexpr (std::is_same_v<value_type, fact_object>) {
          return "kungfu.fact.object/v1";
        } else if constexpr (std::is_same_v<value_type, fact_version>) {
          return "kungfu.fact.version/v1";
        } else if constexpr (std::is_same_v<value_type, fact_relation>) {
          return "kungfu.fact.relation-add/v1";
        } else if constexpr (std::is_same_v<value_type, fact_revocation>) {
          return "kungfu.fact.relation-revoke/v1";
        } else if constexpr (std::is_same_v<value_type, fact_cut>) {
          return "kungfu.fact.cut/v1";
        } else {
          return "kungfu.fact.ref-transition/v1";
        }
      },
      document);
}

nlohmann::json fact_document_json(const fact_document &document) {
  return std::visit(
      [](const auto &value) -> nlohmann::json {
        using value_type = std::decay_t<decltype(value)>;
        if constexpr (std::is_same_v<value_type, fact_object>) {
          return {{"schema", "kungfu.fact.object/v1"},
                  {"objectId", value.object_id},
                  {"objectType", value.object_type},
                  {"createdByReceiptRoot", value.created_by_receipt_root}};
        } else if constexpr (std::is_same_v<value_type, fact_version>) {
          return {{"schema", "kungfu.fact.version/v1"},
                  {"objectId", value.object_id},
                  {"bodyRoot", value.body_root},
                  {"schemaRoot", value.schema_root},
                  {"parentVersionRoots", value.parent_version_roots},
                  {"declarationRoots", value.declaration_roots},
                  {"admissionRoots", value.admission_roots}};
        } else if constexpr (std::is_same_v<value_type, fact_relation>) {
          return {{"schema", "kungfu.fact.relation-add/v1"}, {"relationId", value.relation_id},
                  {"relationType", value.relation_type},     {"source", endpoint_json(value.source)},
                  {"target", endpoint_json(value.target)},   {"attributesRoot", value.attributes_root},
                  {"admissionRoots", value.admission_roots}};
        } else if constexpr (std::is_same_v<value_type, fact_revocation>) {
          return {{"schema", "kungfu.fact.relation-revoke/v1"},
                  {"relationRoot", value.relation_root},
                  {"reasonRoot", value.reason_root}};
        } else if constexpr (std::is_same_v<value_type, fact_cut>) {
          auto members = nlohmann::json::array();
          for (const auto &member : value.object_versions) {
            members.push_back({member.object_id, member.version_root});
          }
          auto frontier = nlohmann::json::array();
          for (const auto &entry : value.episode_frontier) {
            frontier.push_back({entry.episode_id, entry.sealed_content_root, entry.accepted_manifest_frame_uid});
          }
          return {{"schema", "kungfu.fact.cut/v1"},
                  {"parentCutRoots", value.parent_cut_roots},
                  {"objectVersions", std::move(members)},
                  {"activeRelationRoots", value.active_relation_roots},
                  {"declarationRoots", value.declaration_roots},
                  {"admissionRoots", value.admission_roots},
                  {"episodeFrontier", std::move(frontier)},
                  {"omissionRoots", value.omission_roots},
                  {"conflictRoots", value.conflict_roots}};
        } else {
          return {{"schema", "kungfu.fact.ref-transition/v1"},
                  {"transitionId", value.transition_id},
                  {"refName", value.ref_name},
                  {"expectedOldCutRoot", value.expected_old_cut_root},
                  {"expectedOldRevision", value.expected_old_revision},
                  {"newCutRoot", value.new_cut_root},
                  {"kind", value.kind},
                  {"reasonRoot", value.reason_root}};
        }
      },
      document);
}

fact_document parse_fact_document(const std::string &domain, const nlohmann::json &document,
                                  const std::string &record_root, uint64_t revision) {
  const auto schema = required_string(document, "schema");
  auto portable_domain = domain;
  if (portable_domain.ends_with("/v1")) {
    portable_domain.replace(portable_domain.size() - 2, 2, "v2");
  }
  if (schema != domain && schema != portable_domain) {
    throw std::runtime_error("Fact metadata schema does not match its domain");
  }
  if (domain == "kungfu.fact.object/v1") {
    require_exact_fields(document, {"schema", "objectId", "objectType", "createdByReceiptRoot"}, domain.c_str());
    return fact_object{required_string(document, "objectId"), required_string(document, "objectType"),
                       required_string(document, "createdByReceiptRoot")};
  }
  if (domain == "kungfu.fact.version/v1") {
    require_exact_fields(
        document,
        {"schema", "objectId", "bodyRoot", "schemaRoot", "parentVersionRoots", "declarationRoots", "admissionRoots"},
        domain.c_str());
    return fact_version{required_string(document, "objectId"),      required_string(document, "bodyRoot"),
                        required_string(document, "schemaRoot"),    string_array(document, "parentVersionRoots"),
                        string_array(document, "declarationRoots"), string_array(document, "admissionRoots")};
  }
  if (domain == "kungfu.fact.relation-add/v1") {
    require_exact_fields(
        document, {"schema", "relationId", "relationType", "source", "target", "attributesRoot", "admissionRoots"},
        domain.c_str());
    return fact_relation{required_string(document, "relationId"),     required_string(document, "relationType"),
                         parse_endpoint(document.at("source")),       parse_endpoint(document.at("target")),
                         required_string(document, "attributesRoot"), string_array(document, "admissionRoots")};
  }
  if (domain == "kungfu.fact.relation-revoke/v1") {
    require_exact_fields(document, {"schema", "relationRoot", "reasonRoot"}, domain.c_str());
    return fact_revocation{required_string(document, "relationRoot"), required_string(document, "reasonRoot")};
  }
  if (domain == "kungfu.fact.cut/v1") {
    require_exact_fields(document,
                         {"schema", "parentCutRoots", "objectVersions", "activeRelationRoots", "declarationRoots",
                          "admissionRoots", "episodeFrontier", "omissionRoots", "conflictRoots"},
                         domain.c_str());
    fact_cut result;
    result.parent_cut_roots = string_array(document, "parentCutRoots");
    result.active_relation_roots = string_array(document, "activeRelationRoots");
    result.declaration_roots = string_array(document, "declarationRoots");
    result.admission_roots = string_array(document, "admissionRoots");
    result.omission_roots = string_array(document, "omissionRoots");
    result.conflict_roots = string_array(document, "conflictRoots");
    for (const auto &member : document.at("objectVersions")) {
      if (!member.is_array() || member.size() != 2 || !member.at(0).is_string() || !member.at(1).is_string()) {
        throw std::runtime_error("objectVersions member must be a pair of strings");
      }
      result.object_versions.push_back({member.at(0).get<std::string>(), member.at(1).get<std::string>()});
    }
    for (const auto &entry : document.at("episodeFrontier")) {
      if (!entry.is_array() || entry.size() != 3 || !entry.at(1).is_string() || !entry.at(2).is_string() ||
          !(entry.at(0).is_number_unsigned() || (entry.at(0).is_number_integer() && entry.at(0).get<int64_t>() >= 0))) {
        throw std::runtime_error("episodeFrontier member must match the typed frontier contract");
      }
      result.episode_frontier.push_back(
          {entry.at(0).get<uint64_t>(), entry.at(1).get<std::string>(), entry.at(2).get<std::string>()});
    }
    return result;
  }
  if (domain == "kungfu.fact.ref-transition/v1") {
    require_exact_fields(document,
                         {"schema", "transitionId", "refName", "expectedOldCutRoot", "expectedOldRevision",
                          "newCutRoot", "kind", "reasonRoot"},
                         domain.c_str());
    return fact_transition{required_string(document, "transitionId"),
                           required_string(document, "refName"),
                           required_string(document, "expectedOldCutRoot"),
                           required_uint64(document, "expectedOldRevision"),
                           required_string(document, "newCutRoot"),
                           required_string(document, "kind"),
                           required_string(document, "reasonRoot"),
                           record_root,
                           revision};
  }
  throw std::runtime_error("unsupported Fact metadata domain");
}

nlohmann::json mutation_result_json(const mutation_result &result) {
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

mutation_result parse_mutation_result(const std::string &operation, const nlohmann::json &result) {
  if (operation == "object-put") {
    return object_put_result{required_string(result, "object_id"), required_string(result, "object_root")};
  }
  if (operation == "version-put") {
    return version_put_result{required_string(result, "object_id"), required_string(result, "version_root"),
                              required_string(result, "body_root")};
  }
  if (operation == "relation-add") {
    return relation_add_result{required_string(result, "relation_id"), required_string(result, "relation_root")};
  }
  if (operation == "relation-revoke") {
    return relation_revoke_result{required_string(result, "relation_root"), required_string(result, "revoke_root")};
  }
  if (operation == "cut-put") {
    return cut_put_result{required_string(result, "cut_root")};
  }
  if (operation == "ref-cas") {
    return ref_cas_result{required_string(result, "transition_id"),    required_string(result, "transition_root"),
                          required_string(result, "ref_name"),         required_string(result, "prior_cut_root"),
                          required_string(result, "current_cut_root"), required_uint64(result, "prior_revision"),
                          required_uint64(result, "current_revision")};
  }
  throw std::runtime_error("unsupported Fact receipt operation");
}

nlohmann::json operation_receipt_json(const operation_receipt &receipt) {
  return {{"schema", "kungfu.fact.operation-receipt/v1"},
          {"operationId", receipt.operation_id},
          {"operation", receipt.operation},
          {"status", receipt.status},
          {"failureCode", receipt.failure_code ? nlohmann::json(*receipt.failure_code) : nlohmann::json(nullptr)},
          {"requestRoot", receipt.request_root},
          {"recordRoot", receipt.record_root},
          {"priorCutRoot", receipt.prior_cut_root},
          {"currentCutRoot", receipt.current_cut_root},
          {"priorRevision", receipt.prior_revision},
          {"currentRevision", receipt.current_revision},
          {"writeOccurred", receipt.write_occurred},
          {"result", mutation_result_json(receipt.result)}};
}

nlohmann::json operation_receipt_state_json(const operation_receipt &receipt) {
  auto result = operation_receipt_json(receipt);
  result["receiptRoot"] = receipt.receipt_root;
  return result;
}

operation_receipt parse_operation_receipt(const nlohmann::json &document, const fact_document &authority_document,
                                          const operation_receipt_authority &authority) {
  const auto schema = required_string(document, "schema");
  if (schema == "kungfu.fact.operation-receipt/v1" || schema == "kungfu.fact.operation-receipt/v2") {
    // Both durable encodings intentionally carry only the receipt Root fields.
    // requestRoot/writeOccurred come from the adjacent Hana record and result
    // is reconstructed from the paired typed authority document.
    require_exact_fields(document,
                         {"schema", "operationId", "operation", "status", "failureCode", "recordRoot", "priorCutRoot",
                          "currentCutRoot", "priorRevision", "currentRevision"},
                         schema.c_str());
  } else {
    throw std::runtime_error("unsupported Fact operation receipt schema");
  }
  if (!document.at("failureCode").is_null()) {
    throw std::runtime_error("Fact operation receipt does not match the accepted typed contract");
  }
  const auto operation = required_string(document, "operation");
  if (required_string(document, "status") != "accepted") {
    throw std::runtime_error("Fact operation receipt status does not match the accepted typed contract");
  }
  const auto expected_operation = std::visit(
      [](const auto &value) {
        using value_type = std::decay_t<decltype(value)>;
        if constexpr (std::is_same_v<value_type, fact_object>) {
          return "object-put";
        } else if constexpr (std::is_same_v<value_type, fact_version>) {
          return "version-put";
        } else if constexpr (std::is_same_v<value_type, fact_relation>) {
          return "relation-add";
        } else if constexpr (std::is_same_v<value_type, fact_revocation>) {
          return "relation-revoke";
        } else if constexpr (std::is_same_v<value_type, fact_cut>) {
          return "cut-put";
        } else {
          return "ref-cas";
        }
      },
      authority_document);
  if (operation != expected_operation) {
    throw std::runtime_error("Fact operation receipt does not match the paired authority record");
  }
  const auto result = std::visit(
      [&](const auto &value) -> mutation_result {
        using value_type = std::decay_t<decltype(value)>;
        if constexpr (std::is_same_v<value_type, fact_object>) {
          return object_put_result{value.object_id, required_string(document, "recordRoot")};
        } else if constexpr (std::is_same_v<value_type, fact_version>) {
          return version_put_result{value.object_id, required_string(document, "recordRoot"), value.body_root};
        } else if constexpr (std::is_same_v<value_type, fact_relation>) {
          return relation_add_result{value.relation_id, required_string(document, "recordRoot")};
        } else if constexpr (std::is_same_v<value_type, fact_revocation>) {
          return relation_revoke_result{value.relation_root, required_string(document, "recordRoot")};
        } else if constexpr (std::is_same_v<value_type, fact_cut>) {
          return cut_put_result{required_string(document, "recordRoot")};
        } else {
          return ref_cas_result{
              value.transition_id, value.transition_root,       value.ref_name, value.expected_old_cut_root,
              value.new_cut_root,  value.expected_old_revision, value.revision};
        }
      },
      authority_document);
  operation_receipt receipt{required_string(document, "operationId"),
                            operation,
                            required_string(document, "status"),
                            std::nullopt,
                            authority.request_root,
                            required_string(document, "recordRoot"),
                            required_string(document, "priorCutRoot"),
                            required_string(document, "currentCutRoot"),
                            required_uint64(document, "priorRevision"),
                            required_uint64(document, "currentRevision"),
                            authority.write_occurred,
                            result,
                            authority.receipt_root};
  validate_operation_receipt_authority(receipt, authority);
  return receipt;
}

nlohmann::json fact_transition_state_json(const fact_transition &transition) {
  auto result = fact_document_json(transition);
  result["transition_root"] = transition.transition_root;
  result["revision"] = transition.revision;
  return result;
}

nlohmann::json fact_ref_json(const fact_ref &ref) {
  return {{"ref_name", ref.ref_name},
          {"cut_root", ref.cut_root},
          {"revision", ref.revision},
          {"transition_id", ref.transition_id},
          {"transition_root", ref.transition_root}};
}

nlohmann::json fact_refs_json(const std::map<std::string, fact_ref> &refs) {
  auto result = nlohmann::json::object();
  for (const auto &[name, ref] : refs) {
    result[name] = fact_ref_json(ref);
  }
  return result;
}

root_mapping parse_root_mapping(const nlohmann::json &document) {
  require_exact_fields(
      document, {"schema", "legacyRoot", "legacyProtocol", "successorRoot", "successorProtocol", "admissionRoot"},
      "kungfu.fact.root-mapping-receipt/v1");
  if (required_string(document, "schema") != "kungfu.fact.root-mapping-receipt/v1") {
    throw std::runtime_error("Fact root mapping receipt schema is unsupported");
  }
  return {required_string(document, "legacyRoot"), required_string(document, "legacyProtocol"),
          required_string(document, "successorRoot"), required_string(document, "successorProtocol"),
          required_string(document, "admissionRoot")};
}

nlohmann::json root_mapping_json(const root_mapping &mapping) {
  return {{"schema", "kungfu.fact.root-mapping-receipt/v1"}, {"legacyRoot", mapping.legacy_root},
          {"legacyProtocol", mapping.legacy_protocol},       {"successorRoot", mapping.successor_root},
          {"successorProtocol", mapping.successor_protocol}, {"admissionRoot", mapping.admission_root}};
}

} // namespace kungfu::runtime::storage_service_api::fact_kernel_internal
