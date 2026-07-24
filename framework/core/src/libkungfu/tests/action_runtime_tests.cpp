// SPDX-License-Identifier: Apache-2.0

#include <kungfu/runtime/action/action_canonical_json.h>
#include <kungfu/runtime/action/action_runtime.h>
#include <kungfu/runtime/storage/json_edge.h>
#include <kungfu/sdk/generated/primitive_catalog_v1.hpp>

#include <algorithm>
#include <iostream>
#include <stdexcept>
#include <string>
#include <vector>

#include <nlohmann/json.hpp>

namespace action = kungfu::runtime::action;
namespace storage = kungfu::runtime::storage_service_api;
using nlohmann::json;

namespace {

const std::string kRepoRoot = KUNGFU_REPO_ROOT;

void require(bool condition, const std::string &message) {
  if (!condition) {
    throw std::runtime_error(message);
  }
}

void check_edge_discovery() {
  const auto caps = action::action_runtime_capabilities();
  require(caps.at("operation").get<std::string>() == "action_runtime", "operation name");
  require(caps.at("actions").is_array() && !caps.at("actions").empty(), "actions list");

  const auto names = storage::storage_operation_names();
  require(std::find(names.begin(), names.end(), "action_runtime") != names.end(),
          "action_runtime missing from storage_operation_names");
  require(storage::parse_storage_operation("action_runtime") == storage::storage_operation::ActionRuntime,
          "parse_storage_operation");
  require(storage::storage_operation_name(storage::storage_operation::ActionRuntime) == "action_runtime",
          "storage_operation_name");
}

void check_capabilities_via_edge() {
  const auto direct =
      action::run_action_runtime_operation("/runtime", json{{"action", "capabilities"}, {"search_base", kRepoRoot}});
  const auto via_storage = storage::run_storage_service_operation(
      "action_runtime", "/runtime", json{{"action", "capabilities"}, {"search_base", kRepoRoot}});
  require(action::action_canonical_json(direct) == action::action_canonical_json(via_storage),
          "capabilities edge vs storage mismatch");
  require(direct.at("schema").get<std::string>() == "kungfu.kfd7.profile-capabilities/v1", "capabilities schema");
}

void check_evaluate_via_edge() {
  json ids = {{"fact", "fact:00000000000000000000000000000001"},
              {"episode", "fact:00000000000000000000000000000002"},
              {"pursuit", "fact:00000000000000000000000000000003"},
              {"atlas", "fact:00000000000000000000000000000004"},
              {"warrant", "fact:00000000000000000000000000000005"}};
  const auto result = action::run_action_runtime_operation("/runtime", json{{"action", "evaluate"},
                                                                            {"responsibility_ids", ids},
                                                                            {"inference_claims", json::array()},
                                                                            {"search_base", kRepoRoot}});
  require(result.at("admissible").get<bool>(), "evaluate should be admissible");
}

void check_unknown_action() {
  bool threw = false;
  try {
    action::run_action_runtime_operation("/runtime", json{{"action", "not-a-real-action"}});
  } catch (const std::invalid_argument &) {
    threw = true;
  }
  require(threw, "unknown action must throw");
}

void check_work_lifecycle_contract() {
  const auto capabilities =
      action::run_action_runtime_operation("/runtime", json{{"action", "work_lifecycle"}, {"mode", "capabilities"}});
  require(capabilities.at("schema") == "kungfu.work-lifecycle.capabilities/v1", "lifecycle capabilities schema");
  require(capabilities.at("operations").size() == 41, "lifecycle operation count");
  require(capabilities.at("operationSetRoot").get<std::string>().rfind("sha256:", 0) == 0,
          "lifecycle operation-set root");

  const auto prepared =
      action::run_action_runtime_operation("/runtime", json{{"action", "work_lifecycle"},
                                                            {"mode", "invoke"},
                                                            {"operationId", "work.lifecycle.cut.settle/v1"},
                                                            {"input", json::object()},
                                                            {"execute", false}});
  require(prepared.at("status") == "prepared" && !prepared.at("admitted").get<bool>(),
          "dry-run must not admit mutation");

  const auto missing_receipt =
      action::run_action_runtime_operation("/runtime", json{{"action", "work_lifecycle"},
                                                            {"mode", "invoke"},
                                                            {"operationId", "work.lifecycle.cut.settle/v1"},
                                                            {"input", json::object()},
                                                            {"execute", true}});
  require(missing_receipt.at("status") == "denied" && missing_receipt.at("errorClass") == "missing-authority" &&
              !missing_receipt.at("admitted").get<bool>() && !missing_receipt.at("authorityExecuted").get<bool>(),
          "receipt-free delegated mutation must return a structured denial");

  const auto admitted = action::run_action_runtime_operation(
      "/runtime",
      json{{"action", "work_lifecycle"},
           {"mode", "invoke"},
           {"operationId", "work.lifecycle.cut.settle/v1"},
           {"input",
            {{"authorityReceipt",
              {{"schema", "kungfu.cut.receipt/v1"},
               {"operationId", "work.lifecycle.cut.settle/v1"},
               {"authority", "domain-profile-cut-authority"},
               {"receiptRoot", "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}}}}},
           {"execute", true}});
  require(admitted.at("status") == "authority-receipt-admitted" && admitted.at("admitted").get<bool>() &&
              !admitted.at("authorityExecuted").get<bool>(),
          "native waist may admit an exact authority receipt without claiming authority execution");

  const auto mismatched_receipt = action::run_action_runtime_operation(
      "/runtime",
      json{{"action", "work_lifecycle"},
           {"mode", "invoke"},
           {"operationId", "work.lifecycle.cut.settle/v1"},
           {"input",
            {{"authorityReceipt",
              {{"schema", "kungfu.cut.receipt/v1"},
               {"operationId", "work.lifecycle.cut.create/v1"},
               {"authority", "domain-profile-cut-authority"},
               {"receiptRoot", "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}}}}},
           {"execute", true}});
  require(mismatched_receipt.at("status") == "denied" && mismatched_receipt.at("errorClass") == "authority-mismatch" &&
              !mismatched_receipt.at("admitted").get<bool>() && !mismatched_receipt.at("authorityExecuted").get<bool>(),
          "authority receipt must remain bound to the requested lifecycle operation");
}

void check_primitive_catalog_contract() {
  const auto catalog = action::run_action_runtime_operation("/runtime", json{{"action", "primitive_catalog"}});
  require(catalog.at("schema") == "kungfu.primitive-catalog/v1", "primitive catalog schema");
  require(catalog.at("primitives").size() == 9, "primitive catalog inventory count");
  require(catalog.at("catalogRoot") == kungfu::sdk::generated::primitive_catalog_v1::CATALOG_ROOT,
          "runtime and generated primitive catalog Roots must agree");
  require(catalog.at("facetRoots").size() == 6, "primitive catalog facet count");
}

} // namespace

int main() {
  try {
    check_edge_discovery();
    check_capabilities_via_edge();
    check_evaluate_via_edge();
    check_work_lifecycle_contract();
    check_primitive_catalog_contract();
    check_unknown_action();
    std::cout << "kungfu_action_runtime_tests: OK" << std::endl;
    return 0;
  } catch (const std::exception &error) {
    std::cerr << "kungfu_action_runtime_tests: FAIL: " << error.what() << std::endl;
    return 1;
  }
}
