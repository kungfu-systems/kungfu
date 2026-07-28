// SPDX-License-Identifier: Apache-2.0

#include <kungfu/runtime/kfx/native_registry.h>

#include <algorithm>
#include <cctype>
#include <chrono>
#include <filesystem>
#include <fstream>
#include <functional>
#include <map>
#include <optional>
#include <set>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>

#include <kungfu/runtime/kfx/native_contract.h>
#include <kungfu/runtime/profile/profile_lifecycle.h>
#include <kungfu/runtime/profile/profile_source_contract.h>
#include <kungfu/runtime/storage/fact_kernel.h>
#include <kungfu/yijinjing/storage/content_hash.h>

#include "native_authority.h"

namespace kungfu::runtime::kfx {

namespace {

namespace fs = std::filesystem;
using json = nlohmann::json;

inline constexpr size_t MAX_PACKAGE_FILES = 10000;
inline constexpr size_t MAX_PACKAGES = 4096;
inline constexpr const char *KFX_MANIFEST_FILE = "kungfu.kfx.json";
inline constexpr const char *PACKAGE_TRANSPORT_FILE = "package.json";

[[noreturn]] void refuse(const std::string &code, const std::string &message) {
  throw std::invalid_argument(code + ": " + message);
}

std::string sha256(const std::string &value) {
  return yijinjing::storage::compute_content_hash_value(value, yijinjing::storage::CONTENT_HASH_ALGORITHM_SHA256);
}

std::string root_of(const json &value) { return "sha256:" + sha256(value.dump()); }

json embedded_domain_profile() {
  const auto &source = generated::KFX_DOMAIN_PROFILE_CONTRACT;
  return json::parse(source.begin(), source.end());
}

std::string read_file(const fs::path &path) {
  std::ifstream input(path, std::ios::binary);
  if (!input)
    refuse("KF_KFX_SCHEMA_INVALID", "cannot read KFX file: " + path.string());
  return std::string(std::istreambuf_iterator<char>(input), std::istreambuf_iterator<char>());
}

bool safe_token(const std::string &value) {
  return !value.empty() && value.size() <= 128 && std::all_of(value.begin(), value.end(), [](unsigned char ch) {
    return std::isalnum(ch) != 0 || ch == '-' || ch == '_' || ch == '.';
  });
}

std::string required_text(const json &value, const char *field, const std::string &path) {
  if (!value.is_object() || !value.contains(field) || !value.at(field).is_string() ||
      value.at(field).get<std::string>().empty()) {
    refuse("KF_KFX_SCHEMA_INVALID", path + "." + field + " must be a non-empty string");
  }
  return value.at(field).get<std::string>();
}

json object_or_empty(const json &value, const char *field) {
  if (!value.is_object() || !value.contains(field) || value.at(field).is_null())
    return json::object();
  if (!value.at(field).is_object())
    refuse("KF_KFX_SCHEMA_INVALID", std::string(field) + " must be an object");
  return value.at(field);
}

std::vector<std::string> string_array_or_empty(const json &value, const char *field) {
  if (!value.is_object() || !value.contains(field) || value.at(field).is_null())
    return {};
  if (!value.at(field).is_array())
    refuse("KF_KFX_SCHEMA_INVALID", std::string(field) + " must be an array");
  std::vector<std::string> result;
  for (const auto &entry : value.at(field)) {
    if (!entry.is_string() || entry.get<std::string>().empty())
      refuse("KF_KFX_SCHEMA_INVALID", std::string(field) + " must contain non-empty strings");
    result.push_back(entry.get<std::string>());
  }
  std::sort(result.begin(), result.end());
  if (std::adjacent_find(result.begin(), result.end()) != result.end())
    refuse("KF_KFX_SCHEMA_INVALID", std::string(field) + " must not contain duplicates");
  return result;
}

bool ignored_part(const fs::path &part) {
  static const std::set<std::string> ignored = {".git", "node_modules", "__pycache__", ".DS_Store"};
  return ignored.contains(part.string());
}

json package_closure(const fs::path &package_path) {
  json files = json::array();
  std::error_code error;
  fs::recursive_directory_iterator iterator(package_path, fs::directory_options::skip_permission_denied, error);
  fs::recursive_directory_iterator end;
  if (error)
    refuse("KF_KFX_SCHEMA_INVALID", "cannot scan KFX package: " + package_path.string());
  for (; iterator != end; iterator.increment(error)) {
    if (error)
      refuse("KF_KFX_SCHEMA_INVALID", "cannot scan KFX package: " + error.message());
    const auto relative = iterator->path().lexically_relative(package_path);
    const auto ignored = std::any_of(relative.begin(), relative.end(), ignored_part);
    if (ignored) {
      if (iterator->is_directory(error))
        iterator.disable_recursion_pending();
      continue;
    }
    if (iterator->is_symlink(error))
      refuse("KF_KFX_PATH_TRAVERSAL", "KFX package closure cannot contain symlinks: " + relative.generic_string());
    if (!iterator->is_regular_file(error))
      continue;
    const auto bytes = read_file(iterator->path());
    files.push_back({{"path", relative.generic_string()}, {"sha256", sha256(bytes)}, {"size", bytes.size()}});
    if (files.size() > MAX_PACKAGE_FILES)
      refuse("KF_KFX_SCHEMA_INVALID", "KFX package exceeds the bounded file count");
  }
  std::sort(files.begin(), files.end(), [](const auto &left, const auto &right) {
    return left.at("path").template get<std::string>() < right.at("path").template get<std::string>();
  });
  if (files.empty())
    refuse("KF_KFX_CLOSURE_MISSING", "KFX package closure is empty: " + package_path.string());
  return {{"schema", "kungfu.kfx-package-closure/v1"}, {"files", files}};
}

void validate_relative_path(const fs::path &root, const std::string &relative, const std::string &label) {
  const fs::path value(relative);
  if (relative.empty() || value.is_absolute())
    refuse("KF_KFX_PATH_TRAVERSAL", label + " must be a confined relative path");
  for (const auto &part : value) {
    if (part == "..")
      refuse("KF_KFX_PATH_TRAVERSAL", label + " escapes the package root");
  }
  const auto candidate = fs::weakly_canonical(root / value);
  auto root_it = root.begin();
  auto candidate_it = candidate.begin();
  for (; root_it != root.end(); ++root_it, ++candidate_it) {
    if (candidate_it == candidate.end() || *root_it != *candidate_it)
      refuse("KF_KFX_PATH_TRAVERSAL", label + " escapes the package root");
  }
  if (!fs::is_regular_file(candidate))
    refuse("KF_KFX_CLOSURE_MISSING", label + " does not resolve to a regular file");
}

std::vector<std::string> declared_facets(const json &manifest, const fs::path &package_path) {
  const auto config = object_or_empty(manifest.at("kungfuConfig"), "config");
  std::vector<std::string> facets;
  for (const auto *facet : {"view", "adapter", "service", "wasm"}) {
    if (!config.contains(facet))
      continue;
    if (!config.at(facet).is_object())
      refuse("KF_KFX_SCHEMA_INVALID", std::string("kungfuConfig.config.") + facet + " must be an object");
    facets.emplace_back(facet);
    const auto &declaration = config.at(facet);
    if (declaration.contains("entry")) {
      if (declaration.at("entry").is_string()) {
        validate_relative_path(package_path, declaration.at("entry").get<std::string>(),
                               std::string("kungfuConfig.config.") + facet + ".entry");
      } else if (declaration.at("entry").is_object()) {
        for (const auto &[runtime, entry] : declaration.at("entry").items()) {
          if (entry.is_string())
            validate_relative_path(package_path, entry.get<std::string>(),
                                   std::string("kungfuConfig.config.") + facet + ".entry." + runtime);
        }
      }
    }
  }
  if (manifest.at("kungfuConfig").contains("suite"))
    facets.emplace_back("profile-suite");
  std::sort(facets.begin(), facets.end());
  return facets;
}

std::vector<std::string> declared_capabilities(const json &manifest) {
  std::set<std::string> capabilities;
  const auto config = object_or_empty(manifest.at("kungfuConfig"), "config");
  for (const auto *facet : {"view", "adapter", "service", "wasm"}) {
    if (!config.contains(facet) || !config.at(facet).is_object() || !config.at(facet).contains("capabilities"))
      continue;
    if (!config.at(facet).at("capabilities").is_array())
      refuse("KF_KFX_SCHEMA_INVALID", std::string("kungfuConfig.config.") + facet + ".capabilities must be an array");
    for (const auto &capability : config.at(facet).at("capabilities")) {
      if (!capability.is_string() || capability.get<std::string>().empty())
        refuse("KF_KFX_SCHEMA_INVALID", "declared capability must be a non-empty string");
      capabilities.insert(capability.get<std::string>());
    }
  }
  return {capabilities.begin(), capabilities.end()};
}

std::vector<std::string> declared_product_roles(const json &manifest) {
  const auto product = object_or_empty(manifest.at("kungfuConfig"), "product");
  const auto roles = string_array_or_empty(product, "roles");
  return roles;
}

std::vector<fs::path> package_directories(const fs::path &root) {
  std::set<fs::path> result;
  if (fs::is_regular_file(root / KFX_MANIFEST_FILE) || fs::is_regular_file(root / PACKAGE_TRANSPORT_FILE))
    result.insert(root);
  std::error_code error;
  fs::recursive_directory_iterator iterator(root, fs::directory_options::skip_permission_denied, error);
  fs::recursive_directory_iterator end;
  for (; !error && iterator != end; iterator.increment(error)) {
    if (iterator.depth() >= 3 && iterator->is_directory(error))
      iterator.disable_recursion_pending();
    if (!iterator->is_directory(error))
      continue;
    if (iterator->is_symlink(error) || iterator->path().filename() == "node_modules") {
      iterator.disable_recursion_pending();
      continue;
    }
    if (fs::is_regular_file(iterator->path() / KFX_MANIFEST_FILE, error) ||
        fs::is_regular_file(iterator->path() / PACKAGE_TRANSPORT_FILE, error))
      result.insert(fs::weakly_canonical(iterator->path()));
  }
  if (error)
    refuse("KF_KFX_SCHEMA_INVALID", "cannot scan KFX root: " + root.string() + ": " + error.message());
  return {result.begin(), result.end()};
}

struct snapshot {
  json packages = json::array();
  json suites = json::array();
  json diagnostics = json::array();
  json graph = json::object();
  std::string registry_root;
  std::string graph_root;
};

void validate_enum(const std::string &value, const std::set<std::string> &allowed, const std::string &label) {
  if (!allowed.contains(value))
    refuse("KF_KFX_SCHEMA_INVALID", label + " is not supported: " + value);
}

json host_placements(const json &manifest) {
  std::set<std::string> hosts;
  const auto config = object_or_empty(manifest.at("kungfuConfig"), "config");
  if (config.contains("view"))
    hosts.insert("gui");
  for (const auto *facet : {"adapter", "service"}) {
    if (!config.contains(facet) || !config.at(facet).is_object())
      continue;
    for (const auto &runtime : string_array_or_empty(config.at(facet), "runtimes"))
      hosts.insert(std::string(facet) + "-" + runtime);
  }
  if (config.contains("wasm"))
    hosts.insert("wasm");
  if (manifest.at("kungfuConfig").contains("suite"))
    hosts.insert("profile");
  return json(hosts);
}

json find_package(const json &packages, const std::string &key) {
  for (const auto &package : packages) {
    if (package.at("key") == key)
      return package;
  }
  return nullptr;
}

void detect_suite_cycles(const json &packages) {
  std::map<std::string, std::vector<std::string>> graph;
  for (const auto &package : packages) {
    if (!package.contains("suiteMembers"))
      continue;
    auto &edges = graph[package.at("key").get<std::string>()];
    for (const auto &member : package.at("suiteMembers")) {
      const auto nested = find_package(packages, member.get<std::string>());
      if (!nested.is_null() && nested.contains("suiteMembers"))
        edges.push_back(member.get<std::string>());
    }
  }
  std::set<std::string> active;
  std::set<std::string> complete;
  std::function<void(const std::string &)> visit = [&](const std::string &key) {
    if (active.contains(key))
      refuse("KF_KFX_SUITE_CYCLE", "KFX Suite membership cycle includes " + key);
    if (complete.contains(key))
      return;
    active.insert(key);
    for (const auto &next : graph[key])
      visit(next);
    active.erase(key);
    complete.insert(key);
  };
  for (const auto &[key, ignored] : graph) {
    (void)ignored;
    visit(key);
  }
}

bool version_matches(const std::string &version, const std::string &constraint) {
  if (constraint == "*")
    return true;
  if (constraint.starts_with("^")) {
    const auto expected = constraint.substr(1, constraint.find('.') - 1);
    return version.substr(0, version.find('.')) == expected;
  }
  if (constraint.ends_with(".*"))
    return version.starts_with(constraint.substr(0, constraint.size() - 1));
  return version == constraint;
}

json semantic_graph(const json &packages, json &diagnostics) {
  json providers = json::array();
  json extension_points = json::array();
  json contributions = json::array();
  json dependencies = json::array();
  std::map<std::string, json> provider_by_id;
  std::map<std::string, json> extension_point_by_id;
  std::map<std::string, std::string> provider_state;

  for (const auto &package : packages) {
    const auto provider_id = package.at("key").get<std::string>();
    const auto capabilities = package.at("declaredCapabilities");
    const json trust_identity = {{"runtimeTier", package.at("runtimeTier")},
                                 {"admissionGrade", package.at("admissionGrade")}};
    const auto trust_root = root_of(trust_identity);
    const auto capability_root = root_of(capabilities);
    const json identity = {{"providerId", provider_id},
                           {"version", package.at("version")},
                           {"packageRoot", package.at("packageRoot")},
                           {"trustRoot", trust_root},
                           {"capabilityRoot", capability_root}};
    json provider = identity;
    provider["providerRoot"] = root_of(identity);
    provider["trust"] = trust_identity;
    provider["capabilities"] = capabilities;
    provider["state"] = "active";
    provider["causes"] = json::array();
    provider["recoveryGuidance"] = json::array();
    providers.push_back(provider);
    provider_by_id[provider_id] = provider;
    provider_state[provider_id] = "active";
  }

  auto add_diagnostic = [&](const std::string &code, const std::string &provider_id, const std::string &cause,
                            const std::string &recovery, const std::string &severity) {
    diagnostics.push_back({{"code", code},
                           {"providerId", provider_id},
                           {"cause", cause},
                           {"recoveryGuidance", json::array({recovery})},
                           {"severity", severity}});
    if (severity == "degraded")
      provider_state[provider_id] = "degraded";
  };

  for (const auto &package : packages) {
    const auto provider_id = package.at("key").get<std::string>();
    const auto semantic = package.at("semantic");
    const auto points = semantic.value("extensionPoints", json::array());
    for (const auto &declaration : points) {
      const auto point_id = required_text(declaration, "id", "kungfuConfig.registry.extensionPoints[]");
      if (!safe_token(point_id))
        refuse("KF_KFX_SCHEMA_INVALID", "extension point id is not a safe token");
      if (extension_point_by_id.contains(point_id))
        refuse("KF_KFX_OWNER_DUPLICATE", "one extension point may have only one owner: " + point_id);
      const auto capabilities = declaration.value("capabilities", json::array());
      const json identity = {{"ownerProviderId", provider_id},
                             {"extensionPointId", point_id},
                             {"version", declaration.at("version")},
                             {"surface", declaration.at("surface")},
                             {"capabilityRoot", root_of(capabilities)}};
      json point = identity;
      point["extensionPointRoot"] = root_of(identity);
      point["capabilities"] = capabilities;
      point["state"] = "active";
      extension_points.push_back(point);
      extension_point_by_id[point_id] = point;
    }
  }

  std::map<std::string, std::vector<std::string>> dependency_graph;
  for (const auto &package : packages) {
    const auto consumer_id = package.at("key").get<std::string>();
    const auto declarations = package.at("semantic").value("dependencies", json::array());
    for (const auto &declaration : declarations) {
      const auto provider_id = required_text(declaration, "provider", "kungfuConfig.registry.dependencies[]");
      const auto mode = required_text(declaration, "mode", "kungfuConfig.registry.dependencies[]");
      const auto constraint = required_text(declaration, "version", "kungfuConfig.registry.dependencies[]");
      const auto capabilities = declaration.value("capabilities", json::array());
      const auto grades = declaration.value("admissionGrades", json::array());
      const json identity = {
          {"consumerProviderId", consumer_id},      {"providerId", provider_id},
          {"versionConstraint", constraint},        {"mode", mode},
          {"trustConstraintRoot", root_of(grades)}, {"capabilityConstraintRoot", root_of(capabilities)}};
      json edge = identity;
      edge["dependencyRoot"] = root_of(identity);
      edge["state"] = "active";
      edge["causes"] = json::array();
      edge["recoveryGuidance"] = json::array();
      if (!provider_by_id.contains(provider_id)) {
        const auto code = mode == "required" ? "KF_KFX_REQUIRED_PROVIDER_MISSING" : "KF_KFX_OPTIONAL_PROVIDER_MISSING";
        edge["state"] = mode == "required" ? "degraded" : "dormant";
        edge["causes"].push_back(code);
        edge["recoveryGuidance"].push_back("install-provider:" + provider_id);
        add_diagnostic(code, consumer_id, "provider is absent: " + provider_id, "install-provider:" + provider_id,
                       mode == "required" ? "degraded" : "dormant");
      } else {
        const auto &provider = provider_by_id.at(provider_id);
        if (!version_matches(provider.at("version").get<std::string>(), constraint)) {
          edge["state"] = mode == "required" ? "degraded" : "dormant";
          edge["causes"].push_back("KF_KFX_PROVIDER_VERSION_MISMATCH");
          edge["recoveryGuidance"].push_back("install-compatible-provider:" + provider_id + "@" + constraint);
          add_diagnostic("KF_KFX_PROVIDER_VERSION_MISMATCH", consumer_id,
                         "provider version does not satisfy " + constraint + ": " + provider_id,
                         "install-compatible-provider:" + provider_id + "@" + constraint,
                         mode == "required" ? "degraded" : "dormant");
        }
        for (const auto &capability : capabilities) {
          if (std::find(provider.at("capabilities").begin(), provider.at("capabilities").end(), capability) ==
              provider.at("capabilities").end()) {
            edge["state"] = mode == "required" ? "degraded" : "dormant";
            edge["causes"].push_back("KF_KFX_CAPABILITY_BROADENING");
            edge["recoveryGuidance"].push_back("use-provider-with-declared-capability:" +
                                               capability.get<std::string>());
            add_diagnostic("KF_KFX_CAPABILITY_BROADENING", consumer_id,
                           "dependency capability is not declared by provider: " + capability.get<std::string>(),
                           "use-provider-with-declared-capability:" + capability.get<std::string>(),
                           mode == "required" ? "degraded" : "dormant");
          }
        }
        if (!grades.empty() &&
            std::find(grades.begin(), grades.end(), provider.at("trust").at("admissionGrade")) == grades.end()) {
          edge["state"] = mode == "required" ? "degraded" : "dormant";
          edge["causes"].push_back("KF_KFX_TRUST_CONSTRAINT_REJECTED");
          edge["recoveryGuidance"].push_back("admit-exact-provider-root:" + provider_id);
          add_diagnostic("KF_KFX_TRUST_CONSTRAINT_REJECTED", consumer_id,
                         "provider admission grade is outside the dependency constraint: " + provider_id,
                         "admit-exact-provider-root:" + provider_id, mode == "required" ? "degraded" : "dormant");
        }
        dependency_graph[consumer_id].push_back(provider_id);
      }
      dependencies.push_back(edge);
    }
  }

  std::set<std::string> visiting;
  std::set<std::string> visited;
  std::set<std::string> cycle_members;
  std::function<void(const std::string &)> visit = [&](const std::string &provider_id) {
    if (visiting.contains(provider_id)) {
      cycle_members.insert(provider_id);
      return;
    }
    if (visited.contains(provider_id))
      return;
    visiting.insert(provider_id);
    for (const auto &dependency : dependency_graph[provider_id]) {
      if (visiting.contains(dependency)) {
        cycle_members.insert(provider_id);
        cycle_members.insert(dependency);
      } else {
        visit(dependency);
      }
    }
    visiting.erase(provider_id);
    visited.insert(provider_id);
  };
  for (const auto &[provider_id, ignored] : dependency_graph) {
    (void)ignored;
    visit(provider_id);
  }
  for (const auto &provider_id : cycle_members)
    add_diagnostic("KF_KFX_DEPENDENCY_CYCLE", provider_id, "semantic provider dependency cycle",
                   "remove-or-relax-cyclic-dependency", "degraded");
  for (auto &edge : dependencies) {
    if (cycle_members.contains(edge.at("consumerProviderId").get<std::string>()) &&
        cycle_members.contains(edge.at("providerId").get<std::string>())) {
      edge["state"] = "degraded";
      edge["causes"].push_back("KF_KFX_DEPENDENCY_CYCLE");
      edge["recoveryGuidance"].push_back("remove-or-relax-cyclic-dependency");
    }
  }

  std::set<std::string> contribution_ids;
  for (const auto &package : packages) {
    const auto provider_id = package.at("key").get<std::string>();
    const auto declarations = package.at("semantic").value("contributions", json::array());
    for (const auto &declaration : declarations) {
      const auto contribution_id = required_text(declaration, "id", "kungfuConfig.registry.contributions[]");
      const auto point_id = required_text(declaration, "extensionPoint", "kungfuConfig.registry.contributions[]");
      const auto canonical_id = provider_id + ":" + contribution_id;
      if (!contribution_ids.insert(canonical_id).second)
        refuse("KF_KFX_OWNER_DUPLICATE", "duplicate contribution identity: " + canonical_id);
      const auto capabilities = declaration.value("capabilities", json::array());
      const json identity = {{"ownerProviderId", provider_id},
                             {"contributionId", contribution_id},
                             {"extensionPointId", point_id},
                             {"version", declaration.at("version")},
                             {"capabilityRoot", root_of(capabilities)}};
      json contribution = identity;
      contribution["contributionRoot"] = root_of(identity);
      contribution["capabilities"] = capabilities;
      contribution["presentation"] = declaration.value("presentation", json::object());
      contribution["state"] = provider_state.at(provider_id);
      contribution["causes"] = json::array();
      contribution["recoveryGuidance"] = json::array();
      if (!extension_point_by_id.contains(point_id)) {
        contribution["state"] = "degraded";
        contribution["causes"].push_back("KF_KFX_EXTENSION_POINT_MISSING");
        contribution["recoveryGuidance"].push_back("install-extension-point-owner:" + point_id);
        add_diagnostic("KF_KFX_EXTENSION_POINT_MISSING", provider_id, "contribution target is absent: " + point_id,
                       "install-extension-point-owner:" + point_id, "degraded");
      } else {
        const auto &point = extension_point_by_id.at(point_id);
        contribution["extensionPointRoot"] = point.at("extensionPointRoot");
        contribution["targetOwnerProviderId"] = point.at("ownerProviderId");
        contribution["surface"] = point.at("surface");
        if (!version_matches(point.at("version").get<std::string>(), declaration.at("version").get<std::string>())) {
          contribution["state"] = "degraded";
          contribution["causes"].push_back("KF_KFX_PROVIDER_VERSION_MISMATCH");
          contribution["recoveryGuidance"].push_back("target-compatible-extension-point:" + point_id);
          add_diagnostic("KF_KFX_PROVIDER_VERSION_MISMATCH", provider_id,
                         "extension point version does not satisfy contribution constraint: " + point_id,
                         "target-compatible-extension-point:" + point_id, "degraded");
        }
        for (const auto &capability : capabilities) {
          if (std::find(package.at("declaredCapabilities").begin(), package.at("declaredCapabilities").end(),
                        capability) == package.at("declaredCapabilities").end()) {
            contribution["state"] = "degraded";
            contribution["causes"].push_back("KF_KFX_CAPABILITY_BROADENING");
            contribution["recoveryGuidance"].push_back("declare-contribution-capability:" +
                                                       capability.get<std::string>());
            add_diagnostic("KF_KFX_CAPABILITY_BROADENING", provider_id,
                           "contribution capability is not declared by its provider: " + capability.get<std::string>(),
                           "declare-contribution-capability:" + capability.get<std::string>(), "degraded");
          }
        }
      }
      contributions.push_back(contribution);
    }
  }

  for (auto &provider : providers) {
    const auto provider_id = provider.at("providerId").get<std::string>();
    provider["state"] = provider_state.at(provider_id);
    for (const auto &diagnostic : diagnostics) {
      if (diagnostic.value("providerId", "") != provider_id)
        continue;
      provider["causes"].push_back(diagnostic.at("code"));
      for (const auto &guidance : diagnostic.at("recoveryGuidance"))
        provider["recoveryGuidance"].push_back(guidance);
    }
    std::sort(provider["causes"].begin(), provider["causes"].end());
    std::sort(provider["recoveryGuidance"].begin(), provider["recoveryGuidance"].end());
  }
  auto sort_by = [](json &values, const char *field) {
    std::sort(values.begin(), values.end(), [field](const auto &left, const auto &right) {
      return left.at(field).template get<std::string>() < right.at(field).template get<std::string>();
    });
  };
  sort_by(providers, "providerRoot");
  sort_by(extension_points, "extensionPointRoot");
  sort_by(contributions, "contributionRoot");
  sort_by(dependencies, "dependencyRoot");
  const json identity = {{"schema", "kungfu.kfx.semantic-graph/v1"},
                         {"providers", providers},
                         {"extensionPoints", extension_points},
                         {"contributions", contributions},
                         {"dependencies", dependencies}};
  auto graph = identity;
  graph["graphRoot"] = root_of(identity);
  return graph;
}

snapshot build_snapshot(const json &request) {
  if (!request.is_object() || !request.contains("roots") || !request.at("roots").is_array() ||
      request.at("roots").empty())
    refuse("KF_KFX_SCHEMA_INVALID", "registry request requires explicit non-empty roots");
  for (const auto *field : {"runtimeTier", "runtimeTiers", "hostPlacements", "admissionGrade", "admissionGrades",
                            "productSystem", "installed", "admitted", "systemAuthority", "grantedCapabilities"}) {
    if (request.contains(field))
      refuse("KF_KFX_AUTHORITY_CLAIM_FORBIDDEN",
             std::string("registry request may not claim Core-derived authority field ") + field);
  }
  const std::set<std::string> root_kinds = {"product", "user", "workspace"};

  snapshot result;
  std::set<fs::path> seen_roots;
  std::set<fs::path> seen_packages;
  std::map<std::string, fs::path> keys;
  for (const auto &root_value : request.at("roots")) {
    const auto kind = required_text(root_value, "kind", "roots[]");
    validate_enum(kind, root_kinds, "root kind");
    const auto root = fs::weakly_canonical(required_text(root_value, "path", "roots[]"));
    if (!fs::is_directory(root))
      refuse("KF_KFX_SCHEMA_INVALID", "KFX root is not a directory: " + root.string());
    if (!seen_roots.insert(root).second)
      refuse("KF_KFX_ROOT_COLLISION", "multiple root declarations resolve to " + root.string());
    for (const auto &package_path : package_directories(root)) {
      if (!seen_packages.insert(package_path).second)
        continue;
      const auto manifest_path = package_path / KFX_MANIFEST_FILE;
      const auto package_transport_path = package_path / PACKAGE_TRANSPORT_FILE;
      bool package_transport_claims_kfx = false;
      if (fs::is_regular_file(package_transport_path)) {
        try {
          const auto package_transport = json::parse(read_file(package_transport_path));
          package_transport_claims_kfx = package_transport.is_object() && package_transport.contains("kungfuConfig");
        } catch (const json::exception &) {
          // Transport validation belongs to the package manager. It becomes a
          // KFX concern only when it claims the removed semantic authority.
        }
      }
      if (package_transport_claims_kfx) {
        refuse(fs::is_regular_file(manifest_path) ? "KF_KFX_MANIFEST_CONFLICT" : "KF_KFX_MANIFEST_MISSING",
               "package.json must not author kungfuConfig; kungfu.kfx.json is the only KFX manifest authority");
      }
      if (!fs::is_regular_file(manifest_path))
        continue;
      const auto manifest_bytes = read_file(manifest_path);
      json manifest;
      try {
        manifest = json::parse(manifest_bytes);
      } catch (const json::exception &error) {
        refuse("KF_KFX_SCHEMA_INVALID", "invalid KFX package manifest: " + std::string(error.what()));
      }
      if (!manifest.is_object() || !manifest.contains("kungfuConfig") || !manifest.at("kungfuConfig").is_object())
        continue;
      manifest = normalize_native_kfx_manifest(manifest);
      const auto key = required_text(manifest.at("kungfuConfig"), "key", "kungfuConfig");
      if (!safe_token(key))
        refuse("KF_KFX_SCHEMA_INVALID", "kungfuConfig.key is not a safe KFX token");
      if (keys.contains(key))
        refuse("KF_KFX_PACKAGE_DUPLICATE", "KFX package key resolves more than once: " + key);
      keys[key] = package_path;
      const auto closure = package_closure(package_path);
      const auto native_contract = native_kfx_contract();
      json package = {{"key", key},
                      {"name", manifest.value("name", "")},
                      {"version", manifest.value("version", "")},
                      {"path", package_path.string()},
                      {"rootKind", kind},
                      {"manifestRoot", root_of(manifest)},
                      {"apiCompatibility",
                       {{"sourceContractSchema", native_contract.at("sourceContractSchema")},
                        {"sourceContractVersion", native_contract.at("sourceContractVersion")},
                        {"nativeContractVersion", native_contract.at("contractVersion")},
                        {"compatible", true}}},
                      {"packageRoot", root_of(closure)},
                      {"closure", closure},
                      {"facets", declared_facets(manifest, package_path)},
                      {"declaredCapabilities", declared_capabilities(manifest)},
                      {"productRoles", declared_product_roles(manifest)},
                      {"runtimeTier", "isolated"},
                      {"admissionGrade", "unverified"},
                      {"supplyChainGrade", "unverified"},
                      {"productSystem", false},
                      {"grantedCapabilities", json::array()},
                      {"hosts", host_placements(manifest)},
                      {"semantic", object_or_empty(manifest.at("kungfuConfig"), "registry")},
                      {"candidate", true},
                      {"installed", false},
                      {"admitted", false}};
      if (manifest.at("kungfuConfig").contains("suite")) {
        const auto &suite = manifest.at("kungfuConfig").at("suite");
        if (!suite.is_object() || !suite.contains("members") || !suite.at("members").is_array())
          refuse("KF_KFX_SCHEMA_INVALID", "KFX Suite must declare members");
        package["suiteMembers"] = suite.at("members");
        if (suite.contains("profile")) {
          const auto relative = required_text(suite, "profile", "kungfuConfig.suite");
          validate_relative_path(package_path, relative, "kungfuConfig.suite.profile");
          package["profilePath"] = fs::weakly_canonical(package_path / relative).string();
        }
      }
      result.packages.push_back(package);
      if (result.packages.size() > MAX_PACKAGES)
        refuse("KF_KFX_SCHEMA_INVALID", "KFX registry exceeds the bounded package count");
    }
  }
  std::sort(result.packages.begin(), result.packages.end(), [](const auto &left, const auto &right) {
    return left.at("key").template get<std::string>() < right.at("key").template get<std::string>();
  });
  detect_suite_cycles(result.packages);

  for (const auto &package : result.packages) {
    if (!package.contains("suiteMembers"))
      continue;
    std::vector<std::string> declared;
    for (const auto &member : package.at("suiteMembers")) {
      if (!member.is_string() || !safe_token(member.get<std::string>()))
        refuse("KF_KFX_SCHEMA_INVALID", "KFX Suite members must be safe tokens");
      declared.push_back(member.get<std::string>());
    }
    std::sort(declared.begin(), declared.end());
    if (std::adjacent_find(declared.begin(), declared.end()) != declared.end())
      refuse("KF_KFX_SCHEMA_INVALID", "KFX Suite members must be unique");
    json required = declared;
    json optional = json::array();
    json profile = nullptr;
    if (package.contains("profilePath")) {
      profile = json::parse(read_file(package.at("profilePath").get<std::string>()));
      if (!profile.is_object() || !profile.contains("members") || !profile.at("members").is_object())
        refuse("KF_KFX_SCHEMA_INVALID", "KFX Profile Suite must declare required and optional members");
      required = profile.at("members").value("required", json::array());
      optional = profile.at("members").value("optional", json::array());
      std::vector<std::string> profile_members;
      for (const auto *kind : {"required", "optional"}) {
        if (!profile.at("members").contains(kind) || !profile.at("members").at(kind).is_array())
          refuse("KF_KFX_SCHEMA_INVALID", std::string("Profile members.") + kind + " must be an array");
        for (const auto &member : profile.at("members").at(kind))
          profile_members.push_back(member.get<std::string>());
      }
      std::sort(profile_members.begin(), profile_members.end());
      if (profile_members != declared)
        refuse("KF_KFX_SCHEMA_INVALID", "Profile members must match the Suite manifest");
    }
    json member_roots = json::object();
    json missing_optional = json::array();
    for (const auto &member : required) {
      const auto found = find_package(result.packages, member.get<std::string>());
      if (found.is_null())
        refuse("KF_KFX_MEMBER_MISSING", "required KFX Suite member is missing: " + member.get<std::string>());
      member_roots[member.get<std::string>()] = found.at("packageRoot");
    }
    for (const auto &member : optional) {
      const auto found = find_package(result.packages, member.get<std::string>());
      if (found.is_null())
        missing_optional.push_back(member);
      else
        member_roots[member.get<std::string>()] = found.at("packageRoot");
    }
    json profile_root = nullptr;
    if (package.contains("profilePath") && missing_optional.empty()) {
      profile_root =
          profile::inspect_profile(package.at("profilePath").get<std::string>(), member_roots).at("profile_suite_root");
    }
    if (!missing_optional.empty())
      result.diagnostics.push_back({{"code", "KF_KFX_OPTIONAL_MEMBER_MISSING"},
                                    {"suiteKey", package.at("key")},
                                    {"members", missing_optional},
                                    {"severity", "degraded"}});
    json suite_identity = {{"schema", "kungfu.kfx-suite-closure/v1"},
                           {"suiteKey", package.at("key")},
                           {"suitePackageRoot", package.at("packageRoot")},
                           {"required", required},
                           {"optional", optional},
                           {"memberRoots", member_roots},
                           {"missingOptional", missing_optional},
                           {"profileRoot", profile_root}};
    result.suites.push_back({{"suiteKey", package.at("key")},
                             {"suiteRoot", root_of(suite_identity)},
                             {"profileRoot", profile_root},
                             {"required", required},
                             {"optional", optional},
                             {"memberRoots", member_roots},
                             {"missingOptional", missing_optional}});
  }

  result.graph = semantic_graph(result.packages, result.diagnostics);
  result.graph_root = result.graph.at("graphRoot").get<std::string>();

  json package_identity = json::array();
  for (const auto &package : result.packages) {
    package_identity.push_back(
        {{"key", package.at("key")},
         {"rootKind", package.at("rootKind")},
         {"packageRoot", package.at("packageRoot")},
         {"manifestRoot", package.at("manifestRoot")},
         {"apiCompatibility", package.at("apiCompatibility")},
         {"facets", package.at("facets")},
         {"runtimeTier", package.at("runtimeTier")},
         {"admissionGrade", package.at("admissionGrade")},
         {"productSystem", package.at("productSystem")},
         {"grantedCapabilities", package.at("grantedCapabilities")},
         {"capabilityGrantRoot",
          package.contains("authority") ? package.at("authority").at("capabilityGrantRoot") : json(nullptr)},
         {"hosts", package.at("hosts")}});
  }
  json registry_identity = {{"schema", "kungfu.kfx-registry-snapshot/v2"},
                            {"packages", package_identity},
                            {"suites", result.suites},
                            {"diagnostics", result.diagnostics}};
  result.registry_root = root_of(registry_identity);
  if (request.contains("expectedRegistryRoot") &&
      (!request.at("expectedRegistryRoot").is_string() || request.at("expectedRegistryRoot") != result.registry_root))
    refuse("KF_KFX_REGISTRY_STALE", "registry content changed since the caller's expected root");
  return result;
}

json public_package(json package) {
  package.erase("closure");
  package.erase("suiteMembers");
  package.erase("profilePath");
  package.erase("semantic");
  return package;
}

json assess_package(const json &package, const std::string &registry_root, const json &request) {
  return authority::assess(package, registry_root, request);
}

inline constexpr const char *KFX_REGISTRY_REF = "profiles/kfx/registry";
inline constexpr const char *KFX_PROFILE_ID = "kungfu-kfx-domain-profile";

struct lifecycle_view {
  bool present = false;
  uint64_t revision = 0;
  std::string cut_root;
  json cut = json::object();
  snapshot authoritative;
  std::map<std::string, std::string> desired_states;
  std::map<std::string, std::string> observed_states;
  json work_history = json::array();
  std::map<std::string, std::string> current_versions;
  std::set<std::string> relation_roots;
};

fs::path lifecycle_root(const std::string &runtime_dir) {
  if (runtime_dir.empty())
    refuse("KF_KFX_SCHEMA_INVALID", "native KFX lifecycle requires an explicit runtime directory");
  return fs::absolute(runtime_dir) / "kfx";
}

json fact_call(const std::string &runtime_dir, const std::string &action, json request) {
  request["action"] = action;
  auto response = storage_service_api::run_fact_kernel_operation(runtime_dir, request);
  if (!response.value("ok", false)) {
    refuse(action == "ref-cas" && response.value("failure_code", "") == "stale-ref" ? "KF_KFX_CUT_STALE"
                                                                                    : "KF_KFX_FACT_REJECTED",
           response.value("failure_code", "unknown") + ": " + response.value("message", "Fact kernel rejected KFX"));
  }
  return response;
}

std::string fact_id(const std::string &kind, const std::string &identity) {
  return "fact:" + sha256(std::string(KFX_PROFILE_ID) + ":" + kind + ":" + identity).substr(0, 32);
}

std::string relation_id(const std::string &kind, const std::string &source, const std::string &target) {
  return fact_id("relation", kind + ":" + source + ":" + target);
}

json snapshot_projection(const snapshot &value) {
  return {{"packages", value.packages},          {"suites", value.suites},
          {"diagnostics", value.diagnostics},    {"graph", value.graph},
          {"registryRoot", value.registry_root}, {"graphRoot", value.graph_root}};
}

snapshot snapshot_from_projection(const json &value) {
  if (!value.is_object() || !value.contains("packages") || !value.at("packages").is_array() ||
      !value.contains("suites") || !value.at("suites").is_array() || !value.contains("diagnostics") ||
      !value.at("diagnostics").is_array() || !value.contains("graph") || !value.at("graph").is_object() ||
      !value.contains("registryRoot") || !value.at("registryRoot").is_string() || !value.contains("graphRoot") ||
      !value.at("graphRoot").is_string())
    refuse("KF_KFX_SCHEMA_INVALID", "KFX registry projection Fact body is incomplete");
  snapshot result;
  result.packages = value.at("packages");
  result.suites = value.at("suites");
  result.diagnostics = value.at("diagnostics");
  result.graph = value.at("graph");
  result.registry_root = value.at("registryRoot").get<std::string>();
  result.graph_root = value.at("graphRoot").get<std::string>();
  if (result.graph.value("graphRoot", "") != result.graph_root)
    refuse("KF_KFX_SCHEMA_INVALID", "KFX registry projection graph root is inconsistent");
  return result;
}

json parse_fact_body(const json &member) {
  if (!member.is_object() || member.value("body_status", "") != "present" || !member.contains("body") ||
      !member.at("body").is_string())
    return nullptr;
  try {
    return json::parse(member.at("body").get<std::string>());
  } catch (const json::exception &error) {
    refuse("KF_KFX_SCHEMA_INVALID", "KFX Fact body is not canonical JSON: " + std::string(error.what()));
  }
}

lifecycle_view load_lifecycle(const std::string &runtime_dir) {
  lifecycle_view result;
  if (runtime_dir.empty())
    return result;
  const auto response = storage_service_api::run_fact_kernel_operation(
      runtime_dir, {{"action", "query"}, {"ref_name", KFX_REGISTRY_REF}, {"include_bodies", true}});
  if (!response.value("ok", false)) {
    if (response.value("failure_code", "") == "unknown-cut")
      return result;
    refuse("KF_KFX_FACT_REJECTED",
           response.value("failure_code", "unknown") + ": " + response.value("message", "Fact query failed"));
  }
  result.present = true;
  result.cut_root = response.at("cut_root").get<std::string>();
  result.cut = response.at("cut");
  const auto &resolution = response.at("ref_resolution");
  result.revision = resolution.at("revision").get<uint64_t>();
  for (const auto &member : result.cut.at("objectVersions")) {
    result.current_versions[member.at(0).get<std::string>()] = member.at(1).get<std::string>();
  }
  for (const auto &root : result.cut.at("activeRelationRoots"))
    result.relation_roots.insert(root.get<std::string>());
  for (const auto &member : response.at("objects")) {
    const auto body = parse_fact_body(member);
    if (body.is_null() || !body.contains("schema") || !body.at("schema").is_string())
      continue;
    const auto schema = body.at("schema").get<std::string>();
    if (schema == "kungfu.kfx.registry-projection-fact/v1") {
      if (body.value("domainProfileRoot", "") != native_kfx_domain_profile().at("domainProfileRoot").get<std::string>())
        refuse("KF_KFX_SCHEMA_INVALID", "KFX registry projection binds a different Domain Profile");
      result.authoritative = snapshot_from_projection(body.at("projection"));
    } else if (schema == "kungfu.kfx.package-fact/v1") {
      result.desired_states[body.at("transport").at("packageKey").get<std::string>()] =
          body.at("desiredState").get<std::string>();
    } else if (schema == "kungfu.kfx.episode-fact/v1" || schema == "kungfu.kfx.episode-fact/v2") {
      const auto key = body.value("packageKey", "");
      if (!key.empty())
        result.observed_states[key] = body.value("observedState", "unknown");
      result.work_history.push_back(body);
    } else if (schema == "kungfu.kfx.work-fact/v1" || schema == "kungfu.kfx.work-fact/v2" ||
               schema == "kungfu.kfx.settlement-fact/v1" || schema == "kungfu.kfx.settlement-fact/v2") {
      result.work_history.push_back(body);
    }
  }
  if (result.authoritative.registry_root.empty())
    refuse("KF_KFX_SCHEMA_INVALID", "named KFX Fact Cut has no registry projection Fact");
  return result;
}

class lifecycle_writer_lock {
public:
  explicit lifecycle_writer_lock(const std::string &runtime_dir) : path_(lifecycle_root(runtime_dir) / ".writer-lock") {
    fs::create_directories(path_.parent_path());
    std::error_code error;
    if (!fs::create_directory(path_, error))
      refuse("KF_KFX_WRITER_BUSY", "another native KFX writer owns this runtime directory");
    held_ = true;
  }

