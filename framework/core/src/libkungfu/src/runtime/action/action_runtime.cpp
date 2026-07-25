// SPDX-License-Identifier: Apache-2.0

#include <kungfu/runtime/action/action_runtime.h>

#include <kungfu/runtime/action/action_geometry.h>
#include <kungfu/runtime/action/domain_profile.h>
#include <kungfu/runtime/action/profile_action.h>
#include <kungfu/runtime/action/work_journal.h>
#include <kungfu/sdk/generated/primitive_catalog_v2.hpp>
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
                          {"semanticOwner", entry.semantic_owner},
                          {"interface", entry.interface_name},
                          {"availability", entry.availability},
                          {"reasonCode", entry.reason_code},
                          {"mutating", entry.mutating}});
  }
  return {{"schema", "kungfu.work-lifecycle.capabilities/v1"},
          {"operationSetRoot", OPERATION_SET_ROOT},
          {"authority", "libkungfu/runtime/action"},
          {"operations", std::move(operations)}};
}

nlohmann::json invalid_work_lifecycle_request(const nlohmann::json &request, const std::string &message) {
  using namespace kungfu::sdk::generated::work_lifecycle_v1;
  const auto operation_id =
      request.is_object() && request.contains("operationId") && request.at("operationId").is_string()
          ? nlohmann::json(request.at("operationId"))
          : nlohmann::json(nullptr);
  return {{"schema", "kungfu.work-lifecycle.routing-receipt/v1"},
          {"operationId", operation_id},
          {"operationSetRoot", OPERATION_SET_ROOT},
          {"status", "invalid-request"},
          {"reasonCode", "invalid-request"},
          {"errorClass", "invalid-request"},
          {"message", message},
          {"semanticOwner", nullptr},
          {"authorityExecuted", false},
          {"admitted", false}};
}

nlohmann::json invoke_work_lifecycle(const nlohmann::json &request) {
  using namespace kungfu::sdk::generated::work_lifecycle_v1;
  if (!request.is_object() || !request.contains("operationId") || !request.at("operationId").is_string()) {
    return invalid_work_lifecycle_request(request, "operationId must be a string");
  }
  const auto operation_id = request.at("operationId").get<std::string>();
  if (!request.contains("input") || !request.at("input").is_object()) {
    return invalid_work_lifecycle_request(request, "input must be an object");
  }
  const auto input = request.at("input");
  if (!request.contains("execute") || !request.at("execute").is_boolean()) {
    return invalid_work_lifecycle_request(request, "execute must be a boolean");
  }
  const bool execute = request.at("execute").get<bool>();
  const auto found =
      std::find_if(OPERATIONS.begin(), OPERATIONS.end(), [&](const auto &entry) { return operation_id == entry.id; });
  if (found == OPERATIONS.end()) {
    return {{"schema", "kungfu.work-lifecycle.routing-receipt/v1"},
            {"operationId", operation_id},
            {"operationSetRoot", OPERATION_SET_ROOT},
            {"status", "unsupported"},
            {"reasonCode", "unsupported-operation"},
            {"semanticOwner", nullptr},
            {"authorityExecuted", false},
            {"admitted", false}};
  }
  nlohmann::json receipt = {{"schema", "kungfu.work-lifecycle.routing-receipt/v1"},
                            {"operationId", found->id},
                            {"operationSetRoot", OPERATION_SET_ROOT},
                            {"authority", found->authority},
                            {"semanticOwner", found->semantic_owner},
                            {"interface", found->interface_name},
                            {"availability", found->availability},
                            {"mutating", found->mutating},
                            {"authorityExecuted", false},
                            {"admitted", false}};
  if (std::string(found->availability) != "available") {
    receipt["status"] = found->availability;
    receipt["reasonCode"] = found->reason_code;
    return receipt;
  }
  if (!execute) {
    receipt["status"] = "prepared";
    receipt["reasonCode"] = "ok";
    return receipt;
  }
  if (found->mutating) {
    if (!input.contains("authorityReceipt") || !input.at("authorityReceipt").is_object()) {
      receipt["status"] = "denied";
      receipt["errorClass"] = "missing-authority";
      receipt["reasonCode"] = "missing-authority";
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
      receipt["errorClass"] = "missing-authority";
      receipt["reasonCode"] = "missing-authority";
      receipt["message"] = "delegated mutation requires an exact authority receipt";
      return receipt;
    }
    if (authority_receipt.at("operationId").get<std::string>() != found->id ||
        authority_receipt.at("authority").get<std::string>() != found->authority) {
      receipt["status"] = "denied";
      receipt["errorClass"] = "authority-mismatch";
      receipt["reasonCode"] = "authority-mismatch";
      receipt["message"] = "authority receipt does not match lifecycle operation";
      return receipt;
    }
    receipt["authorityReceipt"] = authority_receipt;
    receipt["status"] = "projected";
    receipt["reasonCode"] = "bypass-not-admitted";
    receipt["message"] = "routing cannot admit an unverified delegated authority receipt";
    return receipt;
  }
  receipt["status"] = "projected";
  receipt["reasonCode"] = "native-authority-not-executed";
  return receipt;
}

