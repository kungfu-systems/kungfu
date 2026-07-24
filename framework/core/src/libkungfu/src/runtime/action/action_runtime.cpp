// SPDX-License-Identifier: Apache-2.0

#include <kungfu/runtime/action/action_runtime.h>

#include <kungfu/runtime/action/action_geometry.h>
#include <kungfu/runtime/action/domain_profile.h>
#include <kungfu/runtime/action/profile_action.h>
#include <kungfu/sdk/generated/primitive_catalog_v1.hpp>
#include <kungfu/sdk/generated/work_lifecycle_v1.hpp>

#include <algorithm>
#include <stdexcept>
#include <string>

namespace kungfu::runtime::action {

namespace {

std::string text_or(const nlohmann::json &object, const std::string &key, const std::string &fallback = {}) {
  if (object.is_object() && object.contains(key) && object.at(key).is_string()) {
    return object.at(key).get<std::string>();
  }
  return fallback;
}

bool bool_or(const nlohmann::json &object, const std::string &key, bool fallback) {
  if (object.is_object() && object.contains(key) && object.at(key).is_boolean()) {
    return object.at(key).get<bool>();
  }
  return fallback;
}

nlohmann::json object_or_empty(const nlohmann::json &object, const std::string &key) {
  if (object.is_object() && object.contains(key) && object.at(key).is_object()) {
    return object.at(key);
  }
  return nlohmann::json::object();
}

nlohmann::json array_or_empty(const nlohmann::json &object, const std::string &key) {
  if (object.is_object() && object.contains(key) && object.at(key).is_array()) {
    return object.at(key);
  }
  return nlohmann::json::array();
}

nlohmann::json require_object(const nlohmann::json &object, const std::string &key) {
  if (!object.is_object() || !object.contains(key) || !object.at(key).is_object()) {
    throw std::invalid_argument(key + " must be an object");
  }
  return object.at(key);
}

std::string require_string(const nlohmann::json &object, const std::string &key) {
  if (!object.is_object() || !object.contains(key) || !object.at(key).is_string()) {
    throw std::invalid_argument(key + " must be a string");
  }
  return object.at(key).get<std::string>();
}

bool canonical_root(const std::string &value) {
  return value.size() == 71 && value.rfind("sha256:", 0) == 0 &&
         std::all_of(value.begin() + 7, value.end(), [](const char character) {
           return (character >= '0' && character <= '9') || (character >= 'a' && character <= 'f');
         });
}

nlohmann::json work_lifecycle_capabilities() {
  using namespace kungfu::sdk::generated::work_lifecycle_v1;
  auto operations = nlohmann::json::array();
  for (const auto &entry : OPERATIONS) {
    operations.push_back({{"id", entry.id},
                          {"capability", entry.capability},
                          {"layer", entry.layer},
                          {"authority", entry.authority},
                          {"interface", entry.interface_name},
                          {"mutating", entry.mutating}});
  }
  return {{"schema", "kungfu.work-lifecycle.capabilities/v1"},
          {"operationSetRoot", OPERATION_SET_ROOT},
          {"authority", "libkungfu/runtime/action"},
          {"operations", std::move(operations)}};
}

nlohmann::json invoke_work_lifecycle(const nlohmann::json &request) {
  using namespace kungfu::sdk::generated::work_lifecycle_v1;
  const auto operation_id = require_string(request, "operationId");
  const auto found =
      std::find_if(OPERATIONS.begin(), OPERATIONS.end(), [&](const auto &entry) { return operation_id == entry.id; });
  if (found == OPERATIONS.end()) {
    throw std::invalid_argument("unknown Work lifecycle operation: " + operation_id);
  }
  const auto input = object_or_empty(request, "input");
  const bool execute = bool_or(request, "execute", false);
  nlohmann::json receipt = {{"schema", "kungfu.work-lifecycle.routing-receipt/v1"},
                            {"operationId", found->id},
                            {"operationSetRoot", OPERATION_SET_ROOT},
                            {"authority", found->authority},
                            {"interface", found->interface_name},
                            {"mutating", found->mutating}};
  if (!execute) {
    receipt["status"] = "prepared";
    receipt["admitted"] = false;
    return receipt;
  }
  if (found->mutating) {
    if (!input.contains("authorityReceipt") || !input.at("authorityReceipt").is_object()) {
      receipt["status"] = "denied";
      receipt["admitted"] = false;
      receipt["authorityExecuted"] = false;
      receipt["errorClass"] = "missing-authority";
      receipt["message"] = "delegated mutation requires an exact authority receipt";
      return receipt;
    }
    const auto &authority_receipt = input.at("authorityReceipt");
    if (!authority_receipt.contains("schema") || !authority_receipt.at("schema").is_string() ||
        !authority_receipt.contains("operationId") || !authority_receipt.at("operationId").is_string() ||
        !authority_receipt.contains("authority") || !authority_receipt.at("authority").is_string() ||
        !authority_receipt.contains("receiptRoot") || !authority_receipt.at("receiptRoot").is_string() ||
        !canonical_root(authority_receipt.at("receiptRoot").get<std::string>())) {
      receipt["status"] = "denied";
      receipt["admitted"] = false;
      receipt["authorityExecuted"] = false;
      receipt["errorClass"] = "missing-authority";
      receipt["message"] = "delegated mutation requires an exact authority receipt";
      return receipt;
    }
    if (authority_receipt.at("operationId").get<std::string>() != found->id ||
        authority_receipt.at("authority").get<std::string>() != found->authority) {
      receipt["status"] = "denied";
      receipt["admitted"] = false;
      receipt["authorityExecuted"] = false;
      receipt["errorClass"] = "authority-mismatch";
      receipt["message"] = "authority receipt does not match lifecycle operation";
      return receipt;
    }
    receipt["authorityReceipt"] = authority_receipt;
    receipt["status"] = "authority-receipt-admitted";
    receipt["admitted"] = true;
    receipt["authorityExecuted"] = false;
    return receipt;
  }
  receipt["status"] = "routed-read";
  receipt["admitted"] = false;
  return receipt;
}

nlohmann::json primitive_catalog() {
  using namespace kungfu::sdk::generated::primitive_catalog_v1;
  auto catalog = nlohmann::json::parse(CATALOG_JSON.begin(), CATALOG_JSON.end());
  if (catalog.at("catalogRoot") != CATALOG_ROOT) {
    throw std::runtime_error("generated primitive catalog Root mismatch");
  }
  catalog["runtimeAuthority"] = "libkungfu/runtime/action";
  return catalog;
}

} // namespace

nlohmann::json action_runtime_capabilities() {
  return {
      {"schema", ACTION_RUNTIME_EDGE_SCHEMA_V1},
      {"owner", "libkungfu/runtime/action"},
      {"operation", "action_runtime"},
      {"actions",
       nlohmann::json::array({"capabilities", "apply_action", "inspect", "session_compressibility",
                              "session_valid_actions", "expand_session", "project_session", "evaluate",
                              "evaluate_session_refinement", "geometry_root", "roots", "role_schema_id",
                              "role_bindings", "validate_role_body", "work_lifecycle", "primitive_catalog"})},
  };
}

nlohmann::json run_action_runtime_operation(const std::string &runtime_dir, const nlohmann::json &request) {
  if (!request.is_object()) {
    throw std::invalid_argument("action_runtime request must be an object");
  }
  if (request.contains("action") && !request.at("action").is_string()) {
    throw std::invalid_argument("action must be a string");
  }
  const auto action = text_or(request, "action", "capabilities");
  const auto search_base = text_or(request, "search_base");

  if (action == "edge_capabilities") {
    return action_runtime_capabilities();
  }
  if (action == "capabilities") {
    return profile_action_capabilities(search_base);
  }
  if (action == "apply_action") {
    // Preferred envelope: {action, request, execute?, search_base?}.
    const auto body = require_object(request, "request");
    const bool execute = bool_or(request, "execute", false);
    return apply_profile_action(runtime_dir, body, execute, {}, search_base);
  }
  if (action == "inspect") {
    return inspect_profile_action(runtime_dir, require_string(request, "ref_name"), {}, search_base);
  }
  if (action == "session_compressibility") {
    return session_compressibility(require_object(request, "session"));
  }
  if (action == "session_valid_actions") {
    return session_valid_actions(require_object(request, "session"));
  }
  if (action == "expand_session") {
    return expand_session(require_object(request, "session"));
  }
  if (action == "project_session") {
    return project_session(require_object(request, "expansion"), search_base);
  }
  if (action == "evaluate") {
    return evaluate_action_geometry(object_or_empty(request, "responsibility_ids"),
                                    array_or_empty(request, "inference_claims"), search_base);
  }
  if (action == "evaluate_session_refinement") {
    return evaluate_session_refinement(object_or_empty(request, "before"), object_or_empty(request, "after"),
                                       search_base);
  }
  if (action == "geometry_root") {
    return nlohmann::json{{"geometryRoot", action_geometry_root(search_base)}};
  }
  if (action == "work_lifecycle") {
    const auto mode = text_or(request, "mode", "capabilities");
    if (mode == "capabilities")
      return work_lifecycle_capabilities();
    if (mode == "invoke")
      return invoke_work_lifecycle(request);
    throw std::invalid_argument("unknown work_lifecycle mode: " + mode);
  }
  if (action == "primitive_catalog") {
    return primitive_catalog();
  }
  if (action == "roots") {
    return domain_profile_roots(search_base);
  }
  if (action == "role_schema_id") {
    return nlohmann::json{{"schema", role_schema_id(require_string(request, "role"), search_base)}};
  }
  if (action == "role_bindings") {
    return role_bindings(require_string(request, "role"), search_base);
  }
  if (action == "validate_role_body") {
    return validate_role_body(require_object(request, "body"), bool_or(request, "allow_legacy", true), search_base);
  }

  throw std::invalid_argument("unknown action_runtime action: " + action);
}

} // namespace kungfu::runtime::action