  lifecycle_writer_lock(const lifecycle_writer_lock &) = delete;
  lifecycle_writer_lock &operator=(const lifecycle_writer_lock &) = delete;

  ~lifecycle_writer_lock() {
    if (!held_)
      return;
    std::error_code ignored;
    fs::remove(path_, ignored);
  }

private:
  fs::path path_;
  bool held_ = false;
};

const json &provider_for(const snapshot &value, const std::string &provider_id) {
  for (const auto &provider : value.graph.at("providers")) {
    if (provider.at("providerId") == provider_id)
      return provider;
  }
  refuse("KF_KFX_MEMBER_MISSING", "KFX provider is not present in the semantic graph: " + provider_id);
}

std::string derived_verdict(const json &provider, const std::string &desired, const std::string &observed) {
  if (provider.value("state", "active") == "degraded" || observed == "failed" || observed == "degraded")
    return "degraded";
  if (desired == "dormant" || desired == "removed" || desired == "disabled")
    return "dormant";
  return observed == "unknown" ? "dormant" : "active";
}

std::string runtime_placement(const std::string &host) {
  if (host == "gui")
    return "sandboxed-ipc";
  if (host == "wasm")
    return "wasm-confined";
  if (host.starts_with("service-"))
    return "process-isolated";
  if (host.starts_with("adapter-"))
    return "integrated-disabled";
  if (host == "profile")
    return "metadata-only";
  refuse("KF_KFX_HOST_UNKNOWN", "Core cannot derive a physical placement for host " + host);
}

bool capabilities_cover(const json &granted, const json &required) {
  if (!granted.is_array() || !required.is_array())
    return false;
  return std::all_of(required.begin(), required.end(), [&](const auto &capability) {
    return std::find(granted.begin(), granted.end(), capability) != granted.end();
  });
}

json host_generation(const snapshot &value, const lifecycle_view &lifecycle) {
  const json cut_root = lifecycle.present ? json(lifecycle.cut_root) : json(nullptr);
  return {{"schema", "kungfu.kfx.host-generation/v2"},
          {"registryRoot", value.registry_root},
          {"graphRoot", value.graph_root},
          {"cutRoot", cut_root},
          {"revision", lifecycle.revision}};
}

json package_host_authorization(const json &package, const json &provider, const json &required_capabilities,
                                const std::string &placement, const lifecycle_view &lifecycle,
                                const std::string &generation_root) {
  const auto package_authority = package.value("authority", json::object());
  const auto granted_capabilities = package.value("grantedCapabilities", json::array());
  const auto desired = lifecycle.desired_states.contains(package.at("key").get<std::string>())
                           ? lifecycle.desired_states.at(package.at("key").get<std::string>())
                           : "dormant";
  const bool confinement_ok = placement != "integrated-disabled" && placement != "metadata-only";
  const bool execution_allowed = lifecycle.present && package.value("admitted", false) && desired == "active" &&
                                 !package_authority.empty() && confinement_ok &&
                                 capabilities_cover(granted_capabilities, required_capabilities);
  const json identity = {
      {"schema", "kungfu.kfx.host-authorization/v2"},
      {"packageKey", package.at("key")},
      {"packageRoot", package.at("packageRoot")},
      {"manifestRoot", package.at("manifestRoot")},
      {"ownerProviderRoot", provider.at("providerRoot")},
      {"trustRoot", provider.at("trustRoot")},
      {"runtimeTier", package.at("runtimeTier")},
      {"admissionGrade", package.at("admissionGrade")},
      {"productSystem", package.at("productSystem")},
      {"placement", placement},
      {"requiredCapabilities", required_capabilities},
      {"grantedCapabilities", granted_capabilities},
      {"reportRoot", package_authority.value("reportRoot", json(nullptr))},
      {"admissionPlanRoot", package_authority.value("admissionPlanRoot", json(nullptr))},
      {"corePolicyRoot", package_authority.value("corePolicyRoot", json(nullptr))},
      {"requestedPolicyRoot", package_authority.value("requestedPolicyRoot", json(nullptr))},
      {"policyRoot", package_authority.value("policyRoot", json(nullptr))},
      {"authorizationPlanRoot", package_authority.value("authorizationPlanRoot", json(nullptr))},
      {"capabilityDeclarationRoot", package_authority.value("capabilityDeclarationRoot", json(nullptr))},
      {"capabilityGrantRoot", package_authority.value("capabilityGrantRoot", json(nullptr))},
      {"warrantRoot", package_authority.value("warrantRoot", json(nullptr))},
      {"cutRoot", lifecycle.present ? json(lifecycle.cut_root) : json(nullptr)},
      {"revision", lifecycle.revision},
      {"generationRoot", generation_root},
      {"executionAllowed", execution_allowed}};
  auto result = identity;
  result["authorizationRoot"] = root_of(identity);
  return result;
}

json experience_flow_descriptor(const snapshot &value, const lifecycle_view &lifecycle, const std::string &plan_root) {
  const auto generation = host_generation(value, lifecycle);
  const auto generation_root = root_of(generation);
  json runtime_authorizations = json::array();
  for (const auto &package : value.packages) {
    const auto &provider = provider_for(value, package.at("key").get<std::string>());
    for (const auto &host : package.at("hosts")) {
      const auto host_name = host.get<std::string>();
      auto authorization = package_host_authorization(package, provider, package.at("declaredCapabilities"),
                                                      runtime_placement(host_name), lifecycle, generation_root);
      authorization["host"] = host_name;
      runtime_authorizations.push_back(authorization);
    }
  }
  json contributions = json::array();
  for (const auto &contribution : value.graph.at("contributions")) {
    if (!contribution.contains("surface") ||
        (contribution.at("surface") != "experience" && contribution.at("surface") != "flow"))
      continue;
    json projected = contribution;
    const auto provider_id = contribution.at("ownerProviderId").get<std::string>();
    const auto desired =
        lifecycle.desired_states.contains(provider_id) ? lifecycle.desired_states.at(provider_id) : "dormant";
    const auto observed =
        lifecycle.observed_states.contains(provider_id) ? lifecycle.observed_states.at(provider_id) : "unknown";
    const auto &provider = provider_for(value, provider_id);
    const auto package = find_package(value.packages, provider_id);
    projected["providerState"] = derived_verdict(provider, desired, observed);
    const json facet_identity = {{"schema", "kungfu.kfx.presentation-facet/v1"},
                                 {"contributionRoot", contribution.at("contributionRoot")},
                                 {"presentation", contribution.value("presentation", json::object())}};
    const auto authorization = package_host_authorization(package, provider, contribution.at("capabilities"),
                                                          "host-native-projection", lifecycle, generation_root);
    projected["ownerProviderRoot"] = provider.at("providerRoot");
    projected["ownerTrustRoot"] = provider.at("trustRoot");
    projected["facetRoot"] = root_of(facet_identity);
    projected["authorization"] = authorization;
    contributions.push_back(projected);
  }
  const json cut_root = lifecycle.present ? json(lifecycle.cut_root) : json(nullptr);
  json contribution_roots = json::array();
  json facet_roots = json::array();
  json capability_roots = json::array();
  json authorization_roots = json::array();
  json runtime_authorization_roots = json::array();
  for (const auto &contribution : contributions) {
    contribution_roots.push_back(contribution.at("contributionRoot"));
    facet_roots.push_back(contribution.at("facetRoot"));
    capability_roots.push_back(contribution.at("capabilityRoot"));
    authorization_roots.push_back(contribution.at("authorization").at("authorizationRoot"));
  }
  for (const auto &authorization : runtime_authorizations)
    runtime_authorization_roots.push_back(authorization.at("authorizationRoot"));
  const json admission = {{"schema", "kungfu.kfx.host-admission/v2"},
                          {"state", lifecycle.present ? "admitted" : "preview-only"},
                          {"exactRootRequired", true},
                          {"registryRoot", value.registry_root},
                          {"graphRoot", value.graph_root},
                          {"planRoot", plan_root},
                          {"cutRoot", cut_root},
                          {"revision", lifecycle.revision},
                          {"generationRoot", generation_root},
                          {"contributionRoots", contribution_roots},
                          {"facetRoots", facet_roots},
                          {"capabilityRoots", capability_roots},
                          {"authorizationRoots", authorization_roots},
                          {"runtimeAuthorizationRoots", runtime_authorization_roots}};
  const json receipt_dependency = {{"registryRoot", value.registry_root},
                                   {"graphRoot", value.graph_root},
                                   {"planRoot", plan_root},
                                   {"cutRoot", cut_root},
                                   {"revision", lifecycle.revision},
                                   {"generationRoot", generation_root},
                                   {"authorizationRoots", authorization_roots},
                                   {"runtimeAuthorizationRoots", runtime_authorization_roots}};
  const json identity = {{"schema", "kungfu.kfx.experience-flow-host/v3"},
                         {"registryRoot", value.registry_root},
                         {"graphRoot", value.graph_root},
                         {"planRoot", plan_root},
                         {"cutRoot", cut_root},
                         {"revision", lifecycle.revision},
                         {"generation", generation},
                         {"generationRoot", generation_root},
                         {"admission", admission},
                         {"receiptDependencies", receipt_dependency},
                         {"receiptDependencyRoot", root_of(receipt_dependency)},
                         {"hosts", json::array({"gui", "tui", "cli", "agent"})},
                         {"runtimeAuthorizations", runtime_authorizations},
                         {"contributions", contributions}};
  auto descriptor = identity;
  descriptor["descriptorRoot"] = root_of(identity);
  return descriptor;
}

json authorize_host_launch(const json &descriptor, const lifecycle_view &lifecycle, const json &request) {
  if (!lifecycle.present)
    refuse("KF_KFX_HOST_NOT_ADMITTED", "host launch requires a settled named KFX Fact Cut");
  const auto package_key = required_text(request, "packageKey", "request");
  const auto host = required_text(request, "host", "request");
  if (!request.contains("expectedRevision") || !request.at("expectedRevision").is_number_integer() ||
      request.at("expectedRevision").get<int64_t>() < 0 ||
      static_cast<uint64_t>(request.at("expectedRevision").get<int64_t>()) != lifecycle.revision ||
      request.value("expectedCutRoot", "") != lifecycle.cut_root)
    refuse("KF_KFX_CUT_STALE", "host launch does not bind the current named Fact Cut");
  if (request.value("expectedGenerationRoot", "") != descriptor.at("generationRoot").get<std::string>())
    refuse("KF_KFX_GENERATION_MISMATCH", "host launch generation is stale");
  for (const auto &authorization : descriptor.at("runtimeAuthorizations")) {
    if (authorization.at("packageKey") != package_key || authorization.at("host") != host)
      continue;
    if (request.value("expectedPackageRoot", "") != authorization.at("packageRoot").get<std::string>())
      refuse("KF_KFX_REGISTRY_STALE", "host launch package root changed");
    if (!authorization.at("capabilityGrantRoot").is_string() ||
        request.value("expectedCapabilityGrantRoot", "") != authorization.at("capabilityGrantRoot").get<std::string>())
      refuse("KF_KFX_CAPABILITY_GRANT_STALE", "host launch capability grant changed or was replayed");
    if (request.value("expectedAuthorizationRoot", "") != authorization.at("authorizationRoot").get<std::string>())
      refuse("KF_KFX_AUTHORIZATION_STALE", "host launch authorization root changed");
    const auto expected_capabilities = request.value("expectedGrantedCapabilities", json::array());
    if (!expected_capabilities.is_array() || expected_capabilities != authorization.at("grantedCapabilities"))
      refuse("KF_KFX_CAPABILITY_GRANT_STALE", "host launch capability set does not match the exact grant");
    if (!authorization.at("executionAllowed").get<bool>())
      refuse("KF_KFX_RUNTIME_ISOLATION_REQUIRED",
             "host launch is not active, fully granted, or confined by the Core placement");
    return {{"schema", "kungfu.kfx.host-launch-authorization/v1"},
            {"descriptorRoot", descriptor.at("descriptorRoot")},
            {"generationRoot", descriptor.at("generationRoot")},
            {"cutRoot", descriptor.at("cutRoot")},
            {"revision", descriptor.at("revision")},
            {"authorization", authorization},
            {"executionAllowed", true}};
  }
  refuse("KF_KFX_HOST_UNKNOWN", "package does not declare the requested Core host placement");
}

json lifecycle_plan(const snapshot &value, const lifecycle_view &lifecycle, const json &request) {
  json package_plan = json::array();
  for (const auto &package : value.packages) {
    const auto key = package.at("key").get<std::string>();
    const auto &provider = provider_for(value, key);
    const auto desired_state =
        lifecycle.desired_states.contains(key) ? lifecycle.desired_states.at(key) : std::string{"dormant"};
    const auto observed_state =
        lifecycle.observed_states.contains(key) ? lifecycle.observed_states.at(key) : std::string{"unknown"};
    const auto verdict = derived_verdict(provider, desired_state, observed_state);
    package_plan.push_back({{"key", package.at("key")},
                            {"providerRoot", provider.at("providerRoot")},
                            {"rootKind", package.at("rootKind")},
                            {"packageRoot", package.at("packageRoot")},
                            {"apiCompatibility", package.at("apiCompatibility")},
                            {"facets", package.at("facets")},
                            {"runtimeTier", package.at("runtimeTier")},
                            {"admissionGrade", package.at("admissionGrade")},
                            {"trustRoot", provider.at("trustRoot")},
                            {"capabilityRoot", provider.at("capabilityRoot")},
                            {"hosts", package.at("hosts")},
                            {"declaredCapabilities", package.at("declaredCapabilities")},
                            {"semanticState", provider.at("state")},
                            {"desiredState", desired_state},
                            {"observedState", observed_state},
                            {"verdict", verdict},
                            {"state", verdict},
                            {"causes", provider.at("causes")},
                            {"recoveryGuidance", provider.at("recoveryGuidance")}});
  }
  json intent = nullptr;
  if (request.contains("operation") || request.contains("packageKey")) {
    intent = {{"operation", request.value("operation", "")}, {"packageKey", request.value("packageKey", "")}};
  }
  const json cut_root = lifecycle.present ? json(lifecycle.cut_root) : json(nullptr);
  json identity = {{"schema", "kungfu.kfx.load-plan/v2"},
                   {"registryRoot", value.registry_root},
                   {"graphRoot", value.graph_root},
                   {"authorityMode", lifecycle.present ? "pinned-fact-cut" : "observation-preview"},
                   {"cutRef", KFX_REGISTRY_REF},
                   {"cutRoot", cut_root},
                   {"revision", lifecycle.revision},
                   {"packages", package_plan},
                   {"suites", value.suites},
                   {"diagnostics", value.diagnostics},
                   {"intent", intent},
                   {"readOnly", false}};
  auto result = identity;
  const auto plan_root = root_of(identity);
  result["planRoot"] = plan_root;
  result["graph"] = value.graph;
  result["nextRevision"] = intent.is_null() ? lifecycle.revision : lifecycle.revision + 1;
  result["hostContract"] = experience_flow_descriptor(value, lifecycle, plan_root);
  return result;
}

inline constexpr const char *KFX_CONTROL_SUITE_ID = "kungfu-kfx-control-suite";
inline constexpr const char *KFX_CONTROL_PACKAGE_KEY = "kfx-manager";

json mutation_authorization_plan(const snapshot &value, const lifecycle_view &lifecycle, const json &request,
                                 const json &load_plan) {
  const json prior_cut = lifecycle.present ? json(lifecycle.cut_root) : json(nullptr);
  return authority::plan(value.packages, value.registry_root, value.graph_root, prior_cut, lifecycle.revision, request,
                         load_plan, assess_package);
}

json control_bootstrap_policy() {
  const json identity = {{"schema", "kungfu.kfx.control-bootstrap-policy/v1"},
                         {"controllerId", KFX_CONTROL_SUITE_ID},
                         {"packageKey", KFX_CONTROL_PACKAGE_KEY},
                         {"requiredProductRoles", json::array({"boot-critical", "system-management"})},
                         {"maximumCapabilities", json::array({"kfxControl", "profile"})},
                         {"requiredCapabilities", json::array({"kfxControl"})},
                         {"requiredRootKind", "product"},
                         {"runtimePlacement", "sandboxed-ipc"},
                         {"productRolesAuthority", "assembly-and-distribution-metadata-only"},
                         {"authority",
                          {{"candidateIdentity", "kungfu.kfx.json plus Core-computed package closure"},
                           {"lifecycle", "public-kfx-status-plan-apply"},
                           {"settlement", "fact-work-named-cut-cas"},
                           {"selfGrant", false},
                           {"receiptsBypassPolicy", false}}},
                         {"recovery",
                          {{"lastKnownGood", "retained-package-referenced-by-sealed-kfx-episode-fact"},
                           {"corruptOrMissingActive", "deterministic-safe-mode"},
                           {"automaticActivation", false}}}};
  auto result = identity;
  result["policyRoot"] = root_of(identity);
  return result;
}

json validate_control_package(const json &package) {
  const auto policy = control_bootstrap_policy();
  json reasons = json::array();
  if (package.is_null() || !package.is_object()) {
    reasons.push_back("KF_KFX_CONTROL_CANDIDATE_MISSING");
  } else {
    if (package.value("key", "") != KFX_CONTROL_PACKAGE_KEY)
      reasons.push_back("KF_KFX_CONTROL_IDENTITY_MISMATCH");
    if (package.value("rootKind", "") != policy.at("requiredRootKind").get<std::string>())
      reasons.push_back("KF_KFX_CONTROL_SOURCE_REJECTED");
    const auto roles = package.value("productRoles", json::array());
    if (roles != policy.at("requiredProductRoles"))
      reasons.push_back("KF_KFX_CONTROL_ROLE_BROADENING");
    const auto capabilities = package.value("declaredCapabilities", json::array());
    for (const auto &required : policy.at("requiredCapabilities")) {
      if (std::find(capabilities.begin(), capabilities.end(), required) == capabilities.end())
        reasons.push_back("KF_KFX_CONTROL_CAPABILITY_MISSING");
    }
    for (const auto &capability : capabilities) {
      if (std::find(policy.at("maximumCapabilities").begin(), policy.at("maximumCapabilities").end(), capability) ==
          policy.at("maximumCapabilities").end())
        reasons.push_back("KF_KFX_CONTROL_SELF_GRANT");
    }
  }
  return {{"schema", "kungfu.kfx.control-bootstrap-verification/v1"},
          {"controllerId", KFX_CONTROL_SUITE_ID},
          {"policyRoot", policy.at("policyRoot")},
          {"packageRoot", package.is_object() ? package.value("packageRoot", "") : ""},
          {"manifestRoot", package.is_object() ? package.value("manifestRoot", "") : ""},
          {"valid", reasons.empty()},
          {"reasons", reasons}};
}

json inspect_control_package_path(const fs::path &path) {
  if (!fs::is_directory(path))
    refuse("KF_KFX_CONTROL_ACTIVE_CORRUPT", "Control Suite package path is missing");
  const json request = {{"roots", json::array({{{"kind", "product"}, {"path", path.string()}}})}};
  const auto observed = build_snapshot(request);
  const auto package = find_package(observed.packages, KFX_CONTROL_PACKAGE_KEY);
  const auto verification = validate_control_package(package);
  if (!verification.at("valid").get<bool>())
    refuse("KF_KFX_CONTROL_ACTIVE_CORRUPT", "Control Suite package failed embedded bootstrap verification");
  return package;
}

std::vector<json> retained_control_candidates(const lifecycle_view &lifecycle) {
  std::vector<std::pair<int64_t, fs::path>> paths;
  for (const auto &event : lifecycle.work_history) {
    const auto schema = event.value("schema", "");
    if ((schema != "kungfu.kfx.episode-fact/v1" && schema != "kungfu.kfx.episode-fact/v2") ||
        event.value("packageKey", "") != KFX_CONTROL_PACKAGE_KEY)
      continue;
    const auto materialization = event.value("materialization", json::object());
    if (!materialization.contains("retainedPath") || !materialization.at("retainedPath").is_string() ||
        materialization.at("retainedPath").get<std::string>().empty())
      continue;
    paths.emplace_back(event.value("recordedAt", int64_t{0}),
                       fs::path(materialization.at("retainedPath").get<std::string>()));
  }
  std::sort(paths.begin(), paths.end(), [](const auto &left, const auto &right) { return left.first > right.first; });
  std::vector<json> result;
  std::set<std::string> seen_roots;
  for (const auto &[ignored, path] : paths) {
    (void)ignored;
    try {
      const auto package = inspect_control_package_path(path);
      const auto root = package.at("packageRoot").get<std::string>();
      if (!seen_roots.insert(root).second)
        continue;
      result.push_back({{"packageRoot", root},
                        {"manifestRoot", package.at("manifestRoot")},
                        {"version", package.value("version", "")},
                        {"sourcePath", path.string()}});
    } catch (const std::invalid_argument &) {
      // Retained bytes are recovery candidates, never authority. Corrupt or
      // stale candidates stay excluded and cannot weaken safe mode.
    }
  }
  return result;
}

json control_status(const lifecycle_view &lifecycle) {
  const auto policy = control_bootstrap_policy();
  json active = nullptr;
  json active_verification = {{"schema", "kungfu.kfx.control-bootstrap-verification/v1"},
                              {"controllerId", KFX_CONTROL_SUITE_ID},
                              {"policyRoot", policy.at("policyRoot")},
                              {"packageRoot", ""},
                              {"manifestRoot", ""},
                              {"valid", false},
                              {"reasons", json::array({"KF_KFX_CONTROL_ACTIVE_MISSING"})}};
  if (lifecycle.present) {
    active = find_package(lifecycle.authoritative.packages, KFX_CONTROL_PACKAGE_KEY);
    if (!active.is_null()) {
      active_verification = validate_control_package(active);
      if (active_verification.at("valid").get<bool>()) {
        try {
          const auto physical = inspect_control_package_path(active.at("path").get<std::string>());
          if (physical.at("packageRoot") != active.at("packageRoot") ||
              physical.at("manifestRoot") != active.at("manifestRoot")) {
            active_verification["valid"] = false;
            active_verification["reasons"] = json::array({"KF_KFX_CONTROL_ACTIVE_CORRUPT"});
          }
        } catch (const std::invalid_argument &) {
          active_verification["valid"] = false;
          active_verification["reasons"] = json::array({"KF_KFX_CONTROL_ACTIVE_CORRUPT"});
        }
      }
    }
  }
  const auto retained = retained_control_candidates(lifecycle);
  const auto active_valid = active_verification.at("valid").get<bool>();
  json last_known_good = nullptr;
  if (!retained.empty())
    last_known_good = retained.front();
  else if (active_valid)
    last_known_good = {{"packageRoot", active.at("packageRoot")},
                       {"manifestRoot", active.at("manifestRoot")},
                       {"version", active.value("version", "")},
                       {"sourcePath", active.value("path", "")}};
  const auto mode = active_valid ? "active" : "safe-mode";
  json identity = {
      {"schema", "kungfu.kfx.control-suite-status/v1"},
      {"controllerId", KFX_CONTROL_SUITE_ID},
      {"authority", lifecycle.present ? "pinned-fact-cut" : "bootstrap-safe-mode"},
      {"cutRef", KFX_REGISTRY_REF},
      {"cutRoot", lifecycle.present ? json(lifecycle.cut_root) : json(nullptr)},
      {"revision", lifecycle.revision},
      {"policy", policy},
      {"active", active.is_null() ? json(nullptr)
                                  : json({{"packageRoot", active.at("packageRoot")},
                                          {"manifestRoot", active.at("manifestRoot")},
                                          {"version", active.value("version", "")}})},
      {"activeVerification", active_verification},
      {"lastKnownGood", last_known_good},
      {"mode", mode},
      {"executionAllowed", active_valid},
      {"diagnostics",
       active_valid
           ? json::array()
           : json::array({{{"code", "KF_KFX_CONTROL_SAFE_MODE"},
                           {"recoveryGuidance", last_known_good.is_null()
                                                    ? json::array({"install-qualified-control-suite"})
                                                    : json::array({"plan-explicit-last-known-good-rollback"})}}})}};
  auto result = identity;
  result["statusRoot"] = root_of(identity);
  return result;
}

json control_plan(const snapshot &value, const lifecycle_view &lifecycle, const json &request, const json &load_plan) {
  const auto operation = request.value("operation", "");
  if (operation != "install" && operation != "update")
    refuse("KF_KFX_CONTROL_OPERATION_REJECTED", "Control Suite only admits explicit install or update plans");
  if (request.value("packageKey", "") != KFX_CONTROL_PACKAGE_KEY)
    refuse("KF_KFX_CONTROL_IDENTITY_MISMATCH", "Control Suite cannot mutate another package identity");
  const auto candidate = find_package(value.packages, KFX_CONTROL_PACKAGE_KEY);
  const auto verification = validate_control_package(candidate);
  if (!verification.at("valid").get<bool>()) {
    const auto reasons = verification.at("reasons");
    const auto code = reasons.empty() ? "KF_KFX_CONTROL_TRUST_REJECTED" : reasons.front().get<std::string>();
    refuse(code, "Control Suite candidate exceeds the embedded bootstrap contract");
  }
  const auto status = control_status(lifecycle);
  const auto mutation_authorization = mutation_authorization_plan(value, lifecycle, request, load_plan);
  const auto assessment = mutation_authorization.at("assessment");
  if (assessment.is_null() || assessment.at("trustReport").value("admissionGrade", "") != "product-system")
    refuse("KF_KFX_CONTROL_TRUST_REJECTED",
           "Control Suite requires exact KFD eligibility and Product assembly-root policy metadata");
  const json identity = {
      {"schema", "kungfu.kfx.control-suite-plan/v1"},
      {"controllerId", KFX_CONTROL_SUITE_ID},
      {"operation", operation},
      {"packageKey", KFX_CONTROL_PACKAGE_KEY},
      {"basis",
       {{"cutRoot", lifecycle.present ? json(lifecycle.cut_root) : json(nullptr)},
        {"revision", lifecycle.revision},
        {"activePackageRoot", status.at("active").is_null() ? json(nullptr) : status.at("active").at("packageRoot")}}},
      {"candidate",
       {{"packageRoot", candidate.at("packageRoot")},
        {"manifestRoot", candidate.at("manifestRoot")},
        {"version", candidate.value("version", "")}}},
      {"bootstrapVerification", verification},
      {"bootstrapPolicyRoot", control_bootstrap_policy().at("policyRoot")},
      {"loadPlanRoot", load_plan.at("planRoot")},
      {"registryRoot", load_plan.at("registryRoot")},
      {"graphRoot", load_plan.at("graphRoot")},
      {"mutationAuthorization", mutation_authorization},
      {"authorizationPlanRoot", mutation_authorization.at("authorizationPlanRoot")},
      {"capabilityGrantRoot", mutation_authorization.at("capabilityGrantRoot")},
      {"warrantRoot", mutation_authorization.at("warrantRoot")},
      {"allowed", true},
      {"requiresAuthorization", true},
      {"authority", "public-kfx-plan-plus-fact-work-settlement"}};
  auto result = identity;
  result["controlPlanRoot"] = root_of(identity);
  result["loadPlan"] = load_plan;
  return result;
}

json lifecycle_history(const std::string &runtime_dir, const json &request) {
  if (runtime_dir.empty())
    refuse("KF_KFX_SCHEMA_INVALID", "KFX history requires an explicit runtime directory");
  const auto state = storage_service_api::run_fact_kernel_operation(
      runtime_dir, {{"action", "query"}, {"include_inventory", true}, {"include_bodies", true}});
  if (!state.value("ok", false))
    refuse("KF_KFX_FACT_REJECTED", state.value("message", "Fact inventory query failed"));
  json events = json::array();
  const auto package_key = request.value("packageKey", "");
  const auto &inventory = state.at("inventory");
  if (inventory.contains("bodies") && inventory.at("bodies").is_object()) {
    for (const auto &[ignored, body_entry] : inventory.at("bodies").items()) {
      (void)ignored;
      if (!body_entry.is_object() || body_entry.value("status", "") != "available" || !body_entry.contains("body") ||
          !body_entry.at("body").is_string())
        continue;
      json body;
      try {
        body = json::parse(body_entry.at("body").get<std::string>());
      } catch (const json::exception &) {
        continue;
      }
      const auto schema = body.value("schema", "");
      if (schema != "kungfu.kfx.work-fact/v1" && schema != "kungfu.kfx.work-fact/v2" &&
          schema != "kungfu.kfx.warrant-fact/v1" && schema != "kungfu.kfx.warrant-fact/v2" &&
          schema != "kungfu.kfx.episode-fact/v1" && schema != "kungfu.kfx.episode-fact/v2" &&
          schema != "kungfu.kfx.settlement-fact/v1" && schema != "kungfu.kfx.settlement-fact/v2")
        continue;
      if (package_key.empty() || body.value("packageKey", "") == package_key)
        events.push_back(body);
    }
  }
  std::sort(events.begin(), events.end(), [](const auto &left, const auto &right) {
    if (left.value("recordedAt", int64_t{0}) != right.value("recordedAt", int64_t{0}))
      return left.value("recordedAt", int64_t{0}) < right.value("recordedAt", int64_t{0});
    return left.value("actionId", "") < right.value("actionId", "");
  });
  const auto lifecycle = load_lifecycle(runtime_dir);
  return {{"schema", "kungfu.kfx.lifecycle-history/v2"},
          {"authority", "yijinjing-hana-pod-journal"},
          {"cutRef", KFX_REGISTRY_REF},
          {"cutRoot", lifecycle.present ? json(lifecycle.cut_root) : json(nullptr)},
          {"revision", lifecycle.revision},
          {"historyRoot", root_of(events)},
          {"events", events}};
}

struct fact_work_builder {
  std::string runtime_dir;
  std::map<std::string, std::string> versions;
  std::set<std::string> relations;
  json steps = json::array();
  std::string profile_root;
  std::string admission_root;

