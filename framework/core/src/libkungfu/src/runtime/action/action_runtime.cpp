// SPDX-License-Identifier: Apache-2.0

#include <kungfu/runtime/action/action_runtime.h>

#include <kungfu/runtime/action/action_geometry.h>
#include <kungfu/runtime/action/domain_profile.h>
#include <kungfu/runtime/action/profile_action.h>

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

} // namespace

nlohmann::json action_runtime_capabilities() {
  return {
      {"schema", ACTION_RUNTIME_EDGE_SCHEMA_V1},
      {"owner", "libkungfu/runtime/action"},
      {"operation", "action_runtime"},
      {"actions", nlohmann::json::array({"capabilities", "apply_action", "inspect", "session_compressibility",
                                         "session_valid_actions", "expand_session", "project_session", "evaluate",
                                         "evaluate_session_refinement", "geometry_root", "roots", "role_schema_id",
                                         "role_bindings", "validate_role_body"})},
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
