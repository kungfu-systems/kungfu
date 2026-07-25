// SPDX-License-Identifier: Apache-2.0

#include <kungfu/runtime/action/action_runtime.h>

#include <kungfu/runtime/action/action_geometry.h>
#include <kungfu/runtime/action/domain_profile.h>
#include <kungfu/runtime/action/profile_action.h>
#include <kungfu/runtime/action/work_journal.h>
#include <kungfu/sdk/generated/primitive_catalog_v2.hpp>
#include <kungfu/sdk/generated/work_lifecycle_v1.hpp>

#include <algorithm>
#include <array>
#include <cstdint>
#include <stdexcept>
#include <string>
#include <string_view>

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

nlohmann::json invoke_work_lifecycle(const std::string &runtime_dir, const nlohmann::json &request) {
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
  if (std::string(found->authority) == "native-work-journal") {
    nlohmann::json native_receipt;
    try {
      native_receipt = run_work_lifecycle_operation(runtime_dir, operation_id, input, execute);
    } catch (const std::invalid_argument &error) {
      return invalid_work_lifecycle_request(request, error.what());
    }
    native_receipt["operationSetRoot"] = OPERATION_SET_ROOT;
    native_receipt["semanticOwner"] = found->semantic_owner;
    native_receipt["interface"] = found->interface_name;
    native_receipt["availability"] = found->availability;
    native_receipt["mutating"] = found->mutating;
    return native_receipt;
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

using action_handler = nlohmann::json (*)(const std::string &, const nlohmann::json &, const std::string &);

enum class action_capability : std::uint8_t {
  none = 0,
  discoverable = 1 << 0,
  composite = 1 << 1,
};

constexpr action_capability operator|(action_capability lhs, action_capability rhs) {
  return static_cast<action_capability>(static_cast<std::uint8_t>(lhs) | static_cast<std::uint8_t>(rhs));
}

constexpr bool has_capability(action_capability value, action_capability flag) {
  return (static_cast<std::uint8_t>(value) & static_cast<std::uint8_t>(flag)) != 0;
}

struct action_descriptor {
  std::string_view name;
  action_handler handler;
  std::string_view request_schema;
  std::string_view response_schema;
  action_capability capabilities;
};

nlohmann::json handle_edge_capabilities(const std::string &, const nlohmann::json &, const std::string &) {
  return action_runtime_capabilities();
}

nlohmann::json handle_capabilities(const std::string &, const nlohmann::json &, const std::string &search_base) {
  return profile_action_capabilities(search_base);
}

nlohmann::json handle_apply_action(const std::string &runtime_dir, const nlohmann::json &request,
                                   const std::string &search_base) {
  const auto body = require_object(request, "request");
  const bool execute = bool_or(request, "execute", false);
  return apply_profile_action(runtime_dir, body, execute, {}, search_base);
}

nlohmann::json handle_inspect(const std::string &runtime_dir, const nlohmann::json &request,
                              const std::string &search_base) {
  return inspect_profile_action(runtime_dir, require_string(request, "ref_name"), {}, search_base);
}

nlohmann::json handle_session_compressibility(const std::string &, const nlohmann::json &request, const std::string &) {
  return session_compressibility(require_object(request, "session"));
}

nlohmann::json handle_session_valid_actions(const std::string &, const nlohmann::json &request, const std::string &) {
  return session_valid_actions(require_object(request, "session"));
}

nlohmann::json handle_expand_session(const std::string &, const nlohmann::json &request, const std::string &) {
  return expand_session(require_object(request, "session"));
}

nlohmann::json handle_project_session(const std::string &, const nlohmann::json &request,
                                      const std::string &search_base) {
  return project_session(require_object(request, "expansion"), search_base);
}

nlohmann::json handle_evaluate(const std::string &, const nlohmann::json &request, const std::string &search_base) {
  return evaluate_action_geometry(object_or_empty(request, "responsibility_ids"),
                                  array_or_empty(request, "inference_claims"), search_base);
}

nlohmann::json handle_evaluate_session_refinement(const std::string &, const nlohmann::json &request,
                                                  const std::string &search_base) {
  return evaluate_session_refinement(object_or_empty(request, "before"), object_or_empty(request, "after"),
                                     search_base);
}

nlohmann::json handle_geometry_root(const std::string &, const nlohmann::json &, const std::string &search_base) {
  return nlohmann::json{{"geometryRoot", action_geometry_root(search_base)}};
}

nlohmann::json handle_work_lifecycle(const std::string &runtime_dir, const nlohmann::json &request,
                                     const std::string &) {
  const auto mode = text_or(request, "mode", "capabilities");
  if (mode == "capabilities") {
    return work_lifecycle_capabilities();
  }
  if (mode == "invoke") {
    return invoke_work_lifecycle(runtime_dir, request);
  }
  throw std::invalid_argument("unknown work_lifecycle mode: " + mode);
}

nlohmann::json handle_work_journal(const std::string &runtime_dir, const nlohmann::json &request, const std::string &) {
  return run_work_journal_operation(runtime_dir, request);
}

nlohmann::json handle_primitive_catalog(const std::string &, const nlohmann::json &, const std::string &) {
  return primitive_catalog();
}

nlohmann::json handle_primitive_availability(const std::string &, const nlohmann::json &request, const std::string &) {
  return primitive_availability(request);
}

nlohmann::json handle_roots(const std::string &, const nlohmann::json &, const std::string &search_base) {
  return domain_profile_roots(search_base);
}

nlohmann::json handle_role_schema_id(const std::string &, const nlohmann::json &request,
                                     const std::string &search_base) {
  return nlohmann::json{{"schema", role_schema_id(require_string(request, "role"), search_base)}};
}

nlohmann::json handle_role_bindings(const std::string &, const nlohmann::json &request,
                                    const std::string &search_base) {
  return role_bindings(require_string(request, "role"), search_base);
}

nlohmann::json handle_validate_role_body(const std::string &, const nlohmann::json &request,
                                         const std::string &search_base) {
  return validate_role_body(require_object(request, "body"), bool_or(request, "allow_legacy", true), search_base);
}

constexpr auto ACTION_DESCRIPTORS = std::array{
    action_descriptor{"edge_capabilities", handle_edge_capabilities, "action-runtime/request",
                      ACTION_RUNTIME_EDGE_SCHEMA_V1, action_capability::none},
    action_descriptor{"capabilities", handle_capabilities, "action-runtime/request",
                      "kungfu.kfd7.profile-capabilities/v1", action_capability::discoverable},
    action_descriptor{"apply_action", handle_apply_action, "kungfu.kfd7.profile-action-request/v1",
                      "kungfu.kfd7.profile-action-result/v1", action_capability::discoverable},
    action_descriptor{"inspect", handle_inspect, "action-runtime/inspect-request", "profile-action/inspection",
                      action_capability::discoverable},
    action_descriptor{"session_compressibility", handle_session_compressibility, "profile-action/session",
                      "profile-action/session-compressibility", action_capability::discoverable},
    action_descriptor{"session_valid_actions", handle_session_valid_actions, "profile-action/session",
                      "profile-action/session-valid-actions", action_capability::discoverable},
    action_descriptor{"expand_session", handle_expand_session, "profile-action/session", "profile-action/expansion",
                      action_capability::discoverable},
    action_descriptor{"project_session", handle_project_session, "profile-action/expansion",
                      "profile-action/projection", action_capability::discoverable},
    action_descriptor{"evaluate", handle_evaluate, "action-geometry/evaluation-request", "action-geometry/evaluation",
                      action_capability::discoverable},
    action_descriptor{"evaluate_session_refinement", handle_evaluate_session_refinement,
                      "action-geometry/session-refinement-request", "action-geometry/session-refinement",
                      action_capability::discoverable},
    action_descriptor{"geometry_root", handle_geometry_root, "action-runtime/request", "action-geometry/root",
                      action_capability::discoverable},
    action_descriptor{"roots", handle_roots, "action-runtime/request", "domain-profile/roots",
                      action_capability::discoverable},
    action_descriptor{"role_schema_id", handle_role_schema_id, "domain-profile/role-request",
                      "domain-profile/role-schema-id", action_capability::discoverable},
    action_descriptor{"role_bindings", handle_role_bindings, "domain-profile/role-request",
                      "domain-profile/role-bindings", action_capability::discoverable},
    action_descriptor{"validate_role_body", handle_validate_role_body, "domain-profile/role-body-request",
                      "domain-profile/role-body-validation", action_capability::discoverable},
    action_descriptor{"work_journal", handle_work_journal, "kungfu.work-journal.request/v1",
                      "kungfu.work-journal.response/v1",
                      action_capability::discoverable | action_capability::composite},
    action_descriptor{"work_lifecycle", handle_work_lifecycle, "kungfu.work-lifecycle.request/v1",
                      "kungfu.work-lifecycle.routing-receipt/v1",
                      action_capability::discoverable | action_capability::composite},
    action_descriptor{"primitive_catalog", handle_primitive_catalog, "action-runtime/request",
                      "kungfu.primitive-catalog/v2", action_capability::discoverable},
    action_descriptor{"primitive_availability", handle_primitive_availability,
                      "kungfu.primitive-availability.request/v1", "kungfu.primitive-availability-report/v1",
                      action_capability::discoverable},
};

const action_descriptor *find_action_descriptor(std::string_view name) {
  const auto found = std::find_if(ACTION_DESCRIPTORS.begin(), ACTION_DESCRIPTORS.end(),
                                  [&](const auto &descriptor) { return descriptor.name == name; });
  return found == ACTION_DESCRIPTORS.end() ? nullptr : &*found;
}

} // namespace

nlohmann::json action_runtime_capabilities() {
  auto actions = nlohmann::json::array();
  for (const auto &descriptor : ACTION_DESCRIPTORS) {
    if (has_capability(descriptor.capabilities, action_capability::discoverable)) {
      actions.push_back(descriptor.name);
    }
  }
  return {
      {"schema", ACTION_RUNTIME_EDGE_SCHEMA_V1},
      {"owner", "libkungfu/runtime/action"},
      {"operation", "action_runtime"},
      {"actions", std::move(actions)},
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
  if (const auto *descriptor = find_action_descriptor(action); descriptor != nullptr) {
    return descriptor->handler(runtime_dir, request, search_base);
  }

  throw std::invalid_argument("unknown action_runtime action: " + action);
}

} // namespace kungfu::runtime::action
