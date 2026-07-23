// SPDX-License-Identifier: Apache-2.0

#include <kungfu/runtime/action/action_canonical_json.h>
#include <kungfu/runtime/action/action_runtime.h>
#include <kungfu/runtime/storage/json_edge.h>

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

} // namespace

int main() {
  try {
    check_edge_discovery();
    check_capabilities_via_edge();
    check_evaluate_via_edge();
    check_unknown_action();
    std::cout << "kungfu_action_runtime_tests: OK" << std::endl;
    return 0;
  } catch (const std::exception &error) {
    std::cerr << "kungfu_action_runtime_tests: FAIL: " << error.what() << std::endl;
    return 1;
  }
}
