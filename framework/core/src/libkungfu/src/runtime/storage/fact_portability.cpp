// SPDX-License-Identifier: Apache-2.0

#include "fact_kernel_internal.h"

#include <algorithm>
#include <filesystem>
#include <limits>
#include <random>
#include <stdexcept>

#include <kungfu/runtime/storage/fact_kernel.h>
#include <kungfu/runtime/storage/json_edge.h>
#include <kungfu/yijinjing/schema/types.h>

namespace kungfu::runtime::storage_service_api::fact_kernel_internal {

namespace fs = std::filesystem;
using namespace kungfu::yijinjing::types;

nlohmann::json object_version_requests(const nlohmann::json &members) {
  auto result = nlohmann::json::array();
  for (const auto &member : members) {
    if (!member.is_array() || member.size() != 2) {
      throw std::runtime_error("fact authority bundle contains a malformed Cut member");
    }
    result.push_back({{"object_id", member.at(0)}, {"version_root", member.at(1)}});
  }
  return result;
}

nlohmann::json episode_frontier_requests(const nlohmann::json &frontier) {
  auto result = nlohmann::json::array();
  for (const auto &entry : frontier) {
    if (!entry.is_array() || entry.size() != 3) {
      throw std::runtime_error("fact authority bundle contains a malformed Episode frontier");
    }
    result.push_back({{"episode_id", entry.at(0)},
                      {"sealed_content_root", entry.at(1)},
                      {"accepted_manifest_frame_uid", entry.at(2)}});
  }
  return result;
}

nlohmann::json authority_operation_request(const std::string &runtime_dir, const kernel_authority_record &record) {
  const auto &document = record.document;
  if (record.tag == FactObjectRecorded::tag) {
    return {{"action", "object-put"},
            {"object_id", document.at("objectId")},
            {"object_type", document.at("objectType")},
            {"created_by_receipt_root", document.at("createdByReceiptRoot")}};
  }
  if (record.tag == FactVersionRecorded::tag) {
    return {{"action", "version-put"},
            {"object_id", document.at("objectId")},
            {"body", content_store_get(runtime_dir, BODY_NAMESPACE, document.at("bodyRoot").get<std::string>())},
            {"schema_root", document.at("schemaRoot")},
            {"parent_version_roots", document.at("parentVersionRoots")},
            {"declaration_roots", document.at("declarationRoots")},
            {"admission_roots", document.at("admissionRoots")}};
  }
  if (record.tag == FactRelationAdded::tag) {
    return {{"action", "relation-add"},
            {"relation_id", document.at("relationId")},
            {"relation_type", document.at("relationType")},
            {"source", document.at("source")},
            {"target", document.at("target")},
            {"attributes_root", document.at("attributesRoot")},
            {"admission_roots", document.at("admissionRoots")}};
  }
  if (record.tag == FactRelationRevoked::tag) {
    return {{"action", "relation-revoke"},
            {"relation_root", document.at("relationRoot")},
            {"reason_root", document.at("reasonRoot")}};
  }
  if (record.tag == FactCutCommitted::tag) {
    return {{"action", "cut-put"},
            {"parent_cut_roots", document.at("parentCutRoots")},
            {"object_versions", object_version_requests(document.at("objectVersions"))},
            {"active_relation_roots", document.at("activeRelationRoots")},
            {"declaration_roots", document.at("declarationRoots")},
            {"admission_roots", document.at("admissionRoots")},
            {"episode_frontier", episode_frontier_requests(document.at("episodeFrontier"))},
            {"omission_roots", document.at("omissionRoots")},
            {"conflict_roots", document.at("conflictRoots")}};
  }
  if (record.tag == FactRefTransition::tag) {
    const auto transition = load_metadata(runtime_dir, record.record_root, "kungfu.fact.ref-transition/v1");
    const auto expected_old = transition.at("expectedOldCutRoot").get<std::string>();
    return {{"action", "ref-cas"},
            {"transition_id", transition.at("transitionId")},
            {"ref_name", transition.at("refName")},
            {"expected_old_cut_root", expected_old.empty() ? nlohmann::json(nullptr) : nlohmann::json(expected_old)},
            {"expected_old_revision", transition.at("expectedOldRevision")},
            {"new_cut_root", transition.at("newCutRoot")},
            {"kind", transition.at("kind")},
            {"reason_root", transition.at("reasonRoot")}};
  }
  throw std::runtime_error("fact authority bundle encountered an unsupported journal record");
}

std::set<std::string> authority_record_roots(const kernel_state &state) {
  std::set<std::string> result;
  for (const auto &record : state.authority_records) {
    result.insert(record.record_root);
  }
  return result;
}

nlohmann::json authority_bundle(const std::string &runtime_dir, const kernel_state &state) {
  if (state.unknown_records != 0) {
    throw std::runtime_error("fact_authority_export_unknown_records");
  }
  if (state.authority_records.empty()) {
    throw std::runtime_error("fact_authority_export_empty");
  }
  auto operations = nlohmann::json::array();
  auto roots = nlohmann::json::array();
  for (const auto &record : state.authority_records) {
    if (!record.receipt.is_object() || record.receipt.value("recordRoot", std::string{}) != record.record_root) {
      throw std::runtime_error("fact_authority_export_receipt_mismatch");
    }
    operations.push_back({{"sequence", record.sequence},
                          {"action", record.receipt.at("operation")},
                          {"request", authority_operation_request(runtime_dir, record)},
                          {"rootProtocol", record.root_protocol},
                          {"recordRoot", record.record_root},
                          {"sourceReceiptRoot", record.receipt.at("receiptRoot")},
                          {"mappingReceiptRoot", record.mapping_receipt_root}});
    roots.push_back(record.record_root);
  }
  auto bundle = nlohmann::json{{"schema", "kungfu.fact-authority-bundle/v2"},
                               {"authority", "yijinjing-hana-pod-journal"},
                               {"rootProtocol", WRITER_ROOT_PROTOCOL},
                               {"readerProtocols", {LEGACY_ROOT_PROTOCOL, PORTABLE_ROOT_PROTOCOL}},
                               {"operations", std::move(operations)},
                               {"recordRoots", std::move(roots)},
                               {"finalState",
                                {{"refs", state.refs},
                                 {"counts",
                                  {{"objects", state.objects.size()},
                                   {"versions", state.versions.size()},
                                   {"relations", state.relations.size()},
                                   {"revocations", state.revocations.size()},
                                   {"cuts", state.cuts.size()},
                                   {"transitions", state.transitions.size()}}}}}};
  bundle["bundleRoot"] = content_root(canonical_json(bundle));
  return bundle;
}

nlohmann::json export_authority(const std::string &runtime_dir) {
  try {
    const auto bundle = authority_bundle(runtime_dir, fold_kernel(runtime_dir));
    return {{"schema", FACT_KERNEL_SCHEMA_V1},
            {"ok", true},
            {"action", "authority-export"},
            {"status", "exported"},
            {"write_occurred", false},
            {"result", {{"bundle", bundle}, {"bundle_root", bundle.at("bundleRoot")}}},
            {"receipt", nullptr}};
  } catch (const std::exception &error) {
    return failure("authority-export", "backend-failure", error.what());
  }
}

nlohmann::json import_authority(const std::string &runtime_dir, const nlohmann::json &input) {
  const std::string action = "authority-import";
  try {
    if (!input.contains("bundle") || !input.at("bundle").is_object()) {
      return failure(action, "bundle-invalid", "Fact authority bundle is required");
    }
    const auto &bundle = input.at("bundle");
    const auto bundle_schema = text_or(bundle, "schema");
    const auto bundle_protocol = text_or(bundle, "rootProtocol");
    if ((bundle_schema != "kungfu.fact-authority-bundle/v1" && bundle_schema != "kungfu.fact-authority-bundle/v2") ||
        text_or(bundle, "authority") != "yijinjing-hana-pod-journal" ||
        (bundle_protocol != LEGACY_ROOT_PROTOCOL && bundle_protocol != PORTABLE_ROOT_PROTOCOL)) {
      return failure(action, "bundle-invalid", "Fact authority bundle contract is unsupported");
    }
    const auto declared_bundle_root = required_text(bundle, "bundleRoot");
    validate_root(declared_bundle_root, "bundleRoot");
    auto root_material = bundle;
    root_material.erase("bundleRoot");
    const auto computed_bundle_root = content_root(canonical_json(root_material));
    if (computed_bundle_root != declared_bundle_root) {
      return failure(action, "bundle-root-mismatch", "Fact authority bundle root does not match its content",
                     {{"declared", declared_bundle_root}, {"computed", computed_bundle_root}});
    }
    auto operations = array_or_empty(bundle, "operations");
    const auto record_roots = array_or_empty(bundle, "recordRoots");
    if (operations.empty() || operations.size() != record_roots.size()) {
      return failure(action, "bundle-invalid",
                     "Fact authority bundle operations and roots must be non-empty and aligned");
    }
    std::set<std::string> expected_roots;
    for (size_t index = 0; index < operations.size(); ++index) {
      const auto &operation = operations.at(index);
      if (!operation.is_object() || !operation.contains("request") || !operation.at("request").is_object()) {
        return failure(action, "bundle-invalid", "Fact authority bundle operation request is missing",
                       {{"index", index}});
      }
      const auto operation_action = required_text(operation, "action");
      const auto request_action = text_or(operation.at("request"), "action");
      const auto record_root = required_text(operation, "recordRoot");
      const auto source_receipt_root = required_text(operation, "sourceReceiptRoot");
      const auto root_protocol = operation.value("rootProtocol", bundle_protocol);
      validate_root(record_root, "recordRoot");
      validate_root(source_receipt_root, "sourceReceiptRoot");
      if (operation_action != request_action || record_roots.at(index) != record_root ||
          operation_action == "authority-import" || operation_action == "authority-export" ||
          operation_action == "query" || operation_action == "capabilities" ||
          (root_protocol != LEGACY_ROOT_PROTOCOL && root_protocol != PORTABLE_ROOT_PROTOCOL) ||
          !expected_roots.insert(record_root).second) {
        return failure(action, "bundle-invalid", "Fact authority bundle operation is inconsistent",
                       {{"index", index}, {"operation", operation_action}});
      }
      operations[index]["rootProtocol"] = root_protocol;
    }
    auto before = fold_kernel(runtime_dir);
    if (before.unknown_records != 0) {
      return failure(action, "destination-diverged", "Destination Fact journal contains unknown records",
                     {{"unknown_records", before.unknown_records}});
    }
    auto current_roots = authority_record_roots(before);
    if (!std::includes(expected_roots.begin(), expected_roots.end(), current_roots.begin(), current_roots.end())) {
      return failure(action, "destination-diverged", "Destination Fact authority is not a subset of the bundle");
    }

    // A valid bundle root authenticates only the supplied bytes. Replay the
    // complete bundle in an isolated runtime so a later invalid request can
    // never reject after earlier immutable destination records have landed.
    const auto preflight_root =
        fs::temp_directory_path() / ("kungfu-fact-authority-import-" + std::to_string(std::random_device{}()) + "-" +
                                     std::to_string(std::random_device{}()));
    nlohmann::json preflight_failure = nullptr;
    try {
      for (size_t index = 0; index < operations.size(); ++index) {
        const auto &operation = operations.at(index);
        const auto operation_action = operation.at("action").get<std::string>();
        const auto expected_root = operation.at("recordRoot").get<std::string>();
        const auto root_protocol = operation.value("rootProtocol", bundle_protocol);
        const auto response =
            execute_mutation_with_protocol(preflight_root.string(), operation.at("request"), root_protocol);
        const auto actual_root = response_record_root(operation_action, response);
        if (!response.value("ok", false) || actual_root != expected_root) {
          preflight_failure = failure(action, "import-preflight-operation-mismatch",
                                      "Fact authority bundle failed isolated replay before destination mutation",
                                      {{"index", index},
                                       {"operation", operation_action},
                                       {"expected_record_root", expected_root},
                                       {"actual_record_root", actual_root},
                                       {"kernel_response", response}});
          break;
        }
      }
      if (preflight_failure.is_null()) {
        const auto preflight_state = fold_kernel(preflight_root.string());
        const auto preflight_roots = authority_record_roots(preflight_state);
        const auto final_state = bundle.value("finalState", nlohmann::json::object());
        const auto expected_counts = final_state.value("counts", nlohmann::json::object());
        const auto actual_counts = nlohmann::json{
            {"objects", preflight_state.objects.size()},     {"versions", preflight_state.versions.size()},
            {"relations", preflight_state.relations.size()}, {"revocations", preflight_state.revocations.size()},
            {"cuts", preflight_state.cuts.size()},           {"transitions", preflight_state.transitions.size()}};
        if (preflight_roots != expected_roots ||
            nlohmann::json(preflight_state.refs) != final_state.value("refs", nlohmann::json::object()) ||
            actual_counts != expected_counts) {
          preflight_failure =
              failure(action, "import-preflight-final-state-mismatch",
                      "Fact authority bundle isolated replay did not reproduce its declared final state",
                      {{"expected_refs", final_state.value("refs", nlohmann::json::object())},
                       {"actual_refs", preflight_state.refs},
                       {"expected_counts", expected_counts},
                       {"actual_counts", actual_counts}});
        }
      }
      std::error_code cleanup_error;
      fs::remove_all(preflight_root, cleanup_error);
      if (cleanup_error) {
        throw std::runtime_error("fact authority import preflight cleanup failed");
      }
    } catch (...) {
      std::error_code cleanup_error;
      fs::remove_all(preflight_root, cleanup_error);
      throw;
    }
    if (!preflight_failure.is_null()) {
      return preflight_failure;
    }
    if (!input.value("execute", false)) {
      return {{"schema", FACT_KERNEL_SCHEMA_V1},
              {"ok", true},
              {"action", action},
              {"status", "planned"},
              {"write_occurred", false},
              {"result",
               {{"bundle_root", declared_bundle_root},
                {"operation_count", operations.size()},
                {"already_present", current_roots.size()},
                {"remaining", expected_roots.size() - current_roots.size()}}},
              {"receipt", nullptr}};
    }

    auto batch_options = mutation_batch_options{};
    batch_options.bundle_root = declared_bundle_root;
    if (input.contains("qualification_fault")) {
      const auto &fault = input.at("qualification_fault");
      if (!fault.is_object() || fault.size() != 2 ||
          text_or(fault, "schema") != "kungfu.fact-authority-import-fault/v1" ||
          !fault.contains("fail_after_logical_appends") ||
          !is_nonnegative_integer(fault.at("fail_after_logical_appends"))) {
        return failure(action, "invalid-field",
                       "qualification_fault must be the exact deterministic import fault contract");
      }
      const auto requested = fault.at("fail_after_logical_appends").get<uint64_t>();
      if (requested > std::numeric_limits<size_t>::max()) {
        return failure(action, "invalid-field", "qualification import fault cut point exceeds size_t");
      }
      batch_options.inject_import_failure = true;
      batch_options.fail_after_logical_appends = static_cast<size_t>(requested);
    }

    auto pending_operations = nlohmann::json::array();
    for (size_t index = 0; index < operations.size(); ++index) {
      const auto record_root = operations.at(index).at("recordRoot").get<std::string>();
      if (current_roots.count(record_root) == 0) {
        pending_operations.push_back(operations.at(index));
      }
    }
    if (batch_options.inject_import_failure && batch_options.fail_after_logical_appends >= pending_operations.size()) {
      return failure(action, "invalid-field",
                     "qualification import fault cut point must precede a pending logical append",
                     {{"pending_operation_count", pending_operations.size()},
                      {"fail_after_logical_appends", batch_options.fail_after_logical_appends}});
    }
    const auto batch = execute_mutation_batch(runtime_dir, pending_operations, current_roots, batch_options);
    if (!batch.value("ok", false)) {
      return batch;
    }
    const auto responses = batch.at("responses");
    const auto write_occurred = batch.value("write_occurred", false);
    auto mappings = nlohmann::json::array();
    size_t response_index = 0;
    for (size_t index = 0; index < operations.size(); ++index) {
      const auto &operation = operations.at(index);
      const auto record_root = operation.at("recordRoot").get<std::string>();
      if (current_roots.count(record_root) != 0) {
        mappings.push_back({{"recordRoot", record_root},
                            {"sourceReceiptRoot", operation.at("sourceReceiptRoot")},
                            {"destinationReceiptRoot", nullptr},
                            {"status", "already-present"}});
        continue;
      }
      const auto operation_action = operation.at("action").get<std::string>();
      const auto &response = responses.at(response_index++);
      const auto actual_root = response_record_root(operation_action, response);
      if (!response.value("ok", false) || actual_root != record_root) {
        return {{"schema", FACT_KERNEL_SCHEMA_V1},
                {"ok", false},
                {"action", action},
                {"status", "rejected"},
                {"failure_code", "import-operation-mismatch"},
                {"message", "Fact authority import did not reproduce the declared record root"},
                {"details",
                 {{"index", index},
                  {"operation", operation_action},
                  {"expected_record_root", record_root},
                  {"actual_record_root", actual_root},
                  {"kernel_response", response}}},
                {"write_occurred", write_occurred},
                {"receipt", nullptr}};
      }
      current_roots.insert(record_root);
      mappings.push_back({{"recordRoot", record_root},
                          {"sourceReceiptRoot", operation.at("sourceReceiptRoot")},
                          {"destinationReceiptRoot", response.value("receipt_root", nlohmann::json(nullptr))},
                          {"status", response.at("status")}});
    }
    const auto final_roots = batch.at("record_roots").get<std::set<std::string>>();
    const auto final_state = bundle.value("finalState", nlohmann::json::object());
    const auto expected_counts = final_state.value("counts", nlohmann::json::object());
    const auto actual_counts = batch.at("counts");
    if (final_roots != expected_roots || batch.at("refs") != final_state.value("refs", nlohmann::json::object()) ||
        actual_counts != expected_counts) {
      return {{"schema", FACT_KERNEL_SCHEMA_V1},
              {"ok", false},
              {"action", action},
              {"status", "rejected"},
              {"failure_code", "import-final-state-mismatch"},
              {"message", "Fact authority import did not reproduce the declared final refs and record roots"},
              {"details",
               {{"expected_refs", final_state.value("refs", nlohmann::json::object())},
                {"actual_refs", batch.at("refs")},
                {"expected_counts", expected_counts},
                {"actual_counts", actual_counts}}},
              {"write_occurred", write_occurred},
              {"receipt", nullptr}};
    }
    return {{"schema", FACT_KERNEL_SCHEMA_V1},
            {"ok", true},
            {"action", action},
            {"status", "imported"},
            {"write_occurred", write_occurred},
            {"result",
             {{"bundle_root", declared_bundle_root},
              {"record_roots_preserved", true},
              {"refs_preserved", true},
              {"receipt_mappings", std::move(mappings)}}},
            {"receipt", nullptr}};
  } catch (const fact_request_error &error) {
    return failure(action, error.code(), error.what());
  } catch (const std::invalid_argument &error) {
    return failure(action, "invalid-request", error.what());
  } catch (const std::exception &error) {
    return failure(action, "backend-failure", error.what());
  }
}

} // namespace kungfu::runtime::storage_service_api::fact_kernel_internal