nlohmann::json primitive_catalog() {
  using namespace kungfu::sdk::generated::primitive_catalog_v2;
  auto catalog = nlohmann::json::parse(CATALOG_JSON.begin(), CATALOG_JSON.end());
  if (catalog.at("catalogRoot").get<std::string>() != std::string(CATALOG_ROOT)) {
    throw std::runtime_error("generated primitive catalog Root mismatch");
  }
  catalog["runtimeAuthority"] = "libkungfu/runtime/action";
  return catalog;
}

nlohmann::json unknown_primitive_availability(const nlohmann::json &catalog, const std::string &primitive_id,
                                              const std::string &reason) {
  return {{"schema", "kungfu.primitive-availability-report/v1"},
          {"catalogRoot", catalog.at("catalogRoot")},
          {"primitiveId", primitive_id},
          {"state", "unknown"},
          {"reasonCodes", nlohmann::json::array({reason})},
          {"binding", nullptr},
          {"health", nullptr},
          {"evidenceRoots", nlohmann::json::array()},
          {"perspectiveBound", true},
          {"nonMonotonic", true}};
}

bool primitive_root(const std::string &value) {
  return value.size() == 71 && value.starts_with("sha256:") &&
         std::all_of(value.begin() + 7, value.end(), [](const auto character) {
           return (character >= '0' && character <= '9') || (character >= 'a' && character <= 'f');
         });
}

nlohmann::json sorted_primitive_roots(const nlohmann::json &values) {
  std::vector<std::string> roots;
  for (const auto &value : values) {
    if (!value.is_string() || !primitive_root(value.get<std::string>()))
      throw std::invalid_argument("Primitive availability evidence Root is invalid");
    roots.push_back(value.get<std::string>());
  }
  std::sort(roots.begin(), roots.end());
  roots.erase(std::unique(roots.begin(), roots.end()), roots.end());
  return roots;
}