  fact_work_builder(std::string runtime, const lifecycle_view &current)
      : runtime_dir(std::move(runtime)), versions(current.current_versions), relations(current.relation_roots),
        profile_root(native_kfx_domain_profile().at("domainProfileRoot").get<std::string>()),
        admission_root(
            root_of({{"schema", "kungfu.kfx-domain-profile-admission/v1"}, {"domainProfileRoot", profile_root}})) {}

  json invoke(const std::string &action, const json &request) {
    auto response = fact_call(runtime_dir, action, request);
    if (response.value("status", "") == "idempotent-replay" && response.contains("result") &&
        response.at("result").contains("record_root")) {
      static const std::map<std::string, std::string> replay_root_fields = {{"object-put", "object_root"},
                                                                            {"version-put", "version_root"},
                                                                            {"relation-add", "relation_root"},
                                                                            {"cut-put", "cut_root"}};
      if (replay_root_fields.contains(action))
        response["result"][replay_root_fields.at(action)] = response.at("result").at("record_root");
    }
    steps.push_back({{"action", action},
                     {"status", response.value("status", "accepted")},
                     {"writeOccurred", response.value("write_occurred", false)},
                     {"receiptRoot", response.contains("receipt_root") ? response.at("receipt_root") : json(nullptr)}});
    return response;
  }

