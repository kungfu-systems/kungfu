// SPDX-License-Identifier: Apache-2.0

#include <kungfu/runtime/action/profile_action.h>

#include <kungfu/runtime/action/action_canonical_json.h>
#include <kungfu/runtime/action/action_contract_registry.h>
#include <kungfu/runtime/action/domain_profile.h>
#include <kungfu/runtime/storage/fact_kernel.h>

#include <algorithm>
#include <array>
#include <cstdint>
#include <map>
#include <optional>
#include <regex>
#include <set>
#include <sstream>
#include <stdexcept>
#include <string>
#include <tuple>
#include <utility>
#include <vector>

namespace kungfu::runtime::action {

namespace {

using Transition = std::tuple<std::string, std::string, std::string>;

constexpr std::array<const char *, 5> ROLES = {"fact", "episode", "pursuit", "atlas", "warrant"};

const std::map<std::string, std::string> INITIAL_STATES = {
    {"fact", "declared"}, {"episode", "open"}, {"pursuit", "active"}, {"atlas", "current"}, {"warrant", "issued"},
};

const std::map<std::string, std::set<Transition>> TRANSITIONS = {
    {"fact",
     {{"create", "absent", "declared"},
      {"successor", "declared", "superseded"},
      {"fork", "declared", "declared"},
      {"degrade", "declared", "degraded"}}},
    {"episode",
     {{"create", "absent", "open"},
      {"seal", "open", "sealed"},
      {"compensate", "sealed", "compensated"},
      {"reconcile", "sealed", "reconciled"},
      {"reconcile", "compensated", "reconciled"}}},
    {"pursuit",
     {{"create", "absent", "active"},
      {"branch", "active", "active"},
      {"continue", "active", "active"},
      {"continue", "paused", "active"},
      {"pause", "active", "paused"},
      {"complete", "active", "completed"},
      {"complete", "paused", "completed"},
      {"abandon", "active", "abandoned"},
      {"abandon", "paused", "abandoned"}}},
    {"atlas",
     {{"create", "absent", "current"},
      {"refresh", "current", "current"},
      {"refresh", "stale", "current"},
      {"refresh", "conflicted", "current"},
      {"mark-stale", "current", "stale"},
      {"mark-conflicted", "current", "conflicted"},
      {"supersede", "current", "superseded"},
      {"supersede", "stale", "superseded"}}},
    {"warrant",
     {{"create", "absent", "issued"},
      {"attenuate", "issued", "attenuated"},
      {"attenuate", "attenuated", "attenuated"},
      {"expire", "issued", "expired"},
      {"expire", "attenuated", "expired"},
      {"revoke", "issued", "revoked"},
      {"revoke", "attenuated", "revoked"},
      {"deny", "issued", "denied"},
      {"deny", "attenuated", "denied"}}},
};

constexpr std::array<const char *, 12> DENIALS = {
    "responsibility-gap", "invalid-request", "invalid-transition", "profile-state-mismatch",
    "body-missing",       "stale-ref",       "replay-mismatch",    "unauthorized",
    "warrant-expired",    "warrant-revoked", "atlas-stale",        "kernel-rejected",
};

const std::regex ROOT_PATTERN("^sha256:[0-9a-f]{64}$");
const std::regex FACT_ID_PATTERN("^fact:[0-9a-f]{32}$");
const std::regex REF_PATTERN("^[a-z][a-z0-9._/-]{0,127}$");
const std::regex ACTION_ID_PATTERN("^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$");

std::string repr_string(const std::string &value) {
  const bool has_single = value.find('\'') != std::string::npos;
  const bool has_double = value.find('"') != std::string::npos;
  const char quote = (has_single && !has_double) ? '"' : '\'';
  std::string out;
  out.push_back(quote);
  for (const char raw : value) {
    const auto uc = static_cast<unsigned char>(raw);
    if (raw == '\\') {
      out += "\\\\";
    } else if (raw == quote) {
      out.push_back('\\');
      out.push_back(quote);
    } else if (raw == '\n') {
      out += "\\n";
    } else if (raw == '\r') {
      out += "\\r";
    } else if (raw == '\t') {
      out += "\\t";
    } else if (uc < 0x20 || uc == 0x7f) {
      static const char *hex = "0123456789abcdef";
      out += "\\x";
      out.push_back(hex[(uc >> 4) & 0xf]);
      out.push_back(hex[uc & 0xf]);
    } else {
      out.push_back(raw);
    }
  }
  out.push_back(quote);
  return out;
}

std::string py_repr(const nlohmann::json &value);

std::string py_repr(const nlohmann::json &value) {
  switch (value.type()) {
  case nlohmann::json::value_t::string:
    return repr_string(value.get<std::string>());
  case nlohmann::json::value_t::boolean:
    return value.get<bool>() ? "True" : "False";
  case nlohmann::json::value_t::null:
    return "None";
  case nlohmann::json::value_t::number_integer:
    return std::to_string(value.get<std::int64_t>());
  case nlohmann::json::value_t::number_unsigned:
    return std::to_string(value.get<std::uint64_t>());
  case nlohmann::json::value_t::number_float: {
    std::ostringstream stream;
    stream << value.get<double>();
    return stream.str();
  }
  case nlohmann::json::value_t::array: {
    std::string out = "[";
    for (std::size_t i = 0; i < value.size(); ++i) {
      if (i != 0) {
        out += ", ";
      }
      out += py_repr(value.at(i));
    }
    out += "]";
    return out;
  }
  case nlohmann::json::value_t::object: {
    std::string out = "{";
    bool first = true;
    for (const auto &item : value.items()) {
      if (!first) {
        out += ", ";
      }
      first = false;
      out += py_repr(nlohmann::json(item.key()));
      out += ": ";
      out += py_repr(item.value());
    }
    out += "}";
    return out;
  }
  default:
    return "None";
  }
}

FactKernelFn resolve_kernel(FactKernelFn kernel) {
  if (kernel) {
    return kernel;
  }
  return [](const std::string &runtime_dir, const std::string &action, const nlohmann::json &request) {
    nlohmann::json payload = request.is_object() ? request : nlohmann::json::object();
    payload["action"] = action;
    return storage_service_api::run_fact_kernel_operation(runtime_dir, payload);
  };
}

bool roles_set_matches(const nlohmann::json &value) {
  if (!value.is_object()) {
    return false;
  }
  std::set<std::string> keys;
  for (const auto &item : value.items()) {
    keys.insert(item.key());
  }
  std::set<std::string> expected(ROLES.begin(), ROLES.end());
  return keys == expected;
}

nlohmann::json json_sorted_copy(const nlohmann::json &value) {
  return nlohmann::json::parse(action_canonical_json(value));
}

[[noreturn]] void throw_value_error(const std::string &message) { throw std::runtime_error(message); }

void require_root(const nlohmann::json &value, const std::string &field, bool nullable = false) {
  if (nullable && value.is_null()) {
    return;
  }
  if (!value.is_string() || !std::regex_match(value.get<std::string>(), ROOT_PATTERN)) {
    throw_value_error(field + " must be a sha256 content root");
  }
}

std::vector<std::string> require_root_list(const nlohmann::json &value, const std::string &field) {
  if (!value.is_array() || value.empty()) {
    throw_value_error(field + " must be a non-empty root array");
  }
  std::vector<std::string> roots;
  for (std::size_t index = 0; index < value.size(); ++index) {
    require_root(value.at(index), field + "[" + std::to_string(index) + "]");
    roots.push_back(value.at(index).get<std::string>());
  }
  if (roots.size() != std::set<std::string>(roots.begin(), roots.end()).size()) {
    throw_value_error(field + " must not contain duplicates");
  }
  std::sort(roots.begin(), roots.end());
  return roots;
}

nlohmann::json step_record(const std::string &action, const nlohmann::json &response) {
  nlohmann::json result;
  result["action"] = action;
  result["status"] = response.contains("status") ? response.at("status") : nlohmann::json(nullptr);
  result["ok"] = response.contains("ok") && response.at("ok").is_boolean() && response.at("ok").get<bool>();
  result["failureCode"] = response.contains("failure_code") ? response.at("failure_code") : nlohmann::json(nullptr);
  result["writeOccurred"] = response.contains("write_occurred") && response.at("write_occurred").is_boolean() &&
                            response.at("write_occurred").get<bool>();
  result["receiptRoot"] = response.contains("receipt_root") ? response.at("receipt_root") : nlohmann::json(nullptr);
  return result;
}

nlohmann::json denied_receipt(const std::string &action_id, const std::string &code, const std::string &message,
                              const nlohmann::json &details = nlohmann::json::object(),
                              const nlohmann::json &steps = nlohmann::json::array()) {
  bool write_occurred = false;
  if (steps.is_array()) {
    for (const auto &step : steps) {
      if (step.is_object() && step.contains("writeOccurred") && step.at("writeOccurred").is_boolean() &&
          step.at("writeOccurred").get<bool>()) {
        write_occurred = true;
        break;
      }
    }
  }
  nlohmann::json result;
  result["schema"] = PROFILE_ACTION_RECEIPT_V1;
  result["actionId"] = action_id;
  result["status"] = "denied";
  result["failureCode"] = code;
  result["message"] = message;
  result["details"] = details.is_object() ? details : nlohmann::json::object();
  result["writeOccurred"] = write_occurred;
  result["refWriteOccurred"] = false;
  result["steps"] = steps.is_array() ? steps : nlohmann::json::array();
  if (write_occurred) {
    result["residualRisk"] =
        nlohmann::json::array({"Immutable prerequisite records may exist even when the named ref CAS is denied."});
  } else {
    result["residualRisk"] = nlohmann::json::array();
  }
  return result;
}

nlohmann::json kernel_failure_receipt(const std::string &action_id, const nlohmann::json &response,
                                      const nlohmann::json &steps) {
  const std::string code = response.contains("failure_code") && response.at("failure_code").is_string()
                               ? response.at("failure_code").get<std::string>()
                               : "kernel-rejected";
  std::string mapped = "kernel-rejected";
  if (code == "stale-ref") {
    mapped = "stale-ref";
  } else if (code == "transition-id-reused") {
    mapped = "replay-mismatch";
  }
  const std::string message = response.contains("message") && response.at("message").is_string()
                                  ? response.at("message").get<std::string>()
                                  : "native Fact kernel rejected the action";
  nlohmann::json details = {
      {"kernelFailureCode", code},
      {"kernel", response.contains("details") ? response.at("details") : nlohmann::json::object()}};
  return denied_receipt(action_id, mapped, message, details, steps);
}

struct LoadedCut {
  nlohmann::json cut;
  std::map<std::string, nlohmann::json> roles;
  std::vector<std::string> relation_roots;
};

LoadedCut load_cut(const std::string &runtime_dir, const nlohmann::json &cut_root, const FactKernelFn &kernel) {
  if (cut_root.is_null()) {
    return {nlohmann::json(nullptr), {}, {}};
  }
  const nlohmann::json response = kernel(runtime_dir, "query", {{"cut_root", cut_root}, {"include_bodies", true}});
  if (!response.contains("ok") || !response.at("ok").is_boolean() || !response.at("ok").get<bool>()) {
    throw std::runtime_error(action_canonical_json(response));
  }

  std::map<std::string, nlohmann::json> roles;
  if (response.contains("objects") && response.at("objects").is_array()) {
    for (const auto &row : response.at("objects")) {
      if (!row.is_object()) {
        continue;
      }
      const auto body_status = row.contains("body_status") ? row.at("body_status") : nlohmann::json(nullptr);
      if (!body_status.is_string() || body_status.get<std::string>() != "present") {
        continue;
      }
      if (!row.contains("body") || !row.at("body").is_string()) {
        continue;
      }
      nlohmann::json decoded;
      try {
        decoded = nlohmann::json::parse(row.at("body").get<std::string>());
      } catch (const nlohmann::json::exception &) {
        continue;
      }
      if (!decoded.is_object() || !decoded.contains("role") || !decoded.at("role").is_string()) {
        continue;
      }
      const auto role = decoded.at("role").get<std::string>();
      if (std::find(ROLES.begin(), ROLES.end(), role) == ROLES.end()) {
        continue;
      }
      try {
        (void)validate_role_body(decoded);
      } catch (const std::runtime_error &) {
        continue;
      }
      if (!row.contains("member") || !row.at("member").is_array() || row.at("member").size() < 2) {
        continue;
      }
      roles[role] = {{"objectId", row.at("member").at(0)}, {"versionRoot", row.at("member").at(1)}, {"body", decoded}};
    }
  }

  std::vector<std::string> relation_roots;
  if (response.contains("relations") && response.at("relations").is_array()) {
    for (const auto &row : response.at("relations")) {
      if (row.is_object() && row.contains("relation_root") && row.at("relation_root").is_string()) {
        relation_roots.push_back(row.at("relation_root").get<std::string>());
      }
    }
  }

  return {response, std::move(roles), std::move(relation_roots)};
}

void validate_request(const nlohmann::json &request) {
  if (!request.is_object() || !request.contains("schema") ||
      request.at("schema").get<std::string>() != PROFILE_ACTION_SCHEMA_V1) {
    throw_value_error(std::string("schema must be ") + PROFILE_ACTION_SCHEMA_V1);
  }
  if (!request.contains("actionId") || !request.at("actionId").is_string() ||
      !std::regex_match(request.at("actionId").get<std::string>(), ACTION_ID_PATTERN)) {
    throw_value_error("actionId is not canonical");
  }
  if (!request.contains("refName") || !request.at("refName").is_string()) {
    throw_value_error("refName is not canonical");
  }
  const auto ref_name = request.at("refName").get<std::string>();
  if (!std::regex_match(ref_name, REF_PATTERN) || ref_name.find("..") != std::string::npos) {
    throw_value_error("refName is not canonical");
  }
  if (!request.contains("subject") || !request.at("subject").is_object()) {
    throw_value_error("subject.role is required");
  }
  const auto &subject = request.at("subject");
  if (!subject.contains("role") || !subject.at("role").is_string()) {
    throw_value_error("subject.role is required");
  }
  const auto role = subject.at("role").get<std::string>();
  if (std::find(ROLES.begin(), ROLES.end(), role) == ROLES.end()) {
    throw_value_error("subject.role is required");
  }
  if (!subject.contains("operation") || !subject.contains("fromState") || !subject.contains("toState")) {
    throw_value_error("subject transition is not declared by the Kungfu Profile");
  }
  const Transition transition{subject.at("operation").get<std::string>(), subject.at("fromState").get<std::string>(),
                              subject.at("toState").get<std::string>()};
  const auto transitions = TRANSITIONS.find(role);
  if (transitions == TRANSITIONS.end() || transitions->second.count(transition) == 0) {
    throw_value_error("subject transition is not declared by the Kungfu Profile");
  }

  for (const auto field : {"basis", "ref"}) {
    if (!request.contains(field) || !request.at(field).is_object()) {
      throw_value_error(std::string(field) + " is required");
    }
    const auto &value = request.at(field);
    require_root(value.contains("cutRoot") ? value.at("cutRoot") : nlohmann::json(nullptr),
                 std::string(field) + ".cutRoot", true);
    if (!value.contains("revision") || !value.at("revision").is_number_integer() ||
        value.at("revision").get<int>() < 0) {
      throw_value_error(std::string(field) + ".revision must be a non-negative integer");
    }
  }

  if (!request.contains("responsibilities") || !roles_set_matches(request.at("responsibilities"))) {
    throw_value_error("all five responsibilities are required exactly once");
  }
  const auto &responsibilities = request.at("responsibilities");
  std::vector<std::string> object_ids;
  for (const char *role_name : ROLES) {
    const std::string role(role_name);
    if (!responsibilities.contains(role) || !responsibilities.at(role).is_object()) {
      throw_value_error("responsibilities." + role + ".objectId is required");
    }
    const auto &value = responsibilities.at(role);
    if (!value.contains("objectId") || !value.at("objectId").is_string()) {
      throw_value_error("responsibilities." + role + ".objectId is required");
    }
    const auto object_id = value.at("objectId").get<std::string>();
    if (!std::regex_match(object_id, FACT_ID_PATTERN)) {
      throw_value_error("responsibilities." + role + ".objectId is not canonical");
    }
    require_root(value.contains("expectedVersionRoot") ? value.at("expectedVersionRoot") : nlohmann::json(nullptr),
                 "responsibilities." + role + ".expectedVersionRoot", true);
    object_ids.push_back(object_id);
  }
  if (std::set<std::string>(object_ids.begin(), object_ids.end()).size() != ROLES.size()) {
    throw_value_error("all five responsibilities require distinct logical object identities");
  }

  if (!request.contains("support") || !request.at("support").is_object()) {
    throw_value_error("support is required");
  }
  const auto &support = request.at("support");
  for (const char *field : {"createdByReceiptRoot", "schemaRoot", "reasonRoot"}) {
    require_root(support.contains(field) ? support.at(field) : nlohmann::json(nullptr),
                 std::string("support.") + field);
  }
  require_root_list(support.contains("declarationRoots") ? support.at("declarationRoots") : nlohmann::json(nullptr),
                    "support.declarationRoots");
  require_root_list(support.contains("admissionRoots") ? support.at("admissionRoots") : nlohmann::json(nullptr),
                    "support.admissionRoots");
}

std::optional<std::tuple<std::string, std::string, nlohmann::json>>
validate_lifecycle_payload(const std::string &subject_role, const nlohmann::json &subject,
                           const std::map<std::string, nlohmann::json> &current_roles, const nlohmann::json &payload,
                           const nlohmann::json &basis, const nlohmann::json &ref) {
  try {
    const auto operation = subject.at("operation").get<std::string>();
    nlohmann::json current_body = nlohmann::json::object();
    if (current_roles.count(subject_role) != 0) {
      current_body = current_roles.at(subject_role).at("body");
    }
    nlohmann::json current_details = nlohmann::json::object();
    if (current_body.is_object() && current_body.contains("details")) {
      current_details = current_body.at("details");
    }
    if (!current_details.is_object()) {
      return std::make_tuple("invalid-request", subject_role + " details must be an object", nlohmann::json::object());
    }

    if (subject_role == "episode" && operation == "seal") {
      const auto episode_id = payload.contains("episodeId") ? payload.at("episodeId") : nlohmann::json(nullptr);
      if (episode_id != current_details.value("episodeId", nlohmann::json(nullptr))) {
        return std::make_tuple("replay-mismatch", "Episode seal identity differs from the open Episode",
                               nlohmann::json{{"expected", current_details.value("episodeId", nlohmann::json(nullptr))},
                                              {"actual", episode_id}});
      }
      for (const char *field : {"beforeCutRoot", "afterCutRoot", "causalRoot", "sealedContentRoot"}) {
        require_root(payload.contains(field) ? payload.at(field) : nlohmann::json(nullptr),
                     std::string("payload.") + field);
      }
    }

    if (subject_role == "episode" && operation == "reconcile") {
      if (!payload.contains("replay") || !payload.at("replay").is_object()) {
        return std::make_tuple("invalid-request", "Episode reconciliation requires replay evidence",
                               nlohmann::json::object());
      }
      const auto &replay = payload.at("replay");
      nlohmann::json expected = nlohmann::json::object();
      nlohmann::json actual = nlohmann::json::object();
      for (const char *field : {"episodeId", "beforeCutRoot", "afterCutRoot", "causalRoot", "sealedContentRoot"}) {
        expected[field] = current_details.contains(field) ? current_details.at(field) : nlohmann::json(nullptr);
        actual[field] = replay.contains(field) ? replay.at(field) : nlohmann::json(nullptr);
      }
      for (const char *field : {"beforeCutRoot", "afterCutRoot", "causalRoot", "sealedContentRoot"}) {
        require_root(actual.contains(field) ? actual.at(field) : nlohmann::json(nullptr),
                     std::string("payload.replay.") + field);
      }
      if (actual != expected) {
        return std::make_tuple("replay-mismatch", "Episode replay evidence differs from the sealed causal record",
                               nlohmann::json{{"expected", expected}, {"actual", actual}});
      }
    }

    if (subject_role == "pursuit" && operation == "branch") {
      const auto ref_cut = ref.contains("cutRoot") ? ref.at("cutRoot") : nlohmann::json(nullptr);
      const auto ref_revision = ref.contains("revision") ? ref.at("revision") : nlohmann::json(nullptr);
      if (!ref_cut.is_null() || !ref_revision.is_number_integer() || ref_revision.get<int>() != 0) {
        return std::make_tuple("invalid-transition", "Pursuit branch requires a new destination ref at revision zero",
                               nlohmann::json::object());
      }
      require_root(payload.contains("branchReasonRoot") ? payload.at("branchReasonRoot") : nlohmann::json(nullptr),
                   "payload.branchReasonRoot");
      const auto payload_branch =
          payload.contains("branchOfCutRoot") ? payload.at("branchOfCutRoot") : nlohmann::json(nullptr);
      const auto basis_cut = basis.contains("cutRoot") ? basis.at("cutRoot") : nlohmann::json(nullptr);
      if (payload_branch != basis_cut) {
        return std::make_tuple("profile-state-mismatch", "Pursuit branch must bind the exact source Cut",
                               nlohmann::json{{"expected", basis_cut}, {"actual", payload_branch}});
      }
    }

    if (subject_role == "pursuit" && (operation == "complete" || operation == "abandon")) {
      require_root(payload.contains("settlementRoot") ? payload.at("settlementRoot") : nlohmann::json(nullptr),
                   "payload.settlementRoot");
      if (!payload.contains("outcome") || !payload.at("outcome").is_string() ||
          payload.at("outcome").get<std::string>().empty()) {
        return std::make_tuple("invalid-request", "Pursuit settlement requires a non-empty outcome",
                               nlohmann::json::object());
      }
    }

    if (subject_role == "atlas" && operation == "mark-stale") {
      require_root_list(payload.contains("lossRoots") ? payload.at("lossRoots") : nlohmann::json(nullptr),
                        "payload.lossRoots");
      if (!payload.contains("lossReason") || !payload.at("lossReason").is_string() ||
          payload.at("lossReason").get<std::string>().empty()) {
        return std::make_tuple("invalid-request", "Atlas staleness requires an explicit loss reason",
                               nlohmann::json::object());
      }
    }

    if (subject_role == "atlas" && operation == "refresh") {
      require_root_list(payload.contains("sourceRoots") ? payload.at("sourceRoots") : nlohmann::json(nullptr),
                        "payload.sourceRoots");
      require_root_list(payload.contains("lossRoots") ? payload.at("lossRoots") : nlohmann::json(nullptr),
                        "payload.lossRoots");
      const auto valid_through =
          payload.contains("validThroughRevision") ? payload.at("validThroughRevision") : nlohmann::json(nullptr);
      if (!valid_through.is_number_integer() || valid_through.get<int>() < basis.at("revision").get<int>()) {
        return std::make_tuple(
            "atlas-stale", "refreshed Atlas does not cover the declared basis revision",
            nlohmann::json{{"basisRevision", basis.at("revision")}, {"validThroughRevision", valid_through}});
      }
    }

    if (subject_role == "warrant" && operation == "attenuate") {
      const auto old_allowed = current_details.contains("allowedOperations") ? current_details.at("allowedOperations")
                                                                             : nlohmann::json(nullptr);
      const auto new_allowed =
          payload.contains("allowedOperations") ? payload.at("allowedOperations") : nlohmann::json(nullptr);
      if (!old_allowed.is_array() || !new_allowed.is_array()) {
        return std::make_tuple("invalid-request", "Warrant attenuation requires explicit old and new operation scopes",
                               nlohmann::json::object());
      }
      if (new_allowed.empty()) {
        return std::make_tuple("invalid-transition", "attenuated Warrant scope must be a non-empty strict subset",
                               nlohmann::json::object());
      }
      for (const auto &item : new_allowed) {
        if (item.is_string() && item.get<std::string>() == "*") {
          return std::make_tuple("invalid-transition", "attenuated Warrant scope must be a non-empty strict subset",
                                 nlohmann::json::object());
        }
      }
      std::set<std::string> old_scope;
      for (const auto &item : old_allowed) {
        if (item.is_string()) {
          old_scope.insert(item.get<std::string>());
        }
      }
      std::set<std::string> new_scope;
      for (const auto &item : new_allowed) {
        if (item.is_string()) {
          new_scope.insert(item.get<std::string>());
        }
      }
      if (old_scope.count("*") == 0 && !(new_scope < old_scope)) {
        std::vector<std::string> old_sorted(old_scope.begin(), old_scope.end());
        std::vector<std::string> new_sorted(new_scope.begin(), new_scope.end());
        std::sort(old_sorted.begin(), old_sorted.end());
        std::sort(new_sorted.begin(), new_sorted.end());
        return std::make_tuple("unauthorized", "Warrant attenuation cannot widen or preserve the old scope",
                               nlohmann::json{{"old", old_sorted}, {"new", new_sorted}});
      }
      const auto old_valid_through = current_details.contains("validThroughRevision")
                                         ? current_details.at("validThroughRevision")
                                         : nlohmann::json(nullptr);
      const auto new_valid_through =
          payload.contains("validThroughRevision") ? payload.at("validThroughRevision") : nlohmann::json(nullptr);
      if (!old_valid_through.is_number_integer() || !new_valid_through.is_number_integer() ||
          new_valid_through.get<int>() > old_valid_through.get<int>()) {
        return std::make_tuple("unauthorized", "Warrant attenuation cannot extend its validity revision",
                               nlohmann::json{{"old", old_valid_through}, {"new", new_valid_through}});
      }
    }

    if (subject_role == "warrant" && (operation == "expire" || operation == "revoke" || operation == "deny")) {
      require_root(payload.contains("reasonRoot") ? payload.at("reasonRoot") : nlohmann::json(nullptr),
                   "payload.reasonRoot");
      if (!payload.contains("reason") || !payload.at("reason").is_string() ||
          payload.at("reason").get<std::string>().empty()) {
        return std::make_tuple("invalid-request", "Warrant " + operation + " requires an explicit reason",
                               nlohmann::json::object());
      }
    }
  } catch (const std::runtime_error &error) {
    return std::make_tuple("invalid-request", error.what(), nlohmann::json::object());
  }
  return std::nullopt;
}

std::string validation_denial_code(const std::string &message) {
  if (message.find("five responsibilities") != std::string::npos) {
    return "responsibility-gap";
  }
  if (message.find("transition") != std::string::npos) {
    return "invalid-transition";
  }
  return "invalid-request";
}

nlohmann::json require_session_component(const nlohmann::json &session, const std::string &field,
                                         const std::string &identity_field) {
  if (!session.contains(field) || !session.at(field).is_object()) {
    throw_value_error(field + " must be an object");
  }
  const auto &value = session.at(field);
  if (!value.contains(identity_field) || !value.at(identity_field).is_string() ||
      value.at(identity_field).get<std::string>().empty()) {
    throw_value_error(field + "." + identity_field + " is required");
  }
  return value;
}

std::map<std::string, nlohmann::json> validate_session(const nlohmann::json &session) {
  if (!session.is_object() || !session.contains("schema") ||
      session.at("schema").get<std::string>() != PROFILE_SESSION_SCHEMA_V1) {
    throw_value_error(std::string("schema must be ") + PROFILE_SESSION_SCHEMA_V1);
  }
  if (!session.contains("sessionId") || !session.at("sessionId").is_string() ||
      session.at("sessionId").get<std::string>().empty()) {
    throw_value_error("sessionId is required");
  }
  std::map<std::string, nlohmann::json> components;
  components["pursuit"] = require_session_component(session, "goal", "pursuitId");
  components["atlas"] = require_session_component(session, "context", "atlasId");
  components["warrant"] = require_session_component(session, "permissions", "warrantId");
  components["episode"] = require_session_component(session, "run", "episodeId");
  components["fact"] = require_session_component(session, "facts", "factId");

  std::vector<std::string> identities;
  identities.push_back(components["fact"].at("factId").get<std::string>());
  identities.push_back(components["episode"].at("episodeId").get<std::string>());
  identities.push_back(components["pursuit"].at("pursuitId").get<std::string>());
  identities.push_back(components["atlas"].at("atlasId").get<std::string>());
  identities.push_back(components["warrant"].at("warrantId").get<std::string>());
  if (std::set<std::string>(identities.begin(), identities.end()).size() != identities.size()) {
    throw_value_error("session responsibilities require distinct identities");
  }

  for (const char *field : {"basisRevision", "validThroughRevision"}) {
    const auto &value = components["atlas"].contains(field) ? components["atlas"].at(field) : nlohmann::json(nullptr);
    if (!value.is_number_integer() || value.get<int>() < 0) {
      throw_value_error(std::string("context.") + field + " must be a non-negative integer");
    }
  }
  const auto valid_through = components["warrant"].contains("validThroughRevision")
                                 ? components["warrant"].at("validThroughRevision")
                                 : nlohmann::json(nullptr);
  if (!valid_through.is_number_integer() || valid_through.get<int>() < 0) {
    throw_value_error("permissions.validThroughRevision must be a non-negative integer");
  }

  for (const auto &[field, component, key] : std::vector<std::tuple<const char *, nlohmann::json, const char *>>{
           {"goal.operations", components.at("pursuit"), "operations"},
           {"permissions.allowedOperations", components.at("warrant"), "allowedOperations"}}) {
    const auto &value = component.contains(key) ? component.at(key) : nlohmann::json(nullptr);
    if (!value.is_array() || value.empty()) {
      throw_value_error(std::string(field) + " must be a non-empty string array");
    }
    for (const auto &item : value) {
      if (!item.is_string() || item.get<std::string>().empty()) {
        throw_value_error(std::string(field) + " must be a non-empty string array");
      }
    }
  }

  return components;
}

} // namespace

nlohmann::json profile_action_capabilities(const std::string &search_base) {
  const auto profile_roots = domain_profile_roots(search_base);
  const auto profile_contract = load_registered_contract(AGENT_WORK_DOMAIN_PROFILE_SURFACE, search_base);

  nlohmann::json role_body_schemas = nlohmann::json::object();
  for (const char *role : ROLES) {
    role_body_schemas[role] = profile_contract.document.at("roleSchemas").at(role).at("schema");
  }

  nlohmann::json transitions = nlohmann::json::object();
  for (const char *role : ROLES) {
    std::vector<Transition> sorted;
    const auto found = TRANSITIONS.find(role);
    if (found != TRANSITIONS.end()) {
      sorted.assign(found->second.begin(), found->second.end());
    }
    std::sort(sorted.begin(), sorted.end());
    nlohmann::json rows = nlohmann::json::array();
    for (const auto &item : sorted) {
      rows.push_back({{"operation", std::get<0>(item)}, {"from", std::get<1>(item)}, {"to", std::get<2>(item)}});
    }
    transitions[role] = std::move(rows);
  }

  nlohmann::json roles = nlohmann::json::array();
  for (const char *role : ROLES) {
    roles.push_back(role);
  }

  nlohmann::json denials = nlohmann::json::array();
  for (const char *code : DENIALS) {
    denials.push_back(code);
  }

  nlohmann::json result;
  result["schema"] = PROFILE_CAPABILITIES_SCHEMA_V1;
  result["profile"] = "kungfu-kfd-7-action-profile";
  result["roles"] = std::move(roles);
  result["actionSchema"] = PROFILE_ACTION_SCHEMA_V1;
  result["receiptSchema"] = PROFILE_ACTION_RECEIPT_V1;
  result["roleBodySchema"] = PROFILE_ROLE_BODY_SCHEMA_V1;
  result["actionGeometryRoot"] = profile_roots.at("actionGeometryRoot");
  result["domainProfileRoot"] = profile_roots.at("domainProfileRoot");
  result["roleSchemaRoots"] = profile_roots.at("roleSchemaRoots");
  result["roleBodySchemas"] = std::move(role_body_schemas);
  result["compatibility"] = profile_contract.document.at("legacyCompatibility");
  result["transitions"] = std::move(transitions);
  result["denials"] = std::move(denials);
  result["authority"] = {{"profile", "role vocabulary, transition checks, progressive disclosure"},
                         {"kernel", "identity, immutable versions, relations, Cuts, CAS, receipts"},
                         {"episode", "causal occurrence and sealed evidence"}};
  result["recovery"] = {
      {"projectionRebuild",
       {{"status", "supported"},
        {"source", "native Fact journal and content-addressed bodies"},
        {"identity", "preserved"}}},
      {"exportImport",
       {{"status", "supported"},
        {"bundleSchema", FACT_AUTHORITY_BUNDLE_SCHEMA_V2},
        {"authority", "native Fact journal replay through the existing kernel"},
        {"preserves", nlohmann::json::array({"logical object ids", "version and body roots", "relation and Cut roots",
                                             "named ref roots and revisions"})}}},
      {"backendMigration",
       {{"status", "supported-by-storage-backend-switch"},
        {"identity", "five-role object, version, Cut, ref, and authority roots remain exact"},
        {"rollback", "reverse-sync-and-atomic-binding"}}},
      {"cleanHome",
       {{"status", "supported-from-qualified-authority-bundle"},
        {"requires", FACT_AUTHORITY_BUNDLE_SCHEMA_V2},
        {"lossCode", "profile-authority-unavailable"}}}};
  result["sessionProjection"] = {
      {"schema", PROFILE_SESSION_SCHEMA_V1},
      {"expand", "kungfu.agent.work_profile.expand_session"},
      {"project", "kungfu.agent.work_profile.project_session"},
      {"compressibilityPredicate", "kungfu.agent.work_profile.session_compressibility"},
      {"semanticDimensions", nlohmann::json::array({"direction", "perspective-boundary", "effective-authority",
                                                    "causal-process", "admitted-result"})}};
  result["nonClaims"] =
      nlohmann::json::array({"A Profile receipt does not adopt KFD-7 or replace KFD authority.",
                             "An accepted action does not prove Pursuit completion or complete reality."});
  return result;
}

nlohmann::json session_compressibility(const nlohmann::json &session) {
  const auto components = validate_session(session);
  nlohmann::json reasons = nlohmann::json::array();

  const auto &goal = components.at("pursuit");
  if ((!goal.contains("state") || goal.at("state").get<std::string>() != "active") ||
      (goal.contains("alternatives") && !goal.at("alternatives").empty())) {
    reasons.push_back({{"role", "pursuit"}, {"code", "multiple-or-terminal-direction"}});
  }

  const auto &context = components.at("atlas");
  if ((!context.contains("state") || context.at("state").get<std::string>() != "current") ||
      context.at("validThroughRevision").get<int>() < context.at("basisRevision").get<int>() ||
      (context.contains("lossRoots") && !context.at("lossRoots").empty()) ||
      (context.contains("perspectives") && context.at("perspectives").is_array() &&
       context.at("perspectives").size() > 1)) {
    reasons.push_back({{"role", "atlas"}, {"code", "perspective-or-freshness-boundary"}});
  }

  const auto &permissions = components.at("warrant");
  if ((!permissions.contains("state") || permissions.at("state").get<std::string>() != "issued") ||
      permissions.at("validThroughRevision").get<int>() < context.at("basisRevision").get<int>() ||
      (permissions.contains("delegated") && permissions.at("delegated").is_boolean() &&
       permissions.at("delegated").get<bool>())) {
    reasons.push_back({{"role", "warrant"}, {"code", "authority-boundary"}});
  }

  const auto &run = components.at("episode");
  nlohmann::json episode_ids = nlohmann::json::array({run.at("episodeId")});
  if (run.contains("episodeIds") && run.at("episodeIds").is_array()) {
    episode_ids = run.at("episodeIds");
  }
  if ((!run.contains("state") ||
       (run.at("state").get<std::string>() != "open" && run.at("state").get<std::string>() != "sealed")) ||
      episode_ids.size() != 1) {
    reasons.push_back({{"role", "episode"}, {"code", "causal-branch"}});
  }

  const auto &facts = components.at("fact");
  if ((facts.contains("branchRoots") && !facts.at("branchRoots").empty()) ||
      (facts.contains("resultRoots") && facts.at("resultRoots").is_array() && facts.at("resultRoots").size() > 1)) {
    reasons.push_back({{"role", "fact"}, {"code", "fact-branch"}});
  }

  std::set<std::string> revealed;
  for (const auto &reason : reasons) {
    if (reason.is_object() && reason.contains("role") && reason.at("role").is_string()) {
      revealed.insert(reason.at("role").get<std::string>());
    }
  }
  nlohmann::json revealed_roles = nlohmann::json::array();
  for (const auto &role : revealed) {
    revealed_roles.push_back(role);
  }

  return {{"schema", PROFILE_SESSION_COMPRESSIBILITY_SCHEMA_V1},
          {"sessionId", session.at("sessionId")},
          {"compressible", reasons.empty()},
          {"breakpoints", reasons},
          {"revealedRoles", std::move(revealed_roles)}};
}

nlohmann::json session_valid_actions(const nlohmann::json &session) {
  const auto components = validate_session(session);
  const auto &context = components.at("atlas");
  const auto &warrant = components.at("warrant");
  const auto &pursuit = components.at("pursuit");
  if ((!pursuit.contains("state") || pursuit.at("state").get<std::string>() != "active") ||
      (!context.contains("state") || context.at("state").get<std::string>() != "current") ||
      context.at("validThroughRevision").get<int>() < context.at("basisRevision").get<int>() ||
      (!warrant.contains("state") || warrant.at("state").get<std::string>() != "issued") ||
      warrant.at("validThroughRevision").get<int>() < context.at("basisRevision").get<int>()) {
    return nlohmann::json::array();
  }

  std::set<std::string> pursuit_ops;
  for (const auto &item : pursuit.at("operations")) {
    if (item.is_string()) {
      pursuit_ops.insert(item.get<std::string>());
    }
  }
  std::set<std::string> warrant_ops;
  for (const auto &item : warrant.at("allowedOperations")) {
    if (item.is_string()) {
      warrant_ops.insert(item.get<std::string>());
    }
  }
  std::set<std::string> intersection;
  for (const auto &item : pursuit_ops) {
    if (warrant_ops.count(item) != 0) {
      intersection.insert(item);
    }
  }
  nlohmann::json result = nlohmann::json::array();
  for (const auto &item : intersection) {
    result.push_back(item);
  }
  return result;
}

nlohmann::json expand_session(const nlohmann::json &session) {
  const auto components = validate_session(session);
  const auto compressibility = session_compressibility(session);

  nlohmann::json roles = nlohmann::json::object();
  for (const char *role : ROLES) {
    roles[role] = {
        {"schema", PROFILE_ROLE_BODY_SCHEMA_V1},
        {"role", role},
        {"state", components.at(role).contains("state") ? components.at(role).at("state") : nlohmann::json(nullptr)},
        {"details", json_sorted_copy(components.at(role))}};
  }

  return {{"schema", PROFILE_SESSION_EXPANSION_SCHEMA_V1},
          {"sessionId", session.at("sessionId")},
          {"compressibility", compressibility},
          {"roles", roles},
          {"observations",
           {{"direction", roles.at("pursuit").at("details")},
            {"perspective-boundary", roles.at("atlas").at("details")},
            {"effective-authority", roles.at("warrant").at("details")},
            {"causal-process", roles.at("episode").at("details")},
            {"admitted-result", roles.at("fact").at("details")}}},
          {"validActions", session_valid_actions(session)}};
}

nlohmann::json project_session(const nlohmann::json &expansion, const std::string &search_base) {
  if (!expansion.is_object() || !expansion.contains("schema") ||
      expansion.at("schema").get<std::string>() != PROFILE_SESSION_EXPANSION_SCHEMA_V1) {
    throw_value_error(std::string("schema must be ") + PROFILE_SESSION_EXPANSION_SCHEMA_V1);
  }
  const auto &compressibility =
      expansion.contains("compressibility") ? expansion.at("compressibility") : nlohmann::json(nullptr);
  if (!compressibility.is_object() || !compressibility.contains("compressible") ||
      !compressibility.at("compressible").is_boolean() || !compressibility.at("compressible").get<bool>()) {
    throw_value_error("session-complexity-breakpoint");
  }
  if (!expansion.contains("roles") || !roles_set_matches(expansion.at("roles"))) {
    throw_value_error("all five expanded roles are required exactly once");
  }
  const auto &roles = expansion.at("roles");
  for (const char *role : ROLES) {
    const auto &body = roles.at(role);
    try {
      if (!body.is_object()) {
        throw_value_error("role body must be an object");
      }
      (void)validate_role_body(body, true, search_base);
    } catch (const std::runtime_error &error) {
      throw_value_error(std::string("expanded ") + role + " role is invalid: " + error.what());
    }
    if (!body.contains("role") || body.at("role").get<std::string>() != role || !body.contains("details") ||
        !body.at("details").is_object()) {
      throw_value_error(std::string("expanded ") + role + " role is invalid");
    }
  }

  nlohmann::json projected = {
      {"schema", PROFILE_SESSION_SCHEMA_V1},
      {"sessionId", expansion.contains("sessionId") ? expansion.at("sessionId") : nlohmann::json(nullptr)},
      {"goal", roles.at("pursuit").at("details")},
      {"context", roles.at("atlas").at("details")},
      {"permissions", roles.at("warrant").at("details")},
      {"run", roles.at("episode").at("details")},
      {"facts", roles.at("fact").at("details")}};
  validate_session(projected);
  return projected;
}

nlohmann::json inspect_profile_action(const std::string &runtime_dir, const std::string &ref_name, FactKernelFn kernel,
                                      const std::string & /*search_base*/) {
  const auto invoke = resolve_kernel(std::move(kernel));
  if (!std::regex_match(ref_name, REF_PATTERN) || ref_name.find("..") != std::string::npos) {
    return denied_receipt("inspect", "invalid-request", "refName is not canonical");
  }

  const nlohmann::json catalog = invoke(runtime_dir, "query", nlohmann::json::object());
  if (!catalog.contains("ok") || !catalog.at("ok").is_boolean() || !catalog.at("ok").get<bool>()) {
    return denied_receipt("inspect", "kernel-rejected", "Fact kernel catalog query failed",
                          catalog.is_object() ? catalog : nlohmann::json::object());
  }

  nlohmann::json resolution = nlohmann::json(nullptr);
  if (catalog.contains("refs") && catalog.at("refs").is_object() && catalog.at("refs").contains(ref_name)) {
    resolution = catalog.at("refs").at(ref_name);
  }
  if (!resolution.is_object()) {
    nlohmann::json gaps = nlohmann::json::array();
    for (const char *role : ROLES) {
      gaps.push_back({{"role", role}, {"code", "responsibility-gap"}});
    }
    return {{"schema", PROFILE_INSPECTION_SCHEMA_V1},
            {"status", "absent"},
            {"refName", ref_name},
            {"cutRoot", nullptr},
            {"revision", 0},
            {"roles", nlohmann::json::object()},
            {"gaps", gaps},
            {"relations", nlohmann::json::array()}};
  }

  const auto cut_root = resolution.contains("cut_root") ? resolution.at("cut_root") : nlohmann::json(nullptr);
  LoadedCut loaded;
  try {
    loaded = load_cut(runtime_dir, cut_root, invoke);
  } catch (const std::runtime_error &error) {
    return denied_receipt("inspect", "kernel-rejected", "Fact Cut query failed",
                          nlohmann::json{{"error", error.what()}});
  }

  nlohmann::json roles_out = nlohmann::json::object();
  for (const auto &item : loaded.roles) {
    roles_out[item.first] = item.second;
  }

  nlohmann::json gaps = nlohmann::json::array();
  for (const char *role : ROLES) {
    if (loaded.roles.count(role) == 0) {
      gaps.push_back({{"role", role}, {"code", "responsibility-gap"}});
    }
  }

  nlohmann::json basis = nlohmann::json(nullptr);
  if (loaded.cut.is_object() && loaded.cut.contains("cut")) {
    basis = loaded.cut.at("cut");
  }

  return {{"schema", PROFILE_INSPECTION_SCHEMA_V1},
          {"status", loaded.roles.size() == ROLES.size() ? "current" : "degraded"},
          {"refName", ref_name},
          {"cutRoot", cut_root},
          {"revision", resolution.contains("revision") ? resolution.at("revision") : nlohmann::json(0)},
          {"roles", roles_out},
          {"gaps", gaps},
          {"relations", loaded.relation_roots},
          {"basis", basis}};
}

nlohmann::json apply_profile_action(const std::string &runtime_dir, const nlohmann::json &request, bool execute,
                                    FactKernelFn kernel, const std::string &search_base) {
  const auto invoke = resolve_kernel(std::move(kernel));
  const std::string action_id =
      request.is_object() && request.contains("actionId") && request.at("actionId").is_string()
          ? request.at("actionId").get<std::string>()
          : "unknown";

  try {
    validate_request(request);
  } catch (const std::runtime_error &error) {
    return denied_receipt(action_id, validation_denial_code(error.what()), error.what());
  } catch (const nlohmann::json::exception &error) {
    return denied_receipt(action_id, "invalid-request", error.what());
  }

  const auto &subject = request.at("subject");
  const auto &basis = request.at("basis");
  const auto &responsibilities = request.at("responsibilities");

  LoadedCut loaded;
  try {
    loaded = load_cut(runtime_dir, basis.contains("cutRoot") ? basis.at("cutRoot") : nlohmann::json(nullptr), invoke);
  } catch (const std::runtime_error &error) {
    return denied_receipt(action_id, "kernel-rejected", "declared basis Cut is unavailable",
                          nlohmann::json{{"error", error.what()}});
  }

  std::vector<std::string> missing;
  for (const char *role : ROLES) {
    if (loaded.roles.count(role) == 0) {
      missing.push_back(role);
    }
  }
  const auto basis_cut = basis.contains("cutRoot") ? basis.at("cutRoot") : nlohmann::json(nullptr);
  if (!basis_cut.is_null() && !missing.empty()) {
    return denied_receipt(action_id, "body-missing", "the declared Cut does not expose all five Profile role bodies",
                          nlohmann::json{{"missingRoles", missing}});
  }

  for (const char *role : ROLES) {
    const auto expected = responsibilities.at(role).contains("expectedVersionRoot")
                              ? responsibilities.at(role).at("expectedVersionRoot")
                              : nlohmann::json(nullptr);
    const auto current_it = loaded.roles.find(role);
    nlohmann::json actual = nlohmann::json(nullptr);
    if (current_it != loaded.roles.end()) {
      actual = current_it->second.at("versionRoot");
    }
    if (expected != actual) {
      return denied_receipt(action_id, "profile-state-mismatch",
                            std::string(role) + " version does not match the declared basis",
                            nlohmann::json{{"role", role}, {"expected", expected}, {"actual", actual}});
    }
    if (current_it != loaded.roles.end() &&
        current_it->second.at("objectId") != responsibilities.at(role).at("objectId")) {
      return denied_receipt(action_id, "profile-state-mismatch",
                            std::string(role) + " identity does not match the declared basis",
                            nlohmann::json{{"role", role},
                                           {"expected", responsibilities.at(role).at("objectId")},
                                           {"actual", current_it->second.at("objectId")}});
    }
  }

  const auto subject_role = subject.at("role").get<std::string>();
  const auto current_subject_it = loaded.roles.find(subject_role);
  std::string current_state = "absent";
  if (current_subject_it != loaded.roles.end()) {
    current_state = current_subject_it->second.at("body").at("state").get<std::string>();
  }
  if (current_state != subject.at("fromState").get<std::string>()) {
    return denied_receipt(action_id, "profile-state-mismatch", "subject state differs from the declared transition",
                          nlohmann::json{{"expected", subject.at("fromState")}, {"actual", current_state}});
  }

  const nlohmann::json role_inputs =
      request.contains("roleInputs") && request.at("roleInputs").is_object()
          ? request.at("roleInputs")
          : (request.contains("roleInputs") ? nlohmann::json(nullptr) : nlohmann::json::object());
  if (request.contains("roleInputs") && !request.at("roleInputs").is_object()) {
    return denied_receipt(action_id, "invalid-request", "roleInputs must be an object");
  }
  if (basis_cut.is_null()) {
    for (const char *role : ROLES) {
      const auto value = role_inputs.contains(role) ? role_inputs.at(role) : nlohmann::json(nullptr);
      if (!value.is_object() || !value.contains("state") ||
          value.at("state").get<std::string>() != INITIAL_STATES.at(role)) {
        return denied_receipt(action_id, "responsibility-gap",
                              "bootstrap requires one initial body for every responsibility",
                              nlohmann::json{{"role", role}, {"requiredState", INITIAL_STATES.at(role)}});
      }
    }
  }

  nlohmann::json atlas_body = nlohmann::json::object();
  if (loaded.roles.count("atlas") != 0) {
    atlas_body = loaded.roles.at("atlas").at("body");
  } else if (role_inputs.contains("atlas")) {
    atlas_body = role_inputs.at("atlas");
  }
  const auto atlas_state = atlas_body.contains("state") ? atlas_body.at("state") : nlohmann::json(nullptr);
  nlohmann::json atlas_details = nlohmann::json::object();
  if (atlas_body.is_object() && atlas_body.contains("details")) {
    atlas_details = atlas_body.at("details");
  }
  if (!atlas_details.is_object()) {
    return denied_receipt(action_id, "invalid-request", "Atlas details must be an object");
  }
  const auto subject_operation = subject.at("operation").get<std::string>();
  if ((!atlas_state.is_string() || atlas_state.get<std::string>() != "current") &&
      !(subject_role == "atlas" && subject_operation == "refresh")) {
    return denied_receipt(action_id, "atlas-stale",
                          "Atlas state " + py_repr(atlas_state) + " cannot support the requested transition");
  }
  const auto atlas_valid_through = atlas_details.contains("validThroughRevision")
                                       ? atlas_details.at("validThroughRevision")
                                       : nlohmann::json(nullptr);
  if (!atlas_valid_through.is_number_integer() || basis.at("revision").get<int>() > atlas_valid_through.get<int>()) {
    return denied_receipt(
        action_id, "atlas-stale", "Atlas freshness does not cover the declared basis revision",
        nlohmann::json{{"basisRevision", basis.at("revision")}, {"validThroughRevision", atlas_valid_through}});
  }

  nlohmann::json warrant_body = nlohmann::json::object();
  if (loaded.roles.count("warrant") != 0) {
    warrant_body = loaded.roles.at("warrant").at("body");
  } else if (role_inputs.contains("warrant")) {
    warrant_body = role_inputs.at("warrant");
  }
  const auto warrant_state = warrant_body.contains("state") ? warrant_body.at("state") : nlohmann::json(nullptr);
  nlohmann::json warrant_details = nlohmann::json::object();
  if (warrant_body.is_object() && warrant_body.contains("details")) {
    warrant_details = warrant_body.at("details");
  }
  if (warrant_state.is_string()) {
    const auto state = warrant_state.get<std::string>();
    if (state == "expired" || state == "revoked" || state == "denied") {
      std::string code = "unauthorized";
      if (state == "expired") {
        code = "warrant-expired";
      } else if (state == "revoked") {
        code = "warrant-revoked";
      }
      return denied_receipt(action_id, code, "Warrant state " + py_repr(warrant_state) + " cannot authorize an action");
    }
  }
  const auto valid_through = warrant_details.contains("validThroughRevision")
                                 ? warrant_details.at("validThroughRevision")
                                 : nlohmann::json(nullptr);
  if (!valid_through.is_number_integer() || basis.at("revision").get<int>() > valid_through.get<int>()) {
    return denied_receipt(
        action_id, "warrant-expired", "Warrant validity does not cover the declared basis revision",
        nlohmann::json{{"basisRevision", basis.at("revision")}, {"validThroughRevision", valid_through}});
  }
  const auto allowed =
      warrant_details.contains("allowedOperations") ? warrant_details.at("allowedOperations") : nlohmann::json(nullptr);
  const std::string operation_key = subject_role + ":" + subject_operation;
  bool authorized = false;
  if (allowed.is_array()) {
    for (const auto &candidate : allowed) {
      if (!candidate.is_string()) {
        continue;
      }
      const auto value = candidate.get<std::string>();
      if (value == "*" || value == subject_operation || value == operation_key) {
        authorized = true;
        break;
      }
    }
  }
  if (!authorized) {
    return denied_receipt(
        action_id, "unauthorized", "Warrant scope does not authorize the requested transition",
        nlohmann::json{{"operation", operation_key},
                       {"allowedOperations", allowed.is_array() ? allowed : nlohmann::json::array()}});
  }

  const nlohmann::json payload = request.contains("payload") && request.at("payload").is_object()
                                     ? request.at("payload")
                                     : nlohmann::json::object();
  if (request.contains("payload") && !request.at("payload").is_object()) {
    return denied_receipt(action_id, "invalid-request", "payload must be an object");
  }
  const auto lifecycle_denial =
      validate_lifecycle_payload(subject_role, subject, loaded.roles, payload, basis, request.at("ref"));
  if (lifecycle_denial.has_value()) {
    const auto &[code, message, details] = *lifecycle_denial;
    return denied_receipt(action_id, code, message, details);
  }

  std::vector<std::string> changed_roles;
  if (basis_cut.is_null()) {
    changed_roles.assign(ROLES.begin(), ROLES.end());
  } else {
    changed_roles.push_back(subject_role);
  }

  const auto relations = request.contains("relations") && request.at("relations").is_array() ? request.at("relations")
                                                                                             : nlohmann::json::array();

  nlohmann::json plan;
  plan["schema"] = PROFILE_ACTION_RECEIPT_V1;
  plan["actionId"] = action_id;
  plan["status"] = "planned";
  plan["failureCode"] = nullptr;
  plan["writeOccurred"] = false;
  plan["refWriteOccurred"] = false;
  plan["basis"] = basis;
  plan["ref"] = request.at("ref");
  plan["subject"] = subject;
  plan["changedRoles"] = changed_roles;
  plan["relationCount"] = relations.size();
  plan["commitPoint"] = "native Fact ref CAS";
  plan["residualRisk"] = nlohmann::json::array(
      {"Episode identity and seal roots are Profile mappings until Episode qualification is attached."});
  if (!execute) {
    return plan;
  }

  const auto &support = request.at("support");
  nlohmann::json steps = nlohmann::json::array();
  std::map<std::string, nlohmann::json> next_versions;
  for (const auto &item : loaded.roles) {
    next_versions[item.first] = item.second.at("versionRoot");
  }
  std::map<std::string, nlohmann::json> next_bodies;
  for (const auto &item : loaded.roles) {
    next_bodies[item.first] = item.second.at("body");
  }

  for (const char *role : ROLES) {
    if (loaded.roles.count(role) != 0) {
      continue;
    }
    const nlohmann::json response = invoke(runtime_dir, "object-put",
                                           {{"object_id", responsibilities.at(role).at("objectId")},
                                            {"object_type", std::string("kfd7.profile.") + role},
                                            {"created_by_receipt_root", support.at("createdByReceiptRoot")}});
    steps.push_back(step_record("object-put", response));
    if (!response.contains("ok") || !response.at("ok").is_boolean() || !response.at("ok").get<bool>()) {
      return kernel_failure_receipt(action_id, response, steps);
    }
  }

  for (const auto &role : changed_roles) {
    nlohmann::json body;
    nlohmann::json details;
    if (loaded.roles.count(role) != 0) {
      body = loaded.roles.at(role).at("body");
      if (body.contains("schema") && body.at("schema") == PROFILE_ROLE_BODY_SCHEMA_V1) {
        body["schema"] = role_schema_id(role, search_base);
      }
      body["bindings"] = role_bindings(role, search_base);
      details =
          body.contains("details") && body.at("details").is_object() ? body.at("details") : nlohmann::json::object();
    } else {
      const auto &source = role_inputs.at(role);
      details = source.contains("details") && source.at("details").is_object() ? source.at("details")
                                                                               : nlohmann::json::object();
      nlohmann::json non_claims = nlohmann::json::array();
      if (source.contains("nonClaims") && source.at("nonClaims").is_array()) {
        non_claims = source.at("nonClaims");
      }
      body = {{"schema", role_schema_id(role, search_base)},
              {"profile", "kungfu-kfd-7-action-profile"},
              {"role", role},
              {"identity", {{"objectId", responsibilities.at(role).at("objectId")}}},
              {"state", source.at("state")},
              {"details", details},
              {"bindings", role_bindings(role, search_base)},
              {"nonClaims", non_claims}};
    }
    if (role == subject_role) {
      body["state"] = subject.at("toState");
      for (const auto &item : payload.items()) {
        details[item.key()] = item.value();
      }
      body["details"] = details;
    }
    body["lastActionId"] = action_id;
    body["basedOnCutRoot"] = basis_cut;
    const std::string raw_body = action_canonical_json(body);
    nlohmann::json parents = nlohmann::json::array();
    if (loaded.roles.count(role) != 0) {
      parents.push_back(loaded.roles.at(role).at("versionRoot"));
    }
    const nlohmann::json response = invoke(runtime_dir, "version-put",
                                           {{"object_id", responsibilities.at(role).at("objectId")},
                                            {"body", raw_body},
                                            {"schema_root", support.at("schemaRoot")},
                                            {"parent_version_roots", parents},
                                            {"declaration_roots", support.at("declarationRoots")},
                                            {"admission_roots", support.at("admissionRoots")}});
    steps.push_back(step_record("version-put", response));
    if (!response.contains("ok") || !response.at("ok").is_boolean() || !response.at("ok").get<bool>()) {
      return kernel_failure_receipt(action_id, response, steps);
    }
    next_versions[role] = response.at("result").at("version_root");
    next_bodies[role] = body;
  }

  std::set<std::string> relation_roots(loaded.relation_roots.begin(), loaded.relation_roots.end());
  if (!relations.is_array()) {
    return denied_receipt(action_id, "invalid-request", "relations must be an array", nlohmann::json::object(), steps);
  }
  for (const auto &relation : relations) {
    try {
      if (!relation.is_object()) {
        throw_value_error("relation roles must be KFD-7 responsibilities");
      }
      if (!relation.contains("sourceRole") || !relation.at("sourceRole").is_string() ||
          !relation.contains("targetRole") || !relation.at("targetRole").is_string()) {
        throw_value_error("relation roles must be KFD-7 responsibilities");
      }
      const auto source_role = relation.at("sourceRole").get<std::string>();
      const auto target_role = relation.at("targetRole").get<std::string>();
      if (std::find(ROLES.begin(), ROLES.end(), source_role) == ROLES.end() ||
          std::find(ROLES.begin(), ROLES.end(), target_role) == ROLES.end()) {
        throw_value_error("relation roles must be KFD-7 responsibilities");
      }
      if (!relation.contains("relationId") || !relation.at("relationId").is_string() ||
          !std::regex_match(relation.at("relationId").get<std::string>(), FACT_ID_PATTERN)) {
        throw_value_error("relationId is not canonical");
      }
      require_root(relation.contains("attributesRoot") ? relation.at("attributesRoot") : nlohmann::json(nullptr),
                   "relation.attributesRoot");
    } catch (const std::runtime_error &error) {
      return denied_receipt(action_id, "invalid-request", error.what(), nlohmann::json::object(), steps);
    } catch (const nlohmann::json::exception &error) {
      return denied_receipt(action_id, "invalid-request", error.what(), nlohmann::json::object(), steps);
    }

    const nlohmann::json response =
        invoke(runtime_dir, "relation-add",
               {{"relation_id", relation.at("relationId")},
                {"relation_type", relation.at("relationType")},
                {"source",
                 {{"kind", "logical-object"},
                  {"id", responsibilities.at(relation.at("sourceRole").get<std::string>()).at("objectId")}}},
                {"target",
                 {{"kind", "logical-object"},
                  {"id", responsibilities.at(relation.at("targetRole").get<std::string>()).at("objectId")}}},
                {"attributes_root", relation.at("attributesRoot")},
                {"admission_roots", support.at("admissionRoots")}});
    steps.push_back(step_record("relation-add", response));
    if (!response.contains("ok") || !response.at("ok").is_boolean() || !response.at("ok").get<bool>()) {
      return kernel_failure_receipt(action_id, response, steps);
    }
    relation_roots.insert(response.at("result").at("relation_root").get<std::string>());
  }

  nlohmann::json base_cut = nlohmann::json::object();
  if (loaded.cut.is_object() && loaded.cut.contains("cut") && loaded.cut.at("cut").is_object()) {
    base_cut = loaded.cut.at("cut");
  }
  nlohmann::json episode_frontier = nlohmann::json::array();
  if (request.contains("episodeFrontier")) {
    episode_frontier = request.at("episodeFrontier");
  } else if (base_cut.contains("episodeFrontier")) {
    episode_frontier = base_cut.at("episodeFrontier");
  }

  nlohmann::json parent_cut_roots = nlohmann::json::array();
  if (!basis_cut.is_null()) {
    parent_cut_roots.push_back(basis_cut);
  }

  nlohmann::json object_versions = nlohmann::json::array();
  for (const char *role : ROLES) {
    object_versions.push_back(
        {{"object_id", responsibilities.at(role).at("objectId")}, {"version_root", next_versions.at(role)}});
  }

  nlohmann::json active_relation_roots = nlohmann::json::array();
  for (const auto &root : relation_roots) {
    active_relation_roots.push_back(root);
  }

  const nlohmann::json cut_response = invoke(
      runtime_dir, "cut-put",
      {{"parent_cut_roots", parent_cut_roots},
       {"object_versions", object_versions},
       {"active_relation_roots", active_relation_roots},
       {"declaration_roots", support.at("declarationRoots")},
       {"admission_roots", support.at("admissionRoots")},
       {"episode_frontier", episode_frontier},
       {"omission_roots", request.contains("omissionRoots") ? request.at("omissionRoots") : nlohmann::json::array()},
       {"conflict_roots", request.contains("conflictRoots") ? request.at("conflictRoots") : nlohmann::json::array()}});
  steps.push_back(step_record("cut-put", cut_response));
  if (!cut_response.contains("ok") || !cut_response.at("ok").is_boolean() || !cut_response.at("ok").get<bool>()) {
    return kernel_failure_receipt(action_id, cut_response, steps);
  }
  const auto next_cut_root = cut_response.at("result").at("cut_root");

  std::string ref_kind = "advance";
  if (subject_operation == "fork" || subject_operation == "branch") {
    ref_kind = "fork";
  } else if (request.at("ref").contains("cutRoot") && request.at("ref").at("cutRoot").is_null()) {
    ref_kind = "create";
  }

  const nlohmann::json ref_response =
      invoke(runtime_dir, "ref-cas",
             {{"transition_id", action_id},
              {"ref_name", request.at("refName")},
              {"expected_old_cut_root",
               request.at("ref").contains("cutRoot") ? request.at("ref").at("cutRoot") : nlohmann::json(nullptr)},
              {"expected_old_revision", request.at("ref").at("revision")},
              {"new_cut_root", next_cut_root},
              {"kind", ref_kind},
              {"reason_root", support.at("reasonRoot")}});
  steps.push_back(step_record("ref-cas", ref_response));
  if (!ref_response.contains("ok") || !ref_response.at("ok").is_boolean() || !ref_response.at("ok").get<bool>()) {
    return kernel_failure_receipt(action_id, ref_response, steps);
  }

  nlohmann::json role_states = nlohmann::json::object();
  for (const char *role : ROLES) {
    role_states[role] = next_bodies.at(role).at("state");
  }

  nlohmann::json relation_roots_out = nlohmann::json::array();
  for (const auto &root : relation_roots) {
    relation_roots_out.push_back(root);
  }

  nlohmann::json role_versions = nlohmann::json::object();
  for (const auto &item : next_versions) {
    role_versions[item.first] = item.second;
  }

  bool write_occurred = false;
  for (const auto &step : steps) {
    if (step.is_object() && step.contains("writeOccurred") && step.at("writeOccurred").is_boolean() &&
        step.at("writeOccurred").get<bool>()) {
      write_occurred = true;
      break;
    }
  }

  const auto ref_result = ref_response.contains("result") && ref_response.at("result").is_object()
                              ? ref_response.at("result")
                              : nlohmann::json::object();

  return {
      {"schema", PROFILE_ACTION_RECEIPT_V1},
      {"actionId", action_id},
      {"status", ref_response.contains("status") ? ref_response.at("status") : nlohmann::json("accepted")},
      {"failureCode", nullptr},
      {"writeOccurred", write_occurred},
      {"refWriteOccurred", ref_response.contains("write_occurred") && ref_response.at("write_occurred").is_boolean() &&
                               ref_response.at("write_occurred").get<bool>()},
      {"basis", basis},
      {"subject", subject},
      {"result",
       {{"cutRoot", ref_result.contains("current_cut_root") ? ref_result.at("current_cut_root") : next_cut_root},
        {"revision",
         ref_result.contains("current_revision") ? ref_result.at("current_revision") : nlohmann::json(nullptr)},
        {"roleVersions", role_versions},
        {"roleStates", role_states},
        {"relationRoots", relation_roots_out}}},
      {"kernelReceiptRoot",
       ref_response.contains("receipt_root") ? ref_response.at("receipt_root") : nlohmann::json(nullptr)},
      {"steps", steps},
      {"residualRisk", nlohmann::json::array({"Profile acceptance does not prove Pursuit completion, complete reality, "
                                              "or KFD-7 activation."})}};
}

} // namespace kungfu::runtime::action