nlohmann::json primitive_availability(const nlohmann::json &request) {
  const auto catalog = primitive_catalog();
  const auto primitive_id = require_string(request, "primitive_id");
  const auto &primitives = catalog.at("primitives");
  const auto declared = std::any_of(primitives.begin(), primitives.end(),
                                    [&](const auto &row) { return row.value("id", "") == primitive_id; });
  if (!declared) {
    throw std::invalid_argument("unknown Primitive id: " + primitive_id);
  }
  if (!request.contains("observation")) {
    return unknown_primitive_availability(catalog, primitive_id, "observation-missing");
  }
  const auto &observation = request.at("observation");
  if (!observation.is_object() || observation.value("schema", "") != "kungfu.availability-observation/v1") {
    throw std::invalid_argument("unsupported Primitive availability observation");
  }
  if (observation.value("catalogRoot", "") != catalog.at("catalogRoot").get<std::string>()) {
    return unknown_primitive_availability(catalog, primitive_id, "observation-stale");
  }
  if (observation.value("primitiveId", "") != primitive_id) {
    return unknown_primitive_availability(catalog, primitive_id, "binding-mismatch");
  }
  if (!observation.contains("runtime") || !observation.at("runtime").is_object() ||
      !observation.contains("profileRoots") || !observation.at("profileRoots").is_array() ||
      !observation.contains("boundary") || !observation.at("boundary").is_object() || !observation.contains("cut") ||
      !observation.at("cut").is_object() || !observation.contains("health") || !observation.at("health").is_object()) {
    return unknown_primitive_availability(catalog, primitive_id, "binding-mismatch");
  }
  const auto &runtime = observation.at("runtime");
  const auto &boundary = observation.at("boundary");
  const auto &cut = observation.at("cut");
  const auto &health = observation.at("health");
  if (runtime.value("id", "").empty() || runtime.value("workspace", "").empty() ||
      runtime.value("platform", "").empty() || !boundary.contains("authorityPresent") ||
      !boundary.at("authorityPresent").is_boolean() || !boundary.contains("capabilityPresent") ||
      !boundary.at("capabilityPresent").is_boolean() || !boundary.contains("storageOwnerAvailable") ||
      !boundary.at("storageOwnerAvailable").is_boolean() || !primitive_root(cut.value("root", "")) ||
      cut.value("observedAt", "").empty() || !health.contains("evidenceRoots") ||
      !health.at("evidenceRoots").is_array()) {
    return unknown_primitive_availability(catalog, primitive_id, "binding-mismatch");
  }
  try {
    sorted_primitive_roots(observation.at("profileRoots"));
    sorted_primitive_roots(health.at("evidenceRoots"));
  } catch (const std::invalid_argument &) {
    return unknown_primitive_availability(catalog, primitive_id, "binding-mismatch");
  }
  const auto health_status = health.value("status", "");
  if (health_status != "healthy" && health_status != "degraded" && health_status != "down") {
    return unknown_primitive_availability(catalog, primitive_id, "binding-mismatch");
  }
  auto reasons = nlohmann::json::array();
  if (!boundary.at("authorityPresent").get<bool>())
    reasons.push_back("authority-missing");
  if (!boundary.at("capabilityPresent").get<bool>())
    reasons.push_back("capability-missing");
  if (!boundary.at("storageOwnerAvailable").get<bool>())
    reasons.push_back("storage-owner-unavailable");
  if (health_status == "down" && reasons.empty())
    reasons.push_back("health-degraded");
  std::string state;
  if (!reasons.empty()) {
    state = "unavailable";
  } else if (health_status == "degraded") {
    state = "degraded";
    reasons.push_back("health-degraded");
  } else {
    state = "available";
    reasons.push_back("healthy");
  }
  return {
      {"schema", "kungfu.primitive-availability-report/v1"},
      {"catalogRoot", catalog.at("catalogRoot")},
      {"primitiveId", primitive_id},
      {"state", state},
      {"reasonCodes", reasons},
      {"binding",
       {{"runtime", runtime}, {"profileRoots", observation.at("profileRoots")}, {"boundary", boundary}, {"cut", cut}}},
      {"health", health_status},
      {"evidenceRoots", sorted_primitive_roots(health.at("evidenceRoots"))},
      {"perspectiveBound", true},
      {"nonMonotonic", true}};
}

} // namespace

nlohmann::json action_runtime_capabilities() {
  return {
      {"schema", ACTION_RUNTIME_EDGE_SCHEMA_V1},
      {"owner", "libkungfu/runtime/action"},
      {"operation", "action_runtime"},
      {"actions", nlohmann::json::array({"capabilities", "apply_action", "inspect", "session_compressibility",
                                         "session_valid_actions", "expand_session", "project_session", "evaluate",
                                         "evaluate_session_refinement", "geometry_root", "roots", "role_schema_id",
                                         "role_bindings", "validate_role_body", "work_journal", "work_lifecycle",
                                         "primitive_catalog", "primitive_availability"})},
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
  if (action == "work_journal") {
    return run_work_journal_operation(runtime_dir, request);
  }
  if (action == "primitive_catalog") {
    return primitive_catalog();
  }
  if (action == "primitive_availability") {
    return primitive_availability(request);
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
