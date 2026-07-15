// SPDX-License-Identifier: Apache-2.0

#include <kungfu/runtime/kfx/native_registry.h>

#include <algorithm>
#include <cctype>
#include <filesystem>
#include <fstream>
#include <functional>
#include <map>
#include <set>
#include <stdexcept>
#include <string>
#include <vector>

#include <kungfu/runtime/kfx/native_contract.h>
#include <kungfu/runtime/profile/profile_lifecycle.h>
#include <kungfu/yijinjing/storage/content_hash.h>

namespace kungfu::runtime::kfx {

namespace {

namespace fs = std::filesystem;
using json = nlohmann::json;

inline constexpr size_t MAX_PACKAGE_FILES = 10000;
inline constexpr size_t MAX_PACKAGES = 4096;

[[noreturn]] void refuse(const std::string &code, const std::string &message) {
  throw std::invalid_argument(code + ": " + message);
}

std::string sha256(const std::string &value) {
  return yijinjing::storage::compute_content_hash_value(value, yijinjing::storage::CONTENT_HASH_ALGORITHM_SHA256);
}

std::string root_of(const json &value) { return "sha256:" + sha256(value.dump()); }

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

std::vector<fs::path> package_directories(const fs::path &root) {
  std::set<fs::path> result;
  if (fs::is_regular_file(root / "package.json"))
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
    if (fs::is_regular_file(iterator->path() / "package.json", error))
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
  std::string registry_root;
};

std::string mapped_value(const json &mapping, const std::string &key, const std::string &fallback) {
  if (!mapping.contains(key))
    return fallback;
  if (!mapping.at(key).is_string() || mapping.at(key).get<std::string>().empty())
    refuse("KF_KFX_SCHEMA_INVALID", "registry mapping value must be a non-empty string: " + key);
  return mapping.at(key).get<std::string>();
}

void validate_enum(const std::string &value, const std::set<std::string> &allowed, const std::string &label) {
  if (!allowed.contains(value))
    refuse("KF_KFX_SCHEMA_INVALID", label + " is not supported: " + value);
}

json host_placements(const json &manifest, const json &overrides, const std::string &key) {
  static const std::set<std::string> known = {
      "gui", "adapter-node", "adapter-python", "service-node", "service-python", "service-cpp", "wasm", "profile"};
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
  if (overrides.contains(key)) {
    if (!overrides.at(key).is_array())
      refuse("KF_KFX_SCHEMA_INVALID", "hostPlacements entries must be arrays");
    hosts.clear();
    for (const auto &host : overrides.at(key)) {
      if (!host.is_string() || !known.contains(host.get<std::string>()))
        refuse("KF_KFX_HOST_UNKNOWN", "unknown KFX host placement for " + key);
      hosts.insert(host.get<std::string>());
    }
  }
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

snapshot build_snapshot(const json &request) {
  if (!request.is_object() || !request.contains("roots") || !request.at("roots").is_array() ||
      request.at("roots").empty())
    refuse("KF_KFX_SCHEMA_INVALID", "registry request requires explicit non-empty roots");
  for (const auto *field : {"admissionGrades", "installed", "admitted", "systemAuthority"}) {
    if (request.contains(field))
      refuse("KF_KFX_AUTHORITY_CLAIM_FORBIDDEN",
             std::string("read-only registry request may not claim Core admission field ") + field);
  }
  const auto runtime_tiers = object_or_empty(request, "runtimeTiers");
  const auto placements = object_or_empty(request, "hostPlacements");
  const std::set<std::string> tier_values = {"first-party-pinned", "verified-third-party", "untrusted"};
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
      const auto manifest_bytes = read_file(package_path / "package.json");
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
      const auto tier = mapped_value(runtime_tiers, key, "untrusted");
      validate_enum(tier, tier_values, "runtime tier");
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
                      {"runtimeTier", tier},
                      {"admissionGrade", "unverified"},
                      {"hosts", host_placements(manifest, placements, key)},
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

  json package_identity = json::array();
  for (const auto &package : result.packages) {
    package_identity.push_back({{"key", package.at("key")},
                                {"rootKind", package.at("rootKind")},
                                {"packageRoot", package.at("packageRoot")},
                                {"manifestRoot", package.at("manifestRoot")},
                                {"apiCompatibility", package.at("apiCompatibility")},
                                {"facets", package.at("facets")},
                                {"runtimeTier", package.at("runtimeTier")},
                                {"admissionGrade", package.at("admissionGrade")},
                                {"hosts", package.at("hosts")}});
  }
  json registry_identity = {{"schema", "kungfu.kfx-registry-snapshot/v1"},
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
  return package;
}

} // namespace

static json query_native_kfx_registry_unchecked(const std::string &action, const json &request) {
  static const std::set<std::string> actions = {"list", "inspect", "resolve", "plan", "status"};
  if (!actions.contains(action))
    refuse("KF_KFX_AUTHORITY_CLAIM_FORBIDDEN", "native KFX registry is read-only: " + action);
  const auto snapshot = build_snapshot(request);
  if (action == "status") {
    return {{"schema", "kungfu.kfx.registry-status/v1"},
            {"authority", "libkungfu"},
            {"readOnly", true},
            {"cacheAuthority", false},
            {"registryRoot", snapshot.registry_root},
            {"packageCount", snapshot.packages.size()},
            {"suiteCount", snapshot.suites.size()},
            {"diagnostics", snapshot.diagnostics}};
  }
  if (action == "list") {
    json packages = json::array();
    for (const auto &package : snapshot.packages)
      packages.push_back(public_package(package));
    return {{"schema", "kungfu.kfx.registry-list/v1"},
            {"registryRoot", snapshot.registry_root},
            {"packages", packages},
            {"diagnostics", snapshot.diagnostics}};
  }
  if (action == "inspect") {
    const auto key = required_text(request, "packageKey", "request");
    const auto package = find_package(snapshot.packages, key);
    if (package.is_null())
      refuse("KF_KFX_MEMBER_MISSING", "KFX package is not present in the registry: " + key);
    return {{"schema", "kungfu.kfx.registry-inspection/v1"},
            {"registryRoot", snapshot.registry_root},
            {"package", package},
            {"diagnostics", snapshot.diagnostics}};
  }
  if (action == "resolve") {
    const auto key = required_text(request, "suiteKey", "request");
    for (const auto &suite : snapshot.suites) {
      if (suite.at("suiteKey") == key)
        return {{"schema", "kungfu.kfx.registry-resolution/v1"},
                {"registryRoot", snapshot.registry_root},
                {"suite", suite},
                {"diagnostics", snapshot.diagnostics}};
    }
    refuse("KF_KFX_MEMBER_MISSING", "KFX Suite is not present in the registry: " + key);
  }

  json package_plan = json::array();
  for (const auto &package : snapshot.packages) {
    package_plan.push_back({{"key", package.at("key")},
                            {"rootKind", package.at("rootKind")},
                            {"packageRoot", package.at("packageRoot")},
                            {"apiCompatibility", package.at("apiCompatibility")},
                            {"facets", package.at("facets")},
                            {"runtimeTier", package.at("runtimeTier")},
                            {"admissionGrade", package.at("admissionGrade")},
                            {"hosts", package.at("hosts")},
                            {"declaredCapabilities", package.at("declaredCapabilities")}});
  }
  json identity = {
      {"schema", "kungfu.kfx.load-plan/v1"}, {"registryRoot", snapshot.registry_root}, {"packages", package_plan},
      {"suites", snapshot.suites},           {"diagnostics", snapshot.diagnostics},    {"readOnly", true}};
  auto result = identity;
  result["planRoot"] = root_of(identity);
  return result;
}

json query_native_kfx_registry(const std::string &action, const json &request) {
  try {
    return query_native_kfx_registry_unchecked(action, request);
  } catch (const json::exception &error) {
    refuse("KF_KFX_SCHEMA_INVALID", "invalid KFX registry document: " + std::string(error.what()));
  }
}

} // namespace kungfu::runtime::kfx
