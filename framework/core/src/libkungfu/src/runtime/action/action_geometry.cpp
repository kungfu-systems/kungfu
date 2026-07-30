// SPDX-License-Identifier: Apache-2.0

#include <kungfu/runtime/action/action_geometry.h>

#include <kungfu/runtime/action/action_contract_registry.h>

#include <map>
#include <set>
#include <string>
#include <vector>

namespace kungfu::runtime::action {

namespace {

// Ordered responsibility names as declared by the contract.
std::vector<std::string> responsibility_order(const nlohmann::json &geometry) {
  std::vector<std::string> order;
  for (const auto &name : geometry.at("responsibilities")) {
    order.push_back(name.get<std::string>());
  }
  return order;
}

} // namespace

std::string action_geometry_root(const std::string &search_base) {
  return load_registered_contract(ACTION_GEOMETRY_SURFACE, search_base).root;
}

nlohmann::json evaluate_action_geometry(const nlohmann::json &responsibility_ids,
                                        const nlohmann::json &inference_claims, const std::string &search_base) {
  const auto contract = load_registered_contract(ACTION_GEOMETRY_SURFACE, search_base);
  const auto &geometry = contract.document;

  const auto required = responsibility_order(geometry);
  const std::set<std::string> required_set(required.begin(), required.end());

  std::set<std::string> supplied;
  if (responsibility_ids.is_object()) {
    for (const auto &item : responsibility_ids.items()) {
      supplied.insert(item.key());
    }
  }

  auto failures = nlohmann::json::array();

  // std::set iteration is ordered, matching Python's sorted(...) output.
  std::vector<std::string> missing;
  for (const auto &name : required_set) {
    if (supplied.find(name) == supplied.end()) {
      missing.push_back(name);
    }
  }
  std::vector<std::string> unexpected;
  for (const auto &name : supplied) {
    if (required_set.find(name) == required_set.end()) {
      unexpected.push_back(name);
    }
  }
  if (!missing.empty() || !unexpected.empty()) {
    failures.push_back(
        {{"code", "responsibility-topology-mismatch"}, {"missing", missing}, {"unexpected", unexpected}});
  }

  std::vector<std::string> identities;
  for (const auto &name : required) {
    if (responsibility_ids.contains(name) && responsibility_ids.at(name).is_string()) {
      auto identity = responsibility_ids.at(name).get<std::string>();
      if (!identity.empty()) {
        identities.push_back(identity);
      }
    }
  }
  const std::set<std::string> unique_identities(identities.begin(), identities.end());
  if (identities.size() != required.size() || unique_identities.size() != identities.size()) {
    failures.push_back({{"code", "responsibility-identity-alias"}});
  }

  std::map<std::string, std::string> forbidden;
  for (const auto &row : geometry.at("invariants")) {
    forbidden[row.at("forbids").get<std::string>()] = row.at("id").get<std::string>();
  }
  if (inference_claims.is_array()) {
    for (const auto &claim : inference_claims) {
      const auto key = claim.get<std::string>();
      const auto found = forbidden.find(key);
      if (found != forbidden.end()) {
        failures.push_back({{"code", "non-substitution-invariant"}, {"invariant", found->second}});
      }
    }
  }

  auto responsibility_out = nlohmann::json::object();
  for (const auto &name : required) {
    if (responsibility_ids.contains(name)) {
      responsibility_out[name] = responsibility_ids.at(name);
    }
  }

  nlohmann::json result;
  result["schema"] = ACTION_GEOMETRY_EVALUATION_V1;
  result["geometryRoot"] = contract.root;
  result["admissible"] = failures.empty();
  result["responsibilityIds"] = responsibility_out;
  result["failures"] = failures;
  return result;
}

nlohmann::json evaluate_session_refinement(const nlohmann::json &before, const nlohmann::json &after,
                                           const std::string &search_base) {
  const auto contract = load_registered_contract(ACTION_GEOMETRY_SURFACE, search_base);
  const auto &geometry = contract.document;

  std::vector<std::string> dimensions;
  for (const auto &name : geometry.at("sessionRefinement").at("semanticDimensions")) {
    dimensions.push_back(name.get<std::string>());
  }

  auto missing = nlohmann::json::array();
  for (const auto &name : dimensions) {
    if (!before.contains(name) || !after.contains(name)) {
      missing.push_back(name);
    }
  }
  auto changed = nlohmann::json::array();
  for (const auto &name : dimensions) {
    if (before.contains(name) && after.contains(name) && before.at(name) != after.at(name)) {
      changed.push_back(name);
    }
  }

  nlohmann::json result;
  result["schema"] = ACTION_GEOMETRY_SESSION_EVALUATION_V1;
  result["geometryRoot"] = contract.root;
  result["preserved"] = missing.empty() && changed.empty();
  result["missingDimensions"] = missing;
  result["changedDimensions"] = changed;
  return result;
}

} // namespace kungfu::runtime::action