  json put(const std::string &object_id, const std::string &object_type, const json &body) {
    const auto created_by = root_of({{"schema", "kungfu.kfx-object-declaration/v1"},
                                     {"domainProfileRoot", profile_root},
                                     {"objectId", object_id},
                                     {"objectType", object_type}});
    invoke("object-put",
           {{"object_id", object_id}, {"object_type", object_type}, {"created_by_receipt_root", created_by}});
    json parents = json::array();
    if (versions.contains(object_id))
      parents.push_back(versions.at(object_id));
    const auto response = invoke(
        "version-put",
        {{"object_id", object_id},
         {"body", body.dump()},
         {"schema_root", root_of({{"schema", "kungfu.kfx-fact-body-schema/v1"}, {"bodySchema", body.at("schema")}})},
         {"parent_version_roots", parents},
         {"declaration_roots", json::array({profile_root})},
         {"admission_roots", json::array({admission_root})}});
    versions[object_id] = response.at("result").at("version_root").get<std::string>();
    return response.at("result");
  }

  void relate(const std::string &type, const std::string &source, const std::string &target, const json &attributes) {
    const auto attributes_root = root_of(attributes);
    const auto response = invoke("relation-add", {{"relation_id", relation_id(type, source, target)},
                                                  {"relation_type", type},
                                                  {"source", {{"kind", "logical-object"}, {"id", source}}},
                                                  {"target", {{"kind", "logical-object"}, {"id", target}}},
                                                  {"attributes_root", attributes_root},
                                                  {"admission_roots", json::array({admission_root})}});
    relations.insert(response.at("result").at("relation_root").get<std::string>());
  }
};

std::string package_identity_root(const json &package) {
  return root_of(
      {{"schema", "kungfu.kfx.package-identity/v1"},
       {"name", package.value("name", "")},
       {"manifestIdentity", package.value("name", "").empty() ? package.at("manifestRoot") : package.at("name")}});
}

json issue_fact_work_authority(const std::string &runtime_dir, const snapshot &value, const lifecycle_view &current,
                               const json &authorization) {
  const auto action_id = authorization.at("actionId").get<std::string>();
  const auto work_id = authorization.at("workObjectId").get<std::string>();
  const auto warrant_id = authorization.at("warrantObjectId").get<std::string>();
  const auto recorded_at = authorization.at("authorizationTime").get<int64_t>();
  const auto profile_root = native_kfx_domain_profile().at("domainProfileRoot");
  fact_work_builder builder(runtime_dir, current);
  const auto projection_id = fact_id("registry-projection", KFX_REGISTRY_REF);
  builder.put(projection_id, "kungfu.kfx.registry-projection",
              {{"schema", "kungfu.kfx.registry-projection-fact/v1"},
               {"profile", KFX_PROFILE_ID},
               {"domainProfileRoot", profile_root},
               {"cutRef", KFX_REGISTRY_REF},
               {"projection", snapshot_projection(value)}});
  builder.put(work_id, "kungfu.kfx.work",
              {{"schema", "kungfu.kfx.work-fact/v2"},
               {"profile", KFX_PROFILE_ID},
               {"domainProfileRoot", profile_root},
               {"actionId", action_id},
               {"operation", authorization.at("operation")},
               {"packageKey", authorization.at("packageKey")},
               {"basis", authorization.at("basis")},
               {"authorityRoots", authorization.at("authorityRoots")},
               {"authorizationPlanRoot", authorization.at("authorizationPlanRoot")},
               {"capabilityDeclarationRoot", authorization.at("capabilityDeclarationRoot")},
               {"capabilityGrantRoot", authorization.at("capabilityGrantRoot")},
               {"grantedCapabilities", authorization.at("grantedCapabilities")},
               {"warrantRoot", authorization.at("warrantRoot")},
               {"recordedAt", recorded_at},
               {"status", "authorized"}});
  builder.put(warrant_id, "kungfu.kfx.warrant",
              {{"schema", "kungfu.kfx.warrant-fact/v2"},
               {"profile", KFX_PROFILE_ID},
               {"domainProfileRoot", profile_root},
               {"actionId", action_id},
               {"operation", authorization.at("operation")},
               {"packageKey", authorization.at("packageKey")},
               {"basis", authorization.at("basis")},
               {"authorityRoots", authorization.at("authorityRoots")},
               {"authorizationPlanRoot", authorization.at("authorizationPlanRoot")},
               {"capabilityDeclarationRoot", authorization.at("capabilityDeclarationRoot")},
               {"capabilityGrantRoot", authorization.at("capabilityGrantRoot")},
               {"grantedCapabilities", authorization.at("grantedCapabilities")},
               {"warrantRoot", authorization.at("warrantRoot")},
               {"state", "issued"},
               {"recordedAt", recorded_at}});
  builder.relate("kfx-work-authorized-by", work_id, warrant_id,
                 {{"schema", "kungfu.kfx.relation-attributes/v1"},
                  {"actionId", action_id},
                  {"authorizationPlanRoot", authorization.at("authorizationPlanRoot")}});

  json object_versions = json::array();
  for (const auto &[object_id, version_root] : builder.versions)
    object_versions.push_back({{"object_id", object_id}, {"version_root", version_root}});
  json relation_roots = json::array();
  for (const auto &root : builder.relations)
    relation_roots.push_back(root);
  json parent_cuts = json::array();
  if (current.present)
    parent_cuts.push_back(current.cut_root);
  const auto cut_response = builder.invoke(
      "cut-put",
      {{"parent_cut_roots", parent_cuts},
       {"object_versions", object_versions},
       {"active_relation_roots", relation_roots},
       {"declaration_roots", json::array({builder.profile_root})},
       {"admission_roots", json::array({builder.admission_root, authorization.at("authorizationPlanRoot"),
                                        authorization.at("capabilityGrantRoot"), authorization.at("warrantRoot")})},
       {"episode_frontier", json::array()},
       {"omission_roots", json::array()},
       {"conflict_roots", json::array()}});
  const auto new_cut_root = cut_response.at("result").at("cut_root");
  const auto ref_response = builder.invoke(
      "ref-cas", {{"transition_id", action_id + ":authorize"},
                  {"ref_name", KFX_REGISTRY_REF},
                  {"expected_old_cut_root", current.present ? json(current.cut_root) : json(nullptr)},
                  {"expected_old_revision", current.revision},
                  {"new_cut_root", new_cut_root},
                  {"kind", current.present ? "advance" : "create"},
                  {"reason_root", root_of({{"schema", "kungfu.kfx.warrant-issuance-reason/v1"},
                                           {"authorizationPlanRoot", authorization.at("authorizationPlanRoot")},
                                           {"warrantRoot", authorization.at("warrantRoot")}})}});
  const auto result = ref_response.at("result");
  const json receipt_identity = {{"schema", "kungfu.kfx.warrant-issuance-receipt/v1"},
                                 {"actionId", action_id},
                                 {"operation", authorization.at("operation")},
                                 {"packageKey", authorization.at("packageKey")},
                                 {"authorizationPlanRoot", authorization.at("authorizationPlanRoot")},
                                 {"capabilityGrantRoot", authorization.at("capabilityGrantRoot")},
                                 {"warrantRoot", authorization.at("warrantRoot")},
                                 {"workObjectId", work_id},
                                 {"warrantObjectId", warrant_id},
                                 {"priorCutRoot", current.present ? json(current.cut_root) : json(nullptr)},
                                 {"cutRoot", result.at("current_cut_root")},
                                 {"priorRevision", current.revision},
                                 {"revision", result.at("current_revision")},
                                 {"kernelReceiptRoot", ref_response.at("receipt_root")},
                                 {"recordedAt", recorded_at}};
  auto receipt = receipt_identity;
  receipt["receiptRoot"] = root_of(receipt_identity);
  receipt["steps"] = builder.steps;
  return receipt;
}

json commit_fact_work(const std::string &runtime_dir, const snapshot &value, const lifecycle_view &current,
                      const json &request, const std::string &operation, const std::string &desired_state,
                      const std::string &observed_state, const json &materialization, const json &authorization,
                      const json &warrant_receipt) {
  const auto key = required_text(request, "packageKey", "request");
  const auto recorded_at = authorization.at("authorizationTime").get<int64_t>();
  const auto action_id = authorization.at("actionId").get<std::string>();
  fact_work_builder builder(runtime_dir, current);
  const auto projection_id = fact_id("registry-projection", KFX_REGISTRY_REF);
  const auto profile_root = native_kfx_domain_profile().at("domainProfileRoot");
  builder.put(projection_id, "kungfu.kfx.registry-projection",
              {{"schema", "kungfu.kfx.registry-projection-fact/v1"},
               {"profile", KFX_PROFILE_ID},
               {"domainProfileRoot", profile_root},
               {"cutRef", KFX_REGISTRY_REF},
               {"projection", snapshot_projection(value)}});

  std::map<std::string, std::string> package_objects;
  std::map<std::string, std::string> provider_objects;
  for (const auto &package : value.packages) {
    const auto package_key = package.at("key").get<std::string>();
    const auto identity_root = package_identity_root(package);
    const auto package_id = fact_id("package", identity_root);
    package_objects[package_key] = package_id;
    const auto package_desired =
        package_key == key
            ? desired_state
            : (current.desired_states.contains(package_key) ? current.desired_states.at(package_key) : "dormant");
    builder.put(package_id, "kungfu.kfx.package",
                {{"schema", "kungfu.kfx.package-fact/v1"},
                 {"profile", KFX_PROFILE_ID},
                 {"domainProfileRoot", profile_root},
                 {"identity", {{"objectId", package_id}, {"logicalIdentityRoot", identity_root}}},
                 {"name", package.value("name", "")},
                 {"version", package.value("version", "")},
                 {"manifestRoot", package.at("manifestRoot")},
                 {"packageRoot", package.at("packageRoot")},
                 {"desiredState", package_desired},
                 {"transport", {{"packageKey", package_key}, {"path", package.value("path", "")}}},
                 {"lastActionId", action_id}});
  }
  for (const auto &provider : value.graph.at("providers")) {
    const auto provider_key = provider.at("providerId").get<std::string>();
    const auto provider_id = fact_id("provider", package_identity_root(find_package(value.packages, provider_key)));
    provider_objects[provider_key] = provider_id;
    builder.put(provider_id, "kungfu.kfx.provider",
                {{"schema", "kungfu.kfx.provider-fact/v1"},
                 {"profile", KFX_PROFILE_ID},
                 {"domainProfileRoot", profile_root},
                 {"provider", provider}});
    if (package_objects.contains(provider_key))
      builder.relate("kfx-package-provides", package_objects.at(provider_key), provider_id,
                     {{"schema", "kungfu.kfx.relation-attributes/v1"}, {"kind", "provider"}});
  }
  for (const auto &contribution : value.graph.at("contributions")) {
    const auto contribution_id = fact_id("contribution", contribution.at("contributionRoot").get<std::string>());
    builder.put(contribution_id, "kungfu.kfx.contribution",
                {{"schema", "kungfu.kfx.contribution-fact/v1"},
                 {"profile", KFX_PROFILE_ID},
                 {"domainProfileRoot", profile_root},
                 {"contribution", contribution}});
    const auto owner = contribution.value("ownerProviderId", "");
    if (provider_objects.contains(owner))
      builder.relate("kfx-provider-contributes", provider_objects.at(owner), contribution_id,
                     {{"schema", "kungfu.kfx.relation-attributes/v1"}, {"kind", "contribution"}});
  }
  for (const auto &dependency : value.graph.at("dependencies")) {
    const auto dependency_id = fact_id("dependency", dependency.at("dependencyRoot").get<std::string>());
    builder.put(dependency_id, "kungfu.kfx.dependency",
                {{"schema", "kungfu.kfx.dependency-fact/v1"},
                 {"profile", KFX_PROFILE_ID},
                 {"domainProfileRoot", profile_root},
                 {"dependency", dependency}});
    const auto source = dependency.value("providerId", "");
    const auto target = dependency.value("targetProviderId", dependency.value("requiresProviderId", ""));
    if (provider_objects.contains(source)) {
      const auto target_id = provider_objects.contains(target) ? provider_objects.at(target) : dependency_id;
      builder.relate("kfx-provider-depends-on", provider_objects.at(source), target_id,
                     {{"schema", "kungfu.kfx.relation-attributes/v1"}, {"mode", dependency.value("mode", "required")}});
    }
  }

  const auto work_id = authorization.at("workObjectId").get<std::string>();
  const auto warrant_id = authorization.at("warrantObjectId").get<std::string>();
  const auto episode_id = fact_id("episode", action_id);
  const auto settlement_id = fact_id("settlement", action_id);
  builder.put(work_id, "kungfu.kfx.work",
              {{"schema", "kungfu.kfx.work-fact/v2"},
               {"profile", KFX_PROFILE_ID},
               {"domainProfileRoot", profile_root},
               {"actionId", action_id},
               {"operation", operation},
               {"packageKey", key},
               {"actor", request.value("actor", "anonymous")},
               {"recordedAt", recorded_at},
               {"basis", authorization.at("basis")},
               {"authorityRoots", authorization.at("authorityRoots")},
               {"authorizationPlanRoot", authorization.at("authorizationPlanRoot")},
               {"capabilityDeclarationRoot", authorization.at("capabilityDeclarationRoot")},
               {"capabilityGrantRoot", authorization.at("capabilityGrantRoot")},
               {"grantedCapabilities", authorization.at("grantedCapabilities")},
               {"warrantRoot", authorization.at("warrantRoot")},
               {"status", "settled"}});
  builder.put(warrant_id, "kungfu.kfx.warrant",
              {{"schema", "kungfu.kfx.warrant-fact/v2"},
               {"profile", KFX_PROFILE_ID},
               {"domainProfileRoot", profile_root},
               {"actionId", action_id},
               {"operation", operation},
               {"packageKey", key},
               {"basis", authorization.at("basis")},
               {"authorityRoots", authorization.at("authorityRoots")},
               {"authorizationPlanRoot", authorization.at("authorizationPlanRoot")},
               {"capabilityDeclarationRoot", authorization.at("capabilityDeclarationRoot")},
               {"capabilityGrantRoot", authorization.at("capabilityGrantRoot")},
               {"grantedCapabilities", authorization.at("grantedCapabilities")},
               {"warrantRoot", authorization.at("warrantRoot")},
               {"state", "consumed"},
               {"recordedAt", recorded_at}});
  const auto episode_result = builder.put(episode_id, "kungfu.kfx.episode",
                                          {{"schema", "kungfu.kfx.episode-fact/v2"},
                                           {"profile", KFX_PROFILE_ID},
                                           {"domainProfileRoot", profile_root},
                                           {"actionId", action_id},
                                           {"operation", operation},
                                           {"packageKey", key},
                                           {"basis", authorization.at("basis")},
                                           {"authorityRoots", authorization.at("authorityRoots")},
                                           {"authorizationPlanRoot", authorization.at("authorizationPlanRoot")},
                                           {"capabilityDeclarationRoot", authorization.at("capabilityDeclarationRoot")},
                                           {"capabilityGrantRoot", authorization.at("capabilityGrantRoot")},
                                           {"grantedCapabilities", authorization.at("grantedCapabilities")},
                                           {"warrantRoot", authorization.at("warrantRoot")},
                                           {"outcome", "applied"},
                                           {"observedState", observed_state},
                                           {"materialization", materialization},
                                           {"recordedAt", recorded_at}});
  builder.put(settlement_id, "kungfu.kfx.settlement",
              {{"schema", "kungfu.kfx.settlement-fact/v2"},
               {"profile", KFX_PROFILE_ID},
               {"domainProfileRoot", profile_root},
               {"actionId", action_id},
               {"operation", operation},
               {"packageKey", key},
               {"basis", authorization.at("basis")},
               {"authorityRoots", authorization.at("authorityRoots")},
               {"authorizationPlanRoot", authorization.at("authorizationPlanRoot")},
               {"capabilityDeclarationRoot", authorization.at("capabilityDeclarationRoot")},
               {"capabilityGrantRoot", authorization.at("capabilityGrantRoot")},
               {"grantedCapabilities", authorization.at("grantedCapabilities")},
               {"warrantRoot", authorization.at("warrantRoot")},
               {"outcome", "accepted"},
               {"desiredState", desired_state},
               {"observedState", observed_state},
               {"recordedAt", recorded_at}});
  builder.relate("kfx-work-authorized-by", work_id, warrant_id,
                 {{"schema", "kungfu.kfx.relation-attributes/v1"},
                  {"actionId", action_id},
                  {"authorizationPlanRoot", authorization.at("authorizationPlanRoot")}});
  builder.relate("kfx-work-observed-in", work_id, episode_id,
                 {{"schema", "kungfu.kfx.relation-attributes/v1"}, {"actionId", action_id}});
  builder.relate("kfx-work-settled-by", work_id, settlement_id,
                 {{"schema", "kungfu.kfx.relation-attributes/v1"}, {"actionId", action_id}});
  if (package_objects.contains(key))
    builder.relate("kfx-settlement-updates-package", settlement_id, package_objects.at(key),
                   {{"schema", "kungfu.kfx.relation-attributes/v1"}, {"desiredState", desired_state}});

  json object_versions = json::array();
  for (const auto &[object_id, version_root] : builder.versions)
    object_versions.push_back({{"object_id", object_id}, {"version_root", version_root}});
  json relation_roots = json::array();
  for (const auto &root : builder.relations)
    relation_roots.push_back(root);
  json parent_cuts = json::array();
  if (current.present)
    parent_cuts.push_back(current.cut_root);
  const auto episode_number = std::stoull(sha256(action_id).substr(0, 16), nullptr, 16);
  const auto cut_response = builder.invoke(
      "cut-put",
      {{"parent_cut_roots", parent_cuts},
       {"object_versions", object_versions},
       {"active_relation_roots", relation_roots},
       {"declaration_roots", json::array({builder.profile_root})},
       {"admission_roots", json::array({builder.admission_root, authorization.at("authorizationPlanRoot"),
                                        authorization.at("capabilityGrantRoot"), authorization.at("warrantRoot")})},
       {"episode_frontier", json::array({{{"episode_id", episode_number},
                                          {"sealed_content_root", episode_result.at("body_root")},
                                          {"accepted_manifest_frame_uid", std::string("kfx:") + action_id}}})},
       {"omission_roots", json::array()},
       {"conflict_roots", json::array()}});
  const auto new_cut_root = cut_response.at("result").at("cut_root");
  const auto ref_response = builder.invoke(
      "ref-cas",
      {{"transition_id", action_id},
       {"ref_name", KFX_REGISTRY_REF},
       {"expected_old_cut_root", current.present ? json(current.cut_root) : json(nullptr)},
       {"expected_old_revision", current.revision},
       {"new_cut_root", new_cut_root},
       {"kind", current.present ? "advance" : "create"},
       {"reason_root", root_of({{"schema", "kungfu.kfx.settlement-reason/v1"}, {"settlementId", settlement_id}})}});
  const auto result = ref_response.at("result");
  const json receipt_identity = {{"schema", "kungfu.kfx.work-settlement-receipt/v1"},
                                 {"actionId", action_id},
                                 {"operation", operation},
                                 {"packageKey", key},
                                 {"outcome", "applied"},
                                 {"authorizationPlanRoot", authorization.at("authorizationPlanRoot")},
                                 {"capabilityGrantRoot", authorization.at("capabilityGrantRoot")},
                                 {"warrantRoot", authorization.at("warrantRoot")},
                                 {"authorityRoots", authorization.at("authorityRoots")},
                                 {"workObjectId", work_id},
                                 {"warrantObjectId", warrant_id},
                                 {"episodeObjectId", episode_id},
                                 {"settlementObjectId", settlement_id},
                                 {"priorCutRoot", authorization.at("basis").at("cutRoot")},
                                 {"authorityCutRoot", warrant_receipt.at("cutRoot")},
                                 {"cutRoot", result.at("current_cut_root")},
                                 {"priorRevision", authorization.at("basis").at("revision")},
                                 {"authorityRevision", warrant_receipt.at("revision")},
                                 {"revision", result.at("current_revision")},
                                 {"warrantReceiptRoot", warrant_receipt.at("receiptRoot")},
                                 {"kernelReceiptRoot", ref_response.at("receipt_root")},
                                 {"recordedAt", recorded_at},
                                 {"materialization", materialization}};
  auto receipt = receipt_identity;
  receipt["receiptRoot"] = root_of(receipt_identity);
  receipt["steps"] = builder.steps;
  return receipt;
}

json apply_lifecycle_mutation(const snapshot &value, const lifecycle_view &lifecycle, const json &plan,
                              const json &request, const std::string &runtime_dir) {
  const auto operation = required_text(request, "operation", "request");
  static const std::set<std::string> operations = {"install", "update",   "remove", "enable",
                                                   "disable", "activate", "qualify"};
  validate_enum(operation, operations, "lifecycle operation");
  const auto package_key = required_text(request, "packageKey", "request");
  const auto package = find_package(value.packages, package_key);
  if (package.is_null())
    refuse("KF_KFX_MEMBER_MISSING", "KFX package is not present in the registry: " + package_key);
  const auto &provider = provider_for(value, package_key);
  const auto prior_state = lifecycle.desired_states.contains(package_key) ? lifecycle.desired_states.at(package_key)
                                                                          : std::string{"dormant"};
  if (!request.contains("expectedRevision") || !request.at("expectedRevision").is_number_integer() ||
      request.at("expectedRevision").get<int64_t>() < 0 ||
      static_cast<uint64_t>(request.at("expectedRevision").get<int64_t>()) != lifecycle.revision)
    refuse("KF_KFX_CUT_STALE", "named KFX Fact Cut revision changed since planning");
  const json expected_cut = request.contains("expectedCutRoot") ? request.at("expectedCutRoot") : json(nullptr);
  const json actual_cut = lifecycle.present ? json(lifecycle.cut_root) : json(nullptr);
  if (expected_cut != actual_cut)
    refuse("KF_KFX_CUT_STALE", "named KFX Fact Cut root changed since planning");
  if (request.value("expectedRegistryRoot", "") != value.registry_root)
    refuse("KF_KFX_REGISTRY_STALE", "registry projection changed since planning");
  if (request.value("expectedGraphRoot", "") != value.graph_root)
    refuse("KF_KFX_GRAPH_STALE", "semantic graph root changed since planning");
  if (request.value("expectedPlanRoot", "") != plan.at("planRoot").get<std::string>())
    refuse("KF_KFX_PLAN_STALE", "load plan root changed since planning");
  if (request.value("expectedTrustRoot", "") != provider.at("trustRoot").get<std::string>())
    refuse("KF_KFX_ASSESSMENT_STALE", "provider trust root changed since planning");
  if (request.value("expectedPackageRoot", "") != package.at("packageRoot").get<std::string>())
    refuse("KF_KFX_REGISTRY_STALE", "package root changed since planning");
  const auto authorization = mutation_authorization_plan(value, lifecycle, request, plan);
  if (request.value("expectedAuthorizationPlanRoot", "") !=
      authorization.at("authorizationPlanRoot").get<std::string>())
    refuse("KF_KFX_AUTHORIZATION_STALE", "mutation authorization plan changed since planning");
  if (request.value("expectedCapabilityGrantRoot", "") != authorization.at("capabilityGrantRoot").get<std::string>())
    refuse("KF_KFX_CAPABILITY_GRANT_STALE", "mutation does not present the exact planned capability grant root");
  if (request.value("expectedWarrantRoot", "") != authorization.at("warrantRoot").get<std::string>())
    refuse("KF_KFX_WARRANT_INVALID", "mutation does not present the exact planned Warrant root");

  const auto runtime_root = lifecycle_root(runtime_dir);
  const auto install_root = fs::absolute(runtime_dir).parent_path() / "extensions";
  const auto destination = install_root / package_key;
  const auto source = fs::path(package.at("path").get<std::string>());
  const auto next_revision = lifecycle.revision + 2;
  fs::path retained_path;
  fs::path staged_path;
  fs::path content_path;
  bool destination_replaced = false;
  bool destination_materialized = false;
  bool appending_receipt = false;
  json warrant_receipt = nullptr;

  auto rollback = [&] {
    std::error_code ignored;
    if (destination_materialized && fs::exists(destination))
      fs::rename(destination, staged_path, ignored);
    if (destination_replaced && !retained_path.empty() && fs::exists(retained_path) && !fs::exists(destination))
      fs::rename(retained_path, destination, ignored);
    if (!staged_path.empty() && fs::exists(staged_path))
      fs::remove_all(staged_path, ignored);
  };

  if (operation == "install" && fs::exists(destination) && !request.value("replaceExisting", false))
    refuse("KF_KFX_PACKAGE_DUPLICATE", "KFX package is already installed: " + package_key);
  if (operation == "update" && !fs::exists(destination))
    refuse("KF_KFX_MEMBER_MISSING", "cannot update an absent KFX package: " + package_key);
  if (operation == "remove") {
    const auto canonical_destination = fs::weakly_canonical(source);
    const auto canonical_install_root = fs::weakly_canonical(install_root);
    if (canonical_destination.parent_path() != canonical_install_root)
      refuse("KF_KFX_PATH_TRAVERSAL", "remove is confined to the managed KFX install root");
  }
  const auto planned_stage = install_root / (".kfx-stage-" + package_key + "-" + std::to_string(next_revision));
  if ((operation == "install" || operation == "update") && fs::exists(planned_stage))
    refuse("KF_KFX_WRITER_BUSY", "a staged KFX package already exists for this Fact Cut revision");

  try {
    warrant_receipt = issue_fact_work_authority(runtime_dir, value, lifecycle, authorization);
    if (operation == "install" || operation == "update") {
      content_path = runtime_root / "content" / package.at("packageRoot").get<std::string>().substr(7);
      fs::create_directories(content_path.parent_path());
      if (!fs::exists(content_path)) {
        fs::copy(source, content_path, fs::copy_options::recursive);
      } else if (root_of(package_closure(content_path)) != package.at("packageRoot").get<std::string>()) {
        refuse("KF_KFX_SCHEMA_INVALID", "retained KFX content does not match its package root");
      }
      fs::create_directories(install_root);
      staged_path = install_root / (".kfx-stage-" + package_key + "-" + std::to_string(next_revision));
      if (fs::exists(staged_path))
        refuse("KF_KFX_WRITER_BUSY", "a staged KFX package already exists for this Fact Cut revision");
      fs::copy(content_path, staged_path, fs::copy_options::recursive);
      if (fs::exists(destination)) {
        if (operation == "install" && !request.value("replaceExisting", false))
          refuse("KF_KFX_PACKAGE_DUPLICATE", "KFX package is already installed: " + package_key);
        retained_path =
            runtime_root / "retained" /
            (std::to_string(next_revision) + "-" + package_key + "-" + root_of(package_closure(destination)).substr(7));
        fs::create_directories(retained_path.parent_path());
        fs::rename(destination, retained_path);
        destination_replaced = true;
      } else if (operation == "update") {
        refuse("KF_KFX_MEMBER_MISSING", "cannot update an absent KFX package: " + package_key);
      }
      fs::rename(staged_path, destination);
      destination_materialized = true;
    } else if (operation == "remove") {
      const auto canonical_destination = fs::weakly_canonical(source);
      const auto canonical_install_root = fs::weakly_canonical(install_root);
      if (canonical_destination.parent_path() != canonical_install_root)
        refuse("KF_KFX_PATH_TRAVERSAL", "remove is confined to the managed KFX install root");
      retained_path = runtime_root / "retained" /
                      (std::to_string(next_revision) + "-" + package_key + "-" +
                       package.at("packageRoot").get<std::string>().substr(7));
      fs::create_directories(retained_path.parent_path());
      fs::rename(canonical_destination, retained_path);
      destination_replaced = true;
    }

    const auto desired_state = operation == "remove" || operation == "disable" ? "dormant"
                               : operation == "qualify"                        ? prior_state
                                                                               : "active";
    const auto observed_state = provider.at("state") == "degraded" ? "degraded" : "applied";
    snapshot accepted = value;
    for (auto &accepted_package : accepted.packages) {
      if (accepted_package.at("key") != package_key)
        continue;
      if (operation == "remove" && !retained_path.empty())
        accepted_package["path"] = retained_path.string();
      else if (!destination.empty() && fs::exists(destination))
        accepted_package["path"] = destination.string();
      accepted_package["candidate"] = false;
      accepted_package["installed"] = operation != "remove";
      accepted_package["admitted"] = operation != "remove" && operation != "disable";
      accepted_package["runtimeTier"] = "isolated";
      accepted_package["grantedCapabilities"] = authorization.at("grantedCapabilities");
      const auto assessment = authorization.at("assessment");
      if (!assessment.is_null()) {
        const auto &report = assessment.at("trustReport");
        accepted_package["supplyChainGrade"] = report.at("supplyChainGrade");
        accepted_package["admissionGrade"] = report.at("admissionGrade");
        accepted_package["productSystem"] = report.at("admissionGrade") == "product-system";
      } else {
        accepted_package["supplyChainGrade"] = "unverified";
        accepted_package["admissionGrade"] = "unverified";
        accepted_package["productSystem"] = false;
      }
      accepted_package["authority"] = {
          {"schema", "kungfu.kfx-package-authority/v1"},
          {"packageRoot", accepted_package.at("packageRoot")},
          {"manifestRoot", accepted_package.at("manifestRoot")},
          {"reportRoot", authorization.at("authorityRoots").at("reportRoot")},
          {"admissionPlanRoot", authorization.at("authorityRoots").at("admissionPlanRoot")},
          {"corePolicyRoot", authorization.at("authorityRoots").at("corePolicyRoot")},
          {"requestedPolicyRoot", authorization.at("authorityRoots").at("requestedPolicyRoot")},
          {"policyRoot", authorization.at("authorityRoots").at("policyRoot")},
          {"receiptDependencyRoot", authorization.at("authorityRoots").at("receiptDependencyRoot")},
          {"authorizationPlanRoot", authorization.at("authorizationPlanRoot")},
          {"capabilityDeclarationRoot", authorization.at("capabilityDeclarationRoot")},
          {"capabilityGrantRoot", authorization.at("capabilityGrantRoot")},
          {"warrantRoot", authorization.at("warrantRoot")},
          {"grantedCapabilities", authorization.at("grantedCapabilities")}};
    }
    json structural_diagnostics = json::array();
    for (const auto &diagnostic : accepted.diagnostics) {
      if (diagnostic.value("code", "") == "KF_KFX_OPTIONAL_MEMBER_MISSING")
        structural_diagnostics.push_back(diagnostic);
    }
    accepted.diagnostics = structural_diagnostics;
    accepted.graph = semantic_graph(accepted.packages, accepted.diagnostics);
    accepted.graph_root = accepted.graph.at("graphRoot").get<std::string>();
    json accepted_package_identity = json::array();
    for (const auto &accepted_package : accepted.packages) {
      accepted_package_identity.push_back(
          {{"key", accepted_package.at("key")},
           {"rootKind", accepted_package.at("rootKind")},
           {"packageRoot", accepted_package.at("packageRoot")},
           {"manifestRoot", accepted_package.at("manifestRoot")},
           {"apiCompatibility", accepted_package.at("apiCompatibility")},
           {"facets", accepted_package.at("facets")},
           {"runtimeTier", accepted_package.at("runtimeTier")},
           {"admissionGrade", accepted_package.at("admissionGrade")},
           {"productSystem", accepted_package.at("productSystem")},
           {"grantedCapabilities", accepted_package.at("grantedCapabilities")},
           {"capabilityGrantRoot", accepted_package.at("authority").at("capabilityGrantRoot")},
           {"hosts", accepted_package.at("hosts")}});
    }
    accepted.registry_root = root_of({{"schema", "kungfu.kfx-registry-snapshot/v2"},
                                      {"packages", accepted_package_identity},
                                      {"suites", accepted.suites},
                                      {"diagnostics", accepted.diagnostics}});
    const json materialization = {{"contentPath", content_path.empty() ? nullptr : json(content_path.string())},
                                  {"retainedPath", retained_path.empty() ? nullptr : json(retained_path.string())},
                                  {"destinationPath", destination.string()}};
    appending_receipt = true;
    const auto authorized_lifecycle = load_lifecycle(runtime_dir);
    if (!authorized_lifecycle.present ||
        authorized_lifecycle.cut_root != warrant_receipt.at("cutRoot").get<std::string>() ||
        authorized_lifecycle.revision != warrant_receipt.at("revision"))
      refuse("KF_KFX_WARRANT_INVALID", "issued Warrant Cut is not the current mutation authority");
    auto receipt = commit_fact_work(runtime_dir, accepted, authorized_lifecycle, request, operation, desired_state,
                                    observed_state, materialization, authorization, warrant_receipt);
    return {{"schema", "kungfu.kfx.lifecycle-application/v2"},
            {"applied", true},
            {"cutRoot", receipt.at("cutRoot")},
            {"revision", receipt.at("revision")},
            {"desiredState", desired_state},
            {"observedState", observed_state},
            {"verdict", provider.at("state") == "degraded" ? "degraded"
                        : desired_state == "dormant"       ? "dormant"
                                                           : "active"},
            {"receipt", receipt}};
  } catch (const std::invalid_argument &error) {
    rollback();
    if (appending_receipt)
      throw;
    const std::string detail = error.what();
    const auto separator = detail.find(':');
    const auto code = detail.starts_with("KF_") ? detail.substr(0, separator) : "KF_KFX_SCHEMA_INVALID";
    refuse(code, detail);
  } catch (const std::exception &error) {
    rollback();
    if (appending_receipt)
      throw;
    refuse("KF_KFX_SCHEMA_INVALID", error.what());
  } catch (...) {
    rollback();
    if (appending_receipt)
      throw;
    refuse("KF_KFX_SCHEMA_INVALID", "unknown native KFX lifecycle failure");
  }
  return json::object();
}

snapshot merge_candidate_observation(const snapshot &authority, const snapshot &candidate) {
  snapshot result = authority;
  std::map<std::string, json> packages;
  for (const auto &package : authority.packages)
    packages[package.at("key").get<std::string>()] = package;
  for (const auto &package : candidate.packages)
    packages[package.at("key").get<std::string>()] = package;
  result.packages = json::array();
  for (const auto &[ignored, package] : packages) {
    (void)ignored;
    result.packages.push_back(package);
  }
  std::map<std::string, json> suites;
  for (const auto &suite : authority.suites)
    suites[suite.at("suiteKey").get<std::string>()] = suite;
  for (const auto &suite : candidate.suites)
    suites[suite.at("suiteKey").get<std::string>()] = suite;
  result.suites = json::array();
  for (const auto &[ignored, suite] : suites) {
    (void)ignored;
    result.suites.push_back(suite);
  }
  result.diagnostics = candidate.diagnostics;
  result.graph = semantic_graph(result.packages, result.diagnostics);
  result.graph_root = result.graph.at("graphRoot").get<std::string>();
  json package_identity = json::array();
  for (const auto &package : result.packages) {
    package_identity.push_back(
        {{"key", package.at("key")},
         {"rootKind", package.at("rootKind")},
         {"packageRoot", package.at("packageRoot")},
         {"manifestRoot", package.at("manifestRoot")},
         {"apiCompatibility", package.at("apiCompatibility")},
         {"facets", package.at("facets")},
         {"runtimeTier", package.at("runtimeTier")},
         {"admissionGrade", package.at("admissionGrade")},
         {"productSystem", package.at("productSystem")},
         {"grantedCapabilities", package.at("grantedCapabilities")},
         {"capabilityGrantRoot",
          package.contains("authority") ? package.at("authority").at("capabilityGrantRoot") : json(nullptr)},
         {"hosts", package.at("hosts")}});
  }
  result.registry_root = root_of({{"schema", "kungfu.kfx-registry-snapshot/v2"},
                                  {"packages", package_identity},
                                  {"suites", result.suites},
                                  {"diagnostics", result.diagnostics}});
  return result;
}

snapshot empty_observation() {
  snapshot result;
  result.graph = semantic_graph(result.packages, result.diagnostics);
  result.graph_root = result.graph.at("graphRoot").get<std::string>();
  result.registry_root = root_of({{"schema", "kungfu.kfx-registry-snapshot/v2"},
                                  {"packages", json::array()},
                                  {"suites", json::array()},
                                  {"diagnostics", json::array()}});
  return result;
}

} // namespace

json native_kfx_control_bootstrap_policy() { return control_bootstrap_policy(); }

static json query_native_kfx_registry_unchecked(const std::string &action, const json &request,
                                                const std::string &runtime_dir) {
  static const std::set<std::string> actions = {"list",   "inspect", "resolve",        "plan",   "status",
                                                "assess", "apply",   "authorize-host", "history"};
  if (!actions.contains(action))
    refuse("KF_KFX_AUTHORITY_CLAIM_FORBIDDEN", "unsupported native KFX registry operation: " + action);
  const auto controller = request.value("controller", "");
  const bool control_request = !controller.empty();
  if (control_request && controller != KFX_CONTROL_SUITE_ID)
    refuse("KF_KFX_CONTROL_IDENTITY_MISMATCH", "unknown KFX lifecycle controller");
  for (const auto *field : {"bootstrapPolicy", "systemAuthority", "grantedCapabilities"}) {
    if (request.contains(field))
      refuse("KF_KFX_CONTROL_SELF_GRANT",
             std::string("caller may not supply embedded Control Suite authority field ") + field);
  }
  if (action == "history")
    return lifecycle_history(runtime_dir, request);
  if (action == "apply" && runtime_dir.empty())
    refuse("KF_KFX_AUTHORITY_CLAIM_FORBIDDEN", "native KFX mutation requires an explicit runtime directory");
  std::optional<lifecycle_writer_lock> writer_lock;
  if (action == "apply")
    writer_lock.emplace(runtime_dir);
  const auto lifecycle = load_lifecycle(runtime_dir);
  auto snapshot_request = request;
  if (action == "apply")
    snapshot_request.erase("expectedRegistryRoot");
  const bool has_observation = snapshot_request.contains("roots") && snapshot_request.at("roots").is_array() &&
                               !snapshot_request.at("roots").empty();
  snapshot selected;
  if (lifecycle.present) {
    selected = lifecycle.authoritative;
    const auto operation = request.value("operation", "");
    if (has_observation && (operation == "install" || operation == "update")) {
      selected = merge_candidate_observation(selected, build_snapshot(snapshot_request));
    }
  } else if (has_observation) {
    selected = build_snapshot(snapshot_request);
  } else if (action == "list" || action == "status") {
    selected = empty_observation();
  } else {
    refuse("KF_KFX_CUT_MISSING", "no named KFX Fact Cut exists; provide a bounded discovery observation to plan");
  }
  const auto load_plan = lifecycle_plan(selected, lifecycle, request);
  if (action == "authorize-host")
    return authorize_host_launch(load_plan.at("hostContract"), lifecycle, request);
  if (control_request && action == "apply") {
    const auto candidate = find_package(selected.packages, KFX_CONTROL_PACKAGE_KEY);
    const json actual_cut = lifecycle.present ? json(lifecycle.cut_root) : json(nullptr);
    if (!request.contains("expectedRevision") || !request.at("expectedRevision").is_number_integer() ||
        request.at("expectedRevision").get<int64_t>() < 0 ||
        static_cast<uint64_t>(request.at("expectedRevision").get<int64_t>()) != lifecycle.revision ||
        !request.contains("expectedCutRoot") || request.at("expectedCutRoot") != actual_cut || candidate.is_null() ||
        request.value("expectedPackageRoot", "") != candidate.value("packageRoot", ""))
      refuse("KF_KFX_CONTROL_PLAN_STALE", "Control Suite Cut or candidate root changed since planning");
    const auto planned = control_plan(selected, lifecycle, request, load_plan);
    if (request.value("expectedControlPlanRoot", "") != planned.at("controlPlanRoot").get<std::string>())
      refuse("KF_KFX_CONTROL_PLAN_STALE", "Control Suite plan root changed since authorization");
    if (request.value("expectedBootstrapPolicyRoot", "") != planned.at("bootstrapPolicyRoot").get<std::string>())
      refuse("KF_KFX_CONTROL_POLICY_STALE", "Control Suite bootstrap policy root changed since authorization");
    const auto application = apply_lifecycle_mutation(selected, lifecycle, load_plan, request, runtime_dir);
    const auto settled = load_lifecycle(runtime_dir);
    return {{"schema", "kungfu.kfx.control-suite-application/v1"},
            {"controllerId", KFX_CONTROL_SUITE_ID},
            {"controlPlanRoot", planned.at("controlPlanRoot")},
            {"bootstrapPolicyRoot", planned.at("bootstrapPolicyRoot")},
            {"authorizationPlanRoot", planned.at("authorizationPlanRoot")},
            {"capabilityGrantRoot", planned.at("capabilityGrantRoot")},
            {"warrantRoot", planned.at("warrantRoot")},
            {"application", application},
            {"status", control_status(settled)},
            {"verified", true}};
  }
  if (action == "apply")
    return apply_lifecycle_mutation(selected, lifecycle, load_plan, request, runtime_dir);
  if (control_request && action == "status")
    return control_status(lifecycle);
  if (control_request && action == "plan")
    return control_plan(selected, lifecycle, request, load_plan);
  if (control_request)
    refuse("KF_KFX_CONTROL_OPERATION_REJECTED", "Control Suite supports only public status, plan, and apply");
  const json cut_root = lifecycle.present ? json(lifecycle.cut_root) : json(nullptr);
  if (action == "status") {
    return {{"schema", "kungfu.kfx.registry-status/v3"},
            {"authority", lifecycle.present ? "yijinjing-hana-pod-journal" : "observation-preview"},
            {"domainProfileRoot", native_kfx_domain_profile().at("domainProfileRoot")},
            {"cutRef", KFX_REGISTRY_REF},
            {"cutRoot", cut_root},
            {"revision", lifecycle.revision},
            {"writer", "one-libkungfu-writer-per-runtime-directory"},
            {"readOnly", false},
            {"cacheAuthority", false},
            {"registryRoot", selected.registry_root},
            {"graphRoot", selected.graph_root},
            {"packageCount", selected.packages.size()},
            {"suiteCount", selected.suites.size()},
            {"diagnostics", selected.diagnostics}};
  }
  if (action == "list") {
    json packages = json::array();
    for (const auto &package : selected.packages) {
      auto projected = public_package(package);
      const auto key = package.at("key").get<std::string>();
      const auto desired =
          lifecycle.desired_states.contains(key) ? lifecycle.desired_states.at(key) : std::string{"dormant"};
      const auto observed =
          lifecycle.observed_states.contains(key) ? lifecycle.observed_states.at(key) : std::string{"unknown"};
      projected["desiredState"] = desired;
      projected["observedState"] = observed;
      projected["verdict"] = derived_verdict(provider_for(selected, key), desired, observed);
      projected["state"] = projected["verdict"];
      projected["providerRoot"] = provider_for(selected, key).at("providerRoot");
      packages.push_back(projected);
    }
    return {{"schema", "kungfu.kfx.registry-list/v3"},
            {"authority", lifecycle.present ? "pinned-fact-cut" : "observation-preview"},
            {"cutRef", KFX_REGISTRY_REF},
            {"cutRoot", cut_root},
            {"revision", lifecycle.revision},
            {"registryRoot", selected.registry_root},
            {"graphRoot", selected.graph_root},
            {"packages", packages},
            {"diagnostics", selected.diagnostics}};
  }
  if (action == "inspect") {
    const auto key = required_text(request, "packageKey", "request");
    const auto package = find_package(selected.packages, key);
    if (package.is_null())
      refuse("KF_KFX_MEMBER_MISSING", "KFX package is not present in the registry: " + key);
    auto projected = package;
    projected.erase("semantic");
    projected["provider"] = provider_for(selected, key);
    const auto desired =
        lifecycle.desired_states.contains(key) ? lifecycle.desired_states.at(key) : std::string{"dormant"};
    const auto observed =
        lifecycle.observed_states.contains(key) ? lifecycle.observed_states.at(key) : std::string{"unknown"};
    projected["desiredState"] = desired;
    projected["observedState"] = observed;
    projected["verdict"] = derived_verdict(projected.at("provider"), desired, observed);
    projected["state"] = projected["verdict"];
    return {{"schema", "kungfu.kfx.registry-inspection/v3"},
            {"authority", lifecycle.present ? "pinned-fact-cut" : "observation-preview"},
            {"cutRef", KFX_REGISTRY_REF},
            {"cutRoot", cut_root},
            {"revision", lifecycle.revision},
            {"registryRoot", selected.registry_root},
            {"graphRoot", selected.graph_root},
            {"package", projected},
            {"diagnostics", selected.diagnostics}};
  }
  if (action == "assess") {
    const auto key = required_text(request, "packageKey", "request");
    const auto package = find_package(selected.packages, key);
    if (package.is_null())
      refuse("KF_KFX_MEMBER_MISSING", "KFX package is not present in the registry: " + key);
    auto result = assess_package(package, selected.registry_root, request);
    result["authority"] = lifecycle.present ? "pinned-fact-cut" : "observation-preview";
    result["cutRef"] = KFX_REGISTRY_REF;
    result["cutRoot"] = cut_root;
    result["revision"] = lifecycle.revision;
    result["registryRoot"] = selected.registry_root;
    result["graphRoot"] = selected.graph_root;
    result["diagnostics"] = selected.diagnostics;
    return result;
  }
  if (action == "resolve") {
    const auto key = required_text(request, "suiteKey", "request");
    for (const auto &suite : selected.suites) {
      if (suite.at("suiteKey") == key)
        return {{"schema", "kungfu.kfx.registry-resolution/v3"},
                {"authority", lifecycle.present ? "pinned-fact-cut" : "observation-preview"},
                {"cutRef", KFX_REGISTRY_REF},
                {"cutRoot", cut_root},
                {"revision", lifecycle.revision},
                {"registryRoot", selected.registry_root},
                {"graphRoot", selected.graph_root},
                {"suite", suite},
                {"diagnostics", selected.diagnostics}};
    }
    refuse("KF_KFX_MEMBER_MISSING", "KFX Suite is not present in the registry: " + key);
  }

  if (action == "plan" && !request.value("operation", "").empty()) {
    const auto authorization = mutation_authorization_plan(selected, lifecycle, request, load_plan);
    auto result = load_plan;
    result["mutationAuthorization"] = authorization;
    result["authorizationPlanRoot"] = authorization.at("authorizationPlanRoot");
    result["capabilityGrantRoot"] = authorization.at("capabilityGrantRoot");
    result["warrantRoot"] = authorization.at("warrantRoot");
    return result;
  }
  return load_plan;
}

json native_kfx_domain_profile() {
  const auto profile = embedded_domain_profile();
  auto result = profile;
  result["domainProfileRoot"] = root_of(profile);
  return result;
}

json query_native_kfx_registry(const std::string &action, const json &request, const std::string &runtime_dir) {
  try {
    return query_native_kfx_registry_unchecked(action, request, runtime_dir);
  } catch (const json::exception &error) {
    refuse("KF_KFX_SCHEMA_INVALID", "invalid KFX registry document: " + std::string(error.what()));
  }
}

} // namespace kungfu::runtime::kfx
