// SPDX-License-Identifier: Apache-2.0

#include <kungfu/runtime/profile/profile_lifecycle.h>

#include <kungfu/runtime/action/action_canonical_json.h>
#include <kungfu/runtime/action_recorder.h>
#include <kungfu/runtime/profile/profile_lifecycle_schema.h>
#include <kungfu/runtime/profile/profile_source_contract.h>
#include <kungfu/view/action_envelope.h>
#include <kungfu/view/schema.h>
#include <kungfu/yijinjing/journal/assemble.h>
#include <kungfu/yijinjing/storage/content_hash.h>
#include <kungfu/yijinjing/storage/episode_manifest.h>
#include <kungfu/yijinjing/time.h>

#include <algorithm>
#include <cctype>
#include <filesystem>
#include <fstream>
#include <map>
#include <memory>
#include <regex>
#include <set>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

namespace kungfu::runtime::profile {

namespace fs = std::filesystem;
namespace action = kungfu::runtime::action;
namespace yy = kungfu::yijinjing;
namespace yy_storage = kungfu::yijinjing::storage;

namespace {

constexpr uint32_t EVENT_SCHEMA_VERSION = 1;
constexpr const char *PROFILE_SCHEMA_V1 = "kungfu.profile-suite/v1";
constexpr const char *PROFILE_NAMESPACE = "profile";
constexpr const char *PROFILE_JOURNAL_NAME = "lifecycle";

struct schema_contract {
  view::schema_handle handle;
  std::string root;
};

struct lifecycle_record {
  nlohmann::json event = nlohmann::json::object();
  uint64_t frame_uid = 0;
};

struct root_state {
  nlohmann::json closure = nlohmann::json::object();
  bool installed = false;
  bool qualified = false;
  bool activated = false;
  nlohmann::json qualification = nlohmann::json::object();
  nlohmann::json kfd3_qualification = nlohmann::json::object();
  nlohmann::json granted_permissions = nlohmann::json::array();
};

struct profile_state {
  std::string profile_id;
  std::string current_root;
  uint64_t revision = 0;
  bool removed = false;
  std::map<std::string, root_state> roots;
  lifecycle_record latest;
};

std::string content_root(const std::string &value) {
  return yy_storage::format_content_hash(yy_storage::compute_content_hash(value));
}

std::string bare_sha256(const std::string &value) {
  return yy_storage::compute_content_hash_value(value, yy_storage::CONTENT_HASH_ALGORITHM_SHA256);
}

const schema_contract &lifecycle_schema() {
  static const auto contract = [] {
    const auto compiled = view::compile_schema(schema::PROFILE_LIFECYCLE_EVENT_FBS, false);
    if (!compiled.ok) {
      throw std::runtime_error("cannot compile Profile lifecycle schema: " + compiled.error);
    }
    return schema_contract{view::schema_handle::from_bytes(compiled.bfbs),
                           content_root(std::string(schema::PROFILE_LIFECYCLE_EVENT_FBS))};
  }();
  return contract;
}

std::string required_text(const nlohmann::json &value, const char *field);
std::string text_or(const nlohmann::json &value, const char *field, const std::string &fallback = {});

struct source_contract {
  nlohmann::json document;
  nlohmann::json profile_schema;
  std::string root;
};

const source_contract &kfx_source_contract() {
  static const auto contract = [] {
    auto document = nlohmann::json::parse(schema::KFX_CONTRACT_JSON);
    if (!document.contains("profileSuiteSchema") || !document.at("profileSuiteSchema").is_object()) {
      throw std::runtime_error("embedded KFX contract has no profileSuiteSchema");
    }
    return source_contract{document, document.at("profileSuiteSchema"), content_root(document.dump())};
  }();
  return contract;
}

const nlohmann::json &resolve_schema_ref(const nlohmann::json &root, const std::string &reference) {
  constexpr const char *prefix = "#/$defs/";
  if (!reference.starts_with(prefix)) {
    throw std::invalid_argument("Profile schema contains an unsupported reference: " + reference);
  }
  const auto key = reference.substr(std::char_traits<char>::length(prefix));
  if (!root.contains("$defs") || !root.at("$defs").contains(key)) {
    throw std::invalid_argument("Profile schema reference is missing: " + reference);
  }
  return root.at("$defs").at(key);
}

void validate_schema_value(const nlohmann::json &value, const nlohmann::json &rule, const nlohmann::json &root,
                           const std::string &path) {
  if (rule.contains("$ref")) {
    validate_schema_value(value, resolve_schema_ref(root, required_text(rule, "$ref")), root, path);
    return;
  }
  if (rule.contains("const") && value != rule.at("const")) {
    throw std::invalid_argument(path + " does not match the KFX contract constant");
  }
  const auto type = text_or(rule, "type");
  if (type == "object") {
    if (!value.is_object())
      throw std::invalid_argument(path + " must be an object");
    if (rule.contains("required")) {
      for (const auto &field : rule.at("required")) {
        if (!value.contains(field.get<std::string>())) {
          throw std::invalid_argument(path + " is missing " + field.get<std::string>());
        }
      }
    }
    const auto properties = rule.value("properties", nlohmann::json::object());
    if (rule.value("additionalProperties", true) == false) {
      for (const auto &[field, ignored] : value.items()) {
        (void)ignored;
        if (!properties.contains(field))
          throw std::invalid_argument(path + " contains unknown field " + field);
      }
    }
    for (const auto &[field, child] : properties.items()) {
      if (value.contains(field))
        validate_schema_value(value.at(field), child, root, path + "." + field);
    }
  } else if (type == "array") {
    if (!value.is_array())
      throw std::invalid_argument(path + " must be an array");
    if (rule.contains("minItems") && value.size() < rule.at("minItems").get<size_t>()) {
      throw std::invalid_argument(path + " has too few items");
    }
    if (rule.value("uniqueItems", false)) {
      std::set<std::string> identities;
      for (const auto &item : value) {
        if (!identities.insert(item.dump()).second)
          throw std::invalid_argument(path + " contains duplicate items");
      }
    }
    if (rule.contains("items")) {
      size_t index = 0;
      for (const auto &item : value) {
        validate_schema_value(item, rule.at("items"), root, path + "[" + std::to_string(index++) + "]");
      }
    }
  } else if (type == "string") {
    if (!value.is_string())
      throw std::invalid_argument(path + " must be a string");
    const auto text = value.get<std::string>();
    if (rule.contains("minLength") && text.size() < rule.at("minLength").get<size_t>()) {
      throw std::invalid_argument(path + " is too short");
    }
    if (rule.contains("pattern") && !std::regex_match(text, std::regex(rule.at("pattern").get<std::string>()))) {
      throw std::invalid_argument(path + " does not match the KFX contract pattern");
    }
  } else if (!type.empty()) {
    throw std::invalid_argument("Profile schema uses an unsupported JSON type: " + type);
  }
}

void validate_source_contract(const nlohmann::json &profile) {
  const auto &contract = kfx_source_contract();
  validate_schema_value(profile, contract.profile_schema, contract.profile_schema, "profile");
}

std::string required_text(const nlohmann::json &value, const char *field) {
  if (!value.is_object() || !value.contains(field) || !value.at(field).is_string() ||
      value.at(field).get<std::string>().empty()) {
    throw std::invalid_argument(std::string(field) + " is required");
  }
  return value.at(field).get<std::string>();
}

std::string text_or(const nlohmann::json &value, const char *field, const std::string &fallback) {
  if (!value.is_object() || !value.contains(field) || value.at(field).is_null()) {
    return fallback;
  }
  if (!value.at(field).is_string()) {
    throw std::invalid_argument(std::string(field) + " must be a string");
  }
  return value.at(field).get<std::string>();
}

bool safe_token(const std::string &value, size_t max_size = 128) {
  return !value.empty() && value.size() <= max_size && std::all_of(value.begin(), value.end(), [](unsigned char ch) {
    return std::isalnum(ch) != 0 || ch == '-' || ch == '_' || ch == '.';
  });
}

std::vector<std::string> normalize_strings(const nlohmann::json &value, const char *field, bool non_empty = false) {
  if (!value.is_array() || (non_empty && value.empty())) {
    throw std::invalid_argument(std::string(field) + " must be a bounded string array");
  }
  std::vector<std::string> result;
  for (const auto &item : value) {
    if (!item.is_string() || item.get<std::string>().empty() || item.get<std::string>().size() > 256) {
      throw std::invalid_argument(std::string(field) + " contains an invalid string");
    }
    result.push_back(item.get<std::string>());
  }
  std::sort(result.begin(), result.end());
  if (std::adjacent_find(result.begin(), result.end()) != result.end()) {
    throw std::invalid_argument(std::string(field) + " contains duplicate values");
  }
  return result;
}

void validate_profile_id(const std::string &profile_id) {
  if (!safe_token(profile_id)) {
    throw std::invalid_argument("profile_id must be 1..128 characters of [A-Za-z0-9._-]");
  }
}

std::string read_file(const fs::path &path) {
  std::ifstream input(path, std::ios::binary);
  if (!input) {
    throw std::invalid_argument("cannot read Profile artifact: " + path.string());
  }
  return std::string(std::istreambuf_iterator<char>(input), std::istreambuf_iterator<char>());
}

bool path_is_within(const fs::path &root, const fs::path &candidate) {
  auto root_it = root.begin();
  auto candidate_it = candidate.begin();
  for (; root_it != root.end(); ++root_it, ++candidate_it) {
    if (candidate_it == candidate.end() || *root_it != *candidate_it) {
      return false;
    }
  }
  return true;
}

fs::path confined_path(const fs::path &root, const std::string &relative) {
  const fs::path ref(relative);
  if (relative.empty() || ref.is_absolute()) {
    throw std::invalid_argument("Profile artifact path must be relative");
  }
  for (const auto &part : ref) {
    if (part == "..") {
      throw std::invalid_argument("Profile artifact path escapes the package root: " + relative);
    }
  }
  const auto canonical_root = fs::weakly_canonical(root);
  const auto canonical_candidate = fs::weakly_canonical(root / ref);
  if (!path_is_within(canonical_root, canonical_candidate)) {
    throw std::invalid_argument("Profile artifact path escapes the package root: " + relative);
  }
  if (!fs::is_regular_file(canonical_candidate)) {
    throw std::invalid_argument("Profile artifact is not a regular file: " + relative);
  }
  return canonical_candidate;
}

void require_exact_keys(const nlohmann::json &value, const std::set<std::string> &required,
                        const std::set<std::string> &optional = {}) {
  if (!value.is_object()) {
    throw std::invalid_argument("Profile field must be an object");
  }
  for (const auto &field : required) {
    if (!value.contains(field)) {
      throw std::invalid_argument("Profile field is missing: " + field);
    }
  }
  for (const auto &[field, ignored] : value.items()) {
    (void)ignored;
    if (!required.contains(field) && !optional.contains(field)) {
      throw std::invalid_argument("unknown Profile authority field: " + field);
    }
  }
}

std::vector<std::string> normalize_tokens(const nlohmann::json &value, const char *field, bool non_empty = false) {
  if (!value.is_array() || (non_empty && value.empty())) {
    throw std::invalid_argument(std::string(field) + " must be a bounded string array");
  }
  std::vector<std::string> result;
  for (const auto &item : value) {
    if (!item.is_string() || !safe_token(item.get<std::string>())) {
      throw std::invalid_argument(std::string(field) + " contains an invalid token");
    }
    result.push_back(item.get<std::string>());
  }
  std::sort(result.begin(), result.end());
  if (std::adjacent_find(result.begin(), result.end()) != result.end()) {
    throw std::invalid_argument(std::string(field) + " contains duplicate values");
  }
  return result;
}

nlohmann::json normalize_ref(const nlohmann::json &value) {
  require_exact_keys(value, {"path", "sha256"});
  const auto path = required_text(value, "path");
  const auto hash = required_text(value, "sha256");
  if (hash.size() != 64 || !std::all_of(hash.begin(), hash.end(), [](unsigned char ch) {
        return std::isdigit(ch) != 0 || (ch >= 'a' && ch <= 'f');
      })) {
    throw std::invalid_argument("Profile artifact sha256 must be 64 lowercase hexadecimal characters");
  }
  return {{"path", path}, {"sha256", hash}};
}

nlohmann::json normalize_refs(const nlohmann::json &value, const char *field, bool non_empty) {
  if (!value.is_array() || (non_empty && value.empty())) {
    throw std::invalid_argument(std::string(field) + " must be a content-ref array");
  }
  std::vector<nlohmann::json> refs;
  for (const auto &item : value) {
    refs.push_back(normalize_ref(item));
  }
  std::sort(refs.begin(), refs.end(), [](const auto &left, const auto &right) {
    return left.at("path").template get<std::string>() < right.at("path").template get<std::string>();
  });
  for (size_t index = 1; index < refs.size(); ++index) {
    if (refs[index - 1].at("path") == refs[index].at("path")) {
      throw std::invalid_argument(std::string(field) + " contains duplicate artifact paths");
    }
  }
  return refs;
}

nlohmann::json normalize_profile(const nlohmann::json &input) {
  validate_source_contract(input);
  require_exact_keys(input,
                     {"schema", "id", "title", "version", "members", "kfd1", "kfd2", "actions", "views", "migrations",
                      "permissions", "qualification"},
                     {"kfd3", "experience", "work"});
  if (required_text(input, "schema") != PROFILE_SCHEMA_V1) {
    throw std::invalid_argument("Profile must use kungfu.profile-suite/v1");
  }
  const auto profile_id = required_text(input, "id");
  validate_profile_id(profile_id);
  const auto title = required_text(input, "title");
  const auto version = required_text(input, "version");

  const auto &members = input.at("members");
  require_exact_keys(members, {"required", "optional"});
  const auto required_members = normalize_tokens(members.at("required"), "members.required", true);
  const auto optional_members = normalize_tokens(members.at("optional"), "members.optional");
  for (const auto &member : required_members) {
    if (std::binary_search(optional_members.begin(), optional_members.end(), member)) {
      throw std::invalid_argument("required and optional Profile members overlap");
    }
  }
  std::string home_view;
  if (input.contains("experience")) {
    const auto &experience = input.at("experience");
    require_exact_keys(experience, {"homeView"});
    home_view = required_text(experience, "homeView");
    if (!std::binary_search(required_members.begin(), required_members.end(), home_view) &&
        !std::binary_search(optional_members.begin(), optional_members.end(), home_view)) {
      throw std::invalid_argument("experience.homeView must be a Profile member");
    }
  }

  const auto &kfd1 = input.at("kfd1");
  require_exact_keys(kfd1, {"contractWorld", "factSurfaces", "reducers", "compatibility"});
  const auto &kfd2 = input.at("kfd2");
  require_exact_keys(kfd2, {"claims", "purposes", "policies"});

  auto registry = [](const nlohmann::json &facet) {
    require_exact_keys(facet, {"registry"});
    return nlohmann::json{{"registry", normalize_ref(facet.at("registry"))}};
  };
  const auto &qualification = input.at("qualification");
  require_exact_keys(qualification, {"profile"});

  nlohmann::json normalized = {{"schema", PROFILE_SCHEMA_V1},
                               {"id", profile_id},
                               {"title", title},
                               {"version", version},
                               {"members", {{"required", required_members}, {"optional", optional_members}}},
                               {"kfd1",
                                {{"contractWorld", normalize_ref(kfd1.at("contractWorld"))},
                                 {"factSurfaces", normalize_refs(kfd1.at("factSurfaces"), "kfd1.factSurfaces", true)},
                                 {"reducers", normalize_refs(kfd1.at("reducers"), "kfd1.reducers", false)},
                                 {"compatibility", normalize_ref(kfd1.at("compatibility"))}}},
                               {"kfd2",
                                {{"claims", normalize_refs(kfd2.at("claims"), "kfd2.claims", true)},
                                 {"purposes", normalize_tokens(kfd2.at("purposes"), "kfd2.purposes", true)},
                                 {"policies", normalize_refs(kfd2.at("policies"), "kfd2.policies", true)}}},
                               {"actions", registry(input.at("actions"))},
                               {"views", registry(input.at("views"))},
                               {"migrations", registry(input.at("migrations"))},
                               {"permissions", registry(input.at("permissions"))},
                               {"qualification", {{"profile", normalize_ref(qualification.at("profile"))}}}};
  if (input.contains("kfd3")) {
    const auto &kfd3 = input.at("kfd3");
    require_exact_keys(kfd3, {"collaboration"});
    normalized["kfd3"] = {{"collaboration", normalize_ref(kfd3.at("collaboration"))}};
  }
  if (input.contains("work")) {
    const auto &work = input.at("work");
    require_exact_keys(work, {"conformance"});
    normalized["work"] = {{"conformance", normalize_ref(work.at("conformance"))}};
  }
  if (!home_view.empty()) {
    normalized["experience"] = {{"homeView", home_view}};
  }
  return normalized;
}

nlohmann::json normalize_member_roots(const nlohmann::json &profile, const nlohmann::json &input) {
  if (!input.is_object())
    throw std::invalid_argument("member_roots must be an object");
  std::set<std::string> expected;
  for (const auto &kind : {"required", "optional"}) {
    for (const auto &member : profile.at("members").at(kind))
      expected.insert(member.get<std::string>());
  }
  if (input.size() != expected.size()) {
    throw std::invalid_argument("member_roots must bind every required and optional Suite member exactly once");
  }
  auto result = nlohmann::json::object();
  for (const auto &[member, value] : input.items()) {
    if (!expected.contains(member) || !value.is_string()) {
      throw std::invalid_argument("member_roots contains an unknown or invalid Suite member");
    }
    const auto root = value.get<std::string>();
    if (root.size() != 71 || !root.starts_with("sha256:") ||
        !std::all_of(root.begin() + 7, root.end(),
                     [](unsigned char ch) { return std::isdigit(ch) != 0 || (ch >= 'a' && ch <= 'f'); })) {
      throw std::invalid_argument("member root must be canonical sha256: " + member);
    }
    result[member] = root;
  }
  return result;
}

void collect_ref(const nlohmann::json &ref, std::vector<nlohmann::json> &refs) { refs.push_back(ref); }

std::vector<nlohmann::json> profile_refs(const nlohmann::json &profile) {
  std::vector<nlohmann::json> refs;
  collect_ref(profile.at("kfd1").at("contractWorld"), refs);
  for (const auto &ref : profile.at("kfd1").at("factSurfaces"))
    collect_ref(ref, refs);
  for (const auto &ref : profile.at("kfd1").at("reducers"))
    collect_ref(ref, refs);
  collect_ref(profile.at("kfd1").at("compatibility"), refs);
  for (const auto &ref : profile.at("kfd2").at("claims"))
    collect_ref(ref, refs);
  for (const auto &ref : profile.at("kfd2").at("policies"))
    collect_ref(ref, refs);
  collect_ref(profile.at("actions").at("registry"), refs);
  collect_ref(profile.at("views").at("registry"), refs);
  collect_ref(profile.at("migrations").at("registry"), refs);
  collect_ref(profile.at("permissions").at("registry"), refs);
  collect_ref(profile.at("qualification").at("profile"), refs);
  if (profile.contains("kfd3"))
    collect_ref(profile.at("kfd3").at("collaboration"), refs);
  if (profile.contains("work"))
    collect_ref(profile.at("work").at("conformance"), refs);
  std::sort(refs.begin(), refs.end(), [](const auto &left, const auto &right) {
    return left.at("path").template get<std::string>() < right.at("path").template get<std::string>();
  });
  for (size_t index = 1; index < refs.size(); ++index) {
    if (refs[index - 1].at("path") == refs[index].at("path")) {
      throw std::invalid_argument("Profile reuses an artifact path across authority facets");
    }
  }
  return refs;
}

nlohmann::json parse_bound_json(const nlohmann::json &inspection, const std::string &facet_path) {
  const auto profile_path = fs::path(required_text(inspection, "profile_path"));
  const auto package_root = profile_path.parent_path();
  return nlohmann::json::parse(read_file(confined_path(package_root, facet_path)));
}

bool work_capable_profile(const nlohmann::json &inspection) {
  const auto &profile = inspection.at("profile");
  const auto actions_ref = profile.at("actions").at("registry");
  const auto registry = parse_bound_json(inspection, required_text(actions_ref, "path"));
  if (text_or(registry, "schema") != "kungfu.profile-actions/v1" || !registry.contains("actions") ||
      !registry.at("actions").is_array()) {
    return false;
  }
  std::set<std::string> work_actions;
  for (const auto &action : registry.at("actions")) {
    if (action.is_object() && text_or(action, "runtimeOperation") == "episode.append") {
      work_actions.insert(text_or(action, "id"));
    }
  }
  return work_actions.contains("claim-completion") && work_actions.contains("review-completion") &&
         work_actions.contains("decide-continuation");
}

nlohmann::json require_work_conformance(const nlohmann::json &inspection, const nlohmann::json &receipt,
                                        const char *surface) {
  if (!receipt.is_object() || text_or(receipt, "schema") != "kungfu.work-profile-conformance-result/v1") {
    throw std::invalid_argument("Work-capable Profile requires a conformance result from the public checker");
  }
  const auto verdict = text_or(receipt, "verdict");
  if (verdict != "compatible" && verdict != "compatible-with-constraints") {
    throw std::invalid_argument("Work-capable Profile conformance verdict is not admissible");
  }
  if (receipt.value("lifecycleMutation", true) || !receipt.contains("diagnostics") ||
      !receipt.at("diagnostics").is_array() || !receipt.at("diagnostics").empty()) {
    throw std::invalid_argument("Work-capable Profile conformance result contains blocking diagnostics");
  }
  const auto &profile = inspection.at("profile");
  if (!profile.contains("work")) {
    throw std::invalid_argument("Work-capable Profile omits work.conformance");
  }
  const auto declaration_ref = profile.at("work").at("conformance");
  const auto declaration = parse_bound_json(inspection, required_text(declaration_ref, "path"));
  if (text_or(receipt, "declarationRoot") != content_root(declaration.dump())) {
    throw std::invalid_argument("Work conformance result does not bind the exact declaration root");
  }
  if (text_or(receipt, "scenarioId") != text_or(declaration, "scenarioId") || !declaration.contains("bindings") ||
      receipt.value("authorityBindings", nlohmann::json()) != declaration.at("bindings") ||
      !declaration.contains("humanAuthority") ||
      receipt.value("humanAuthority", nlohmann::json()) != declaration.at("humanAuthority")) {
    throw std::invalid_argument("Work conformance result does not bind the prescribed declaration authorities");
  }
  const auto conformance_root = required_text(receipt, "conformanceRoot");
  if (!receipt.contains("surfaceRoots") || !receipt.at("surfaceRoots").is_object() ||
      text_or(receipt.at("surfaceRoots"), surface) != conformance_root ||
      text_or(receipt, "publicSurface") != surface) {
    throw std::invalid_argument("Work conformance result does not bind the requested public surface");
  }
  auto stable = receipt;
  stable.erase("conformanceRoot");
  stable.erase("surfaceRoots");
  stable.erase("publicSurface");
  if (content_root(stable.dump()) != conformance_root) {
    throw std::invalid_argument("Work conformance result root is invalid");
  }
  if (!receipt.contains("machineChecks") || !receipt.at("machineChecks").is_array()) {
    throw std::invalid_argument("Work conformance result omits machine checks");
  }
  std::map<std::string, nlohmann::json> expected_checks;
  const auto add_expected = [&expected_checks](const std::string &id, const std::string &status,
                                               const nlohmann::json &evidence_root = nullptr) {
    expected_checks.emplace(id, nlohmann::json{{"id", id}, {"status", status}, {"evidenceRoot", evidence_root}});
  };
  const auto &bindings = declaration.at("bindings");
  add_expected("exact-action-geometry-root", "passed", bindings.at("actionGeometryRoot"));
  add_expected("exact-work-abstraction-authority-root", "passed", bindings.at("abstractionAuthorityRoot"));
  for (const auto *field : {"actionGeometryRoot", "domainProfileRoot", "abstractionAuthorityRoot", "sourceRoot"})
    add_expected(std::string("binding-") + field, "passed", bindings.at(field));
  for (const auto *role : {"fact", "episode", "pursuit", "atlas", "warrant"})
    add_expected(std::string("binding-role-") + role, "passed", bindings.at("roleSchemaRoots").at(role));
  add_expected("responsibility-role-root-separation", "passed");
  add_expected("generic-authority-reuse", "passed");
  for (const auto &judgment : declaration.at("humanAuthority").items())
    add_expected("human-authority-" + judgment.key(), "declared", judgment.value().at("authorityRoot"));
  for (const auto &evidence : declaration.at("behaviorEvidence"))
    add_expected("behavior-" + required_text(evidence, "case"), required_text(evidence, "status"),
                 evidence.at("evidenceRoot"));
  for (const auto &adapter : declaration.at("platformAdapters"))
    add_expected("platform-" + required_text(adapter, "platform"), required_text(adapter, "status"),
                 adapter.at("evidenceRoot"));
  const auto &buildchain = declaration.at("buildchain");
  add_expected("buildchain-admission", required_text(buildchain, "status"), buildchain.at("evidenceRoot"));
  add_expected("generic-work-operation-model", "passed", declaration.at("workOperationModel").at("authorityRoot"));
  if (receipt.at("machineChecks").size() != expected_checks.size()) {
    throw std::invalid_argument("Work conformance result does not contain the exact prescribed machine-check set");
  }
  std::set<std::string> observed_checks;
  for (const auto &check : receipt.at("machineChecks")) {
    require_exact_keys(check, {"id", "status", "evidenceRoot"});
    const auto id = required_text(check, "id");
    if (!observed_checks.insert(id).second || !expected_checks.contains(id) || expected_checks.at(id) != check)
      throw std::invalid_argument("Work conformance result contains a forged or unprescribed machine check");
  }
  return receipt;
}

std::vector<std::string> declared_permissions(const nlohmann::json &inspection) {
  const auto &profile = inspection.at("profile");
  const auto ref = profile.at("permissions").at("registry");
  const auto registry = parse_bound_json(inspection, required_text(ref, "path"));
  require_exact_keys(registry, {"schema", "permissions"});
  if (required_text(registry, "schema") != "kungfu.profile-permissions/v1") {
    throw std::invalid_argument("permission registry must use kungfu.profile-permissions/v1");
  }
  return normalize_tokens(registry.at("permissions"), "permissions", false);
}

nlohmann::json qualify_inspection(const nlohmann::json &inspection, const nlohmann::json &work_conformance) {
  const auto &profile = inspection.at("profile");
  const auto compatibility_ref = profile.at("kfd1").at("compatibility");
  const auto compatibility = parse_bound_json(inspection, required_text(compatibility_ref, "path"));
  require_exact_keys(compatibility, {"schema", "runtimeContracts"});
  if (required_text(compatibility, "schema") != "kungfu.profile-compatibility/v1") {
    throw std::invalid_argument("compatibility artifact must use kungfu.profile-compatibility/v1");
  }
  const auto runtime_contracts = normalize_strings(compatibility.at("runtimeContracts"), "runtimeContracts", true);
  if (!std::binary_search(runtime_contracts.begin(), runtime_contracts.end(), PROFILE_LIFECYCLE_CONTRACT_V1)) {
    throw std::invalid_argument("Profile does not declare compatibility with kungfu.profile-lifecycle/v1");
  }

  const auto qualification_ref = profile.at("qualification").at("profile");
  const auto qualification = parse_bound_json(inspection, required_text(qualification_ref, "path"));
  require_exact_keys(qualification, {"schema", "checks"});
  if (required_text(qualification, "schema") != "kungfu.profile-qualification/v1") {
    throw std::invalid_argument("qualification artifact must use kungfu.profile-qualification/v1");
  }
  const auto checks = normalize_tokens(qualification.at("checks"), "checks", true);
  for (const auto *required : {"content-closure", "runtime-contract"}) {
    if (!std::binary_search(checks.begin(), checks.end(), required)) {
      throw std::invalid_argument(std::string("qualification profile omits required check: ") + required);
    }
  }
  if (checks.size() != 2) {
    throw std::invalid_argument("qualification profile requests a check this runtime cannot execute");
  }
  nlohmann::json result = {{"schema", "kungfu.profile-qualification-result/v1"},
                           {"profile_suite_root", inspection.at("profile_suite_root")},
                           {"status", "qualified"},
                           {"checks", checks},
                           {"qualifier", "libkungfu"},
                           {"policy", "profile-closure-and-runtime/v1"},
                           {"evidence_scope", "source-contract/content-closure/runtime-contract"}};
  if (work_capable_profile(inspection)) {
    const auto conformance = require_work_conformance(inspection, work_conformance, "qualify");
    result["work_conformance_root"] = conformance.at("conformanceRoot");
    result["work_declaration_root"] = conformance.at("declarationRoot");
  }
  return result;
}

std::vector<uint8_t> encode_event(const nlohmann::json &event) {
  const auto encoded = lifecycle_schema().handle.encode_json(event.dump());
  if (!encoded.ok) {
    throw std::invalid_argument("Profile lifecycle event does not match its FlatBuffers owner: " + encoded.error);
  }
  return std::vector<uint8_t>(encoded.bytes.begin(), encoded.bytes.end());
}

std::vector<lifecycle_record> read_events(const std::string &runtime_dir, int64_t cut_system_time = 0) {
  std::vector<lifecycle_record> records;
  const auto journal_dir =
      fs::path(runtime_dir) / "journal" / "system" / PROFILE_NAMESPACE / PROFILE_JOURNAL_NAME / "live";
  if (!fs::exists(journal_dir))
    return records;
  auto locator = std::make_shared<yy::data::locator>(runtime_dir);
  auto location = yy::data::location::make_shared(yy::enums::mode::LIVE, yy::enums::location_role::SYSTEM,
                                                  PROFILE_NAMESPACE, PROFILE_JOURNAL_NAME, locator);
  try {
    yy::journal::assemble reader(location, yy::data::location::PUBLIC, yy::enums::AssembleMode::Channel, 0);
    while (reader.data_available()) {
      const auto frame = reader.current_frame();
      if (cut_system_time != 0 && frame->gen_time() > cut_system_time) {
        reader.next();
        continue;
      }
      if (frame->carrier_type() == view::action::ACTION_ENVELOPE_CARRIER_TYPE) {
        std::string error;
        const auto envelope = view::action::decode(reinterpret_cast<const uint8_t *>(frame->data_as_bytes()),
                                                   frame->data_length(), &error);
        if (!envelope.has_value())
          throw std::runtime_error("cannot decode Profile action envelope: " + error);
        if (envelope->schema_ref.id == PROFILE_LIFECYCLE_EVENT_V1 &&
            envelope->schema_ref.version == EVENT_SCHEMA_VERSION && envelope->payload.has_value() &&
            envelope->payload->encoding == view::action::payload_encoding::FlatBuffers) {
          const auto &payload = envelope->payload->data;
          const auto decoded = lifecycle_schema().handle.decode_json(payload.data(), payload.size());
          if (!decoded.ok)
            throw std::runtime_error("cannot decode Profile lifecycle event: " + decoded.error);
          records.push_back({nlohmann::json::parse(decoded.json), frame->frame_uid()});
        }
      }
      reader.next();
    }
  } catch (const yy::journal::assemble_exception &) {
    return {};
  } catch (const std::runtime_error &error) {
    if (std::string(error.what()).find("no page for current journal") != std::string::npos)
      return {};
    throw;
  }
  return records;
}

std::map<std::string, profile_state> fold_profiles(const std::vector<lifecycle_record> &records) {
  std::map<std::string, profile_state> states;
  for (const auto &record : records) {
    const auto profile_id = text_or(record.event, "profile_id");
    const auto root = text_or(record.event, "profile_suite_root");
    if (profile_id.empty() || root.empty())
      continue;
    auto &state = states[profile_id];
    state.profile_id = profile_id;
    state.revision = std::max(state.revision, record.event.value("revision", uint64_t{0}));
    state.latest = record;
    auto &root_entry = state.roots[root];
    const auto closure_text = text_or(record.event, "closure_json");
    if (!closure_text.empty())
      root_entry.closure = nlohmann::json::parse(closure_text);
    const auto kind = text_or(record.event, "kind");
    if (kind == "Installed") {
      state.current_root = root;
      state.removed = false;
      root_entry.installed = true;
    } else if (kind == "Qualified") {
      state.current_root = root;
      root_entry.qualified = true;
      root_entry.qualification = nlohmann::json::parse(text_or(record.event, "qualification_json", "{}"));
    } else if (kind == "Kfd3Qualified") {
      state.current_root = root;
      root_entry.kfd3_qualification = nlohmann::json::parse(text_or(record.event, "qualification_json", "{}"));
    } else if (kind == "Activated") {
      state.current_root = root;
      state.removed = false;
      root_entry.activated = true;
      root_entry.granted_permissions = nlohmann::json::parse(text_or(record.event, "granted_permissions_json", "[]"));
    } else if (kind == "Superseded") {
      root_entry.activated = false;
    } else if (kind == "RolledBack") {
      for (auto &[ignored, candidate] : state.roots) {
        (void)ignored;
        candidate.activated = false;
      }
      state.current_root = root;
      state.removed = false;
      root_entry.installed = true;
      root_entry.activated = true;
      root_entry.granted_permissions = nlohmann::json::parse(text_or(record.event, "granted_permissions_json", "[]"));
    } else if (kind == "Removed") {
      root_entry.activated = false;
      state.removed = true;
    }
  }
  return states;
}

nlohmann::json render_event(const lifecycle_record &record) {
  const auto &event = record.event;
  nlohmann::json result = {{"schema", PROFILE_LIFECYCLE_EVENT_V1},
                           {"event_id", text_or(event, "event_id")},
                           {"profile_id", text_or(event, "profile_id")},
                           {"profile_version", text_or(event, "profile_version")},
                           {"profile_suite_root", text_or(event, "profile_suite_root")},
                           {"revision", event.value("revision", uint64_t{0})},
                           {"kind", text_or(event, "kind")},
                           {"system_time", event.value("system_time", int64_t{0})},
                           {"previous_root", text_or(event, "previous_root")},
                           {"plan_id", text_or(event, "plan_id")},
                           {"authorization_id", text_or(event, "authorization_id")},
                           {"source_contract_root", text_or(event, "source_contract_root")},
                           {"journal_frame_uid", record.frame_uid}};
  for (const auto *field : {"closure_json", "member_roots_json", "granted_permissions_json", "qualification_json",
                            "runtime_compatibility_json"}) {
    const auto encoded = text_or(event, field);
    if (!encoded.empty())
      result[std::string(field).substr(0, std::string(field).size() - 5)] = nlohmann::json::parse(encoded);
  }
  result["contract_world_root"] = text_or(event, "contract_world_root");
  return result;
}

nlohmann::json render_state(const profile_state &state) {
  const auto found = state.roots.find(state.current_root);
  if (found == state.roots.end())
    throw std::runtime_error("Profile fold has no current root");
  const auto &root = found->second;
  const auto profile = root.closure.value("profile", nlohmann::json::object());
  return {{"schema", "kungfu.profile-state/v1"},
          {"profile_id", state.profile_id},
          {"profile_version", profile.value("version", "")},
          {"profile_suite_root", state.current_root},
          {"revision", state.revision},
          {"state", state.removed    ? "removed"
                    : root.activated ? "activated"
                    : root.qualified ? "qualified"
                                     : "installed"},
          {"installed", root.installed},
          {"qualified", root.qualified},
          {"activated", root.activated},
          {"removed", state.removed},
          {"granted_permissions", root.granted_permissions},
          {"qualification", root.qualification},
          {"kfd3_qualification", root.kfd3_qualification},
          {"available_roots", state.roots.size()},
          {"latest_event", render_event(state.latest)}};
}

nlohmann::json make_event(const std::string &kind, const nlohmann::json &inspection, uint64_t revision,
                          const std::string &previous_root, const std::string &plan_id,
                          const std::string &authorization_id, int64_t system_time,
                          const nlohmann::json &permissions = nlohmann::json::array(),
                          const nlohmann::json &qualification = nlohmann::json::object()) {
  const auto &profile = inspection.at("profile");
  const auto root = required_text(inspection, "profile_suite_root");
  nlohmann::json event = {
      {"schema_version", EVENT_SCHEMA_VERSION},
      {"event_id", ""},
      {"profile_id", required_text(profile, "id")},
      {"profile_version", required_text(profile, "version")},
      {"profile_suite_root", root},
      {"revision", revision},
      {"kind", kind},
      {"system_time", system_time},
      {"previous_root", previous_root},
      {"plan_id", plan_id},
      {"authorization_id", authorization_id},
      {"closure_json", inspection.at("closure").dump()},
      {"member_roots_json", inspection.at("member_roots").dump()},
      {"contract_world_root", "sha256:" + profile.at("kfd1").at("contractWorld").at("sha256").get<std::string>()},
      {"granted_permissions_json", permissions.dump()},
      {"qualification_json", qualification.dump()},
      {"runtime_compatibility_json", nlohmann::json{{"contract", PROFILE_LIFECYCLE_CONTRACT_V1}}.dump()},
      {"source_contract_root", kfx_source_contract().root}};
  auto identity = event;
  identity.erase("event_id");
  event["event_id"] = content_root(identity.dump());
  return event;
}

lifecycle_record append_event(const std::string &runtime_dir, const nlohmann::json &event) {
  action::action_recorder recorder(runtime_dir, PROFILE_NAMESPACE, PROFILE_JOURNAL_NAME);
  yy_storage::episode_manifest_store episodes(runtime_dir);
  yy_storage::episode_begin_options begin_options{};
  begin_options.location_uid = recorder.get_location()->uid;
  begin_options.begin_time = event.at("system_time").get<int64_t>();
  begin_options.title = "Profile " + text_or(event, "kind") + ": " + text_or(event, "profile_id");
  begin_options.actor = "libkungfu";
  begin_options.source = "profile-lifecycle";
  const auto opened = episodes.begin(begin_options);

  view::action::envelope envelope{};
  envelope.action_type = "profile.lifecycle." + text_or(event, "kind");
  envelope.schema_ref = {PROFILE_LIFECYCLE_EVENT_V1, EVENT_SCHEMA_VERSION};
  envelope.payload = view::action::payload_view{view::action::payload_encoding::FlatBuffers,
                                                encode_event(event),
                                                {},
                                                {},
                                                0,
                                                "application/vnd.kungfu.profile-lifecycle-event+flatbuffers",
                                                "present"};
  action::record_options record_options{};
  record_options.gen_time = event.at("system_time").get<int64_t>();
  const auto receipt = recorder.record_action(envelope, record_options);

  yy_storage::episode_frame_attach_options attached{};
  attached.episode_id = opened.episode_id;
  attached.location_uid = receipt.source;
  attached.frame_uid = receipt.frame_uid;
  attached.trigger_frame_uid = receipt.trigger_frame_uid;
  attached.stream_id = receipt.stream_id;
  attached.gen_time = receipt.gen_time;
  attached.trigger_time = receipt.trigger_time;
  attached.carrier_type = receipt.carrier_type;
  attached.source = receipt.source;
  attached.dest = receipt.dest;
  attached.data_length = receipt.data_length;
  attached.integrity_version = receipt.integrity_version;
  attached.payload_checksum = receipt.payload_checksum;
  attached.frame_checksum = receipt.frame_checksum;
  (void)episodes.attach_frame(attached);

  yy_storage::episode_ref_attach_options schema_ref{};
  schema_ref.episode_id = opened.episode_id;
  schema_ref.location_uid = recorder.get_location()->uid;
  schema_ref.ref_kind = yy::enums::EpisodeRefKind::Schema;
  schema_ref.update_time = record_options.gen_time;
  schema_ref.ref_id = PROFILE_LIFECYCLE_EVENT_V1;
  schema_ref.ref_hash = lifecycle_schema().root;
  (void)episodes.attach_ref(schema_ref);

  yy_storage::episode_ref_attach_options artifact_ref = schema_ref;
  artifact_ref.ref_kind = yy::enums::EpisodeRefKind::Payload;
  artifact_ref.ref_id = text_or(event, "profile_id");
  artifact_ref.ref_hash = text_or(event, "profile_suite_root");
  (void)episodes.attach_ref(artifact_ref);

  yy_storage::episode_close_options close_options{};
  close_options.episode_id = opened.episode_id;
  close_options.location_uid = recorder.get_location()->uid;
  close_options.status = yy::enums::EpisodeStatus::Ended;
  close_options.end_time = record_options.gen_time;
  close_options.last_frame_uid = receipt.frame_uid;
  close_options.frame_count = 1;
  close_options.reason = "Profile lifecycle fact recorded";
  (void)episodes.end(close_options);
  return {event, receipt.frame_uid};
}

nlohmann::json inspection_for_root(const profile_state &state, const std::string &root) {
  const auto found = state.roots.find(root);
  if (found == state.roots.end() || found->second.closure.empty()) {
    throw std::invalid_argument("Profile root is not present in lifecycle history: " + root);
  }
  const auto &closure = found->second.closure;
  return {{"schema", PROFILE_INSPECTION_V1},
          {"profile_path", closure.value("profile_path", "")},
          {"profile_suite_root", root},
          {"profile", closure.at("profile")},
          {"artifacts", closure.at("artifacts")},
          {"member_roots", closure.at("member_roots")},
          {"closure", closure}};
}

} // namespace

namespace {

[[noreturn]] void root_fail(const std::string &code, const std::string &message) {
  throw initiative_assignment_root_error(code, message);
}

bool exact_root_fields(const nlohmann::json &value, const std::set<std::string> &expected) {
  if (!value.is_object() || value.size() != expected.size())
    return false;
  return std::all_of(expected.begin(), expected.end(), [&value](const auto &field) { return value.contains(field); });
}

bool root_nonempty_text(const nlohmann::json &value, const char *field) {
  return value.contains(field) && value.at(field).is_string() && !value.at(field).get<std::string>().empty();
}

std::string root_hex(const std::string &bytes) {
  static constexpr char digits[] = "0123456789abcdef";
  std::string result;
  result.reserve(bytes.size() * 2);
  for (const auto byte : bytes) {
    const auto value = static_cast<unsigned char>(byte);
    result.push_back(digits[value >> 4U]);
    result.push_back(digits[value & 0x0fU]);
  }
  return result;
}

void validate_root_input(const nlohmann::json &input) {
  if (!exact_root_fields(input, {"payload", "protocolId", "subjectKey", "surfaceId"}))
    root_fail("protocol-field-set", "Root input has an invalid field set");
  if (!input.at("protocolId").is_string() || input.at("protocolId").get<std::string>() != INITIATIVE_ASSIGNMENT_ROOT_V1)
    root_fail("unsupported-protocol", "Root protocol id is unsupported");
  if (!input.at("surfaceId").is_string())
    root_fail("invalid-domain", "Root surface is not Initiative or Assignment");
  const auto surface = input.at("surfaceId").get<std::string>();
  if (surface != INITIATIVE_SURFACE_V1 && surface != ASSIGNMENT_SURFACE_V1)
    root_fail("invalid-domain", "Root surface is not Initiative or Assignment");
  if (!input.at("subjectKey").is_string() || input.at("subjectKey").get<std::string>().empty())
    root_fail("invalid-subject", "subjectKey must be a non-empty string");

  const auto &payload = input.at("payload");
  if (!exact_root_fields(payload, {"links", "record", "source"}))
    root_fail("invalid-payload-field-set", "payload has an invalid field set");
  const auto &record = payload.at("record");
  if (!record.is_object())
    root_fail("invalid-record", "payload.record must be an object");
  const auto identity_field = surface == INITIATIVE_SURFACE_V1 ? "initiative_id" : "assignment_id";
  if (!root_nonempty_text(record, identity_field) ||
      (surface == ASSIGNMENT_SURFACE_V1 && !root_nonempty_text(record, "initiative_id")))
    root_fail("invalid-record", "record identity fields must be non-empty strings");
  const auto subject = input.at("subjectKey").get<std::string>();
  if (subject != "kungfu:" + record.at(identity_field).get<std::string>())
    root_fail("invalid-subject", "subjectKey does not match the record identity");

  const auto &source = payload.at("source");
  const std::set<std::string> required_source = {"authority_mode", "payload_hash", "source_id", "source_time"};
  const std::set<std::string> allowed_source = {
      "actor",        "authority_mode", "import_episode_id", "import_episode_root", "import_id",   "kind",
      "payload_hash", "repo_head",      "source_id",         "source_path",         "source_time", "storage_source_id"};
  if (!source.is_object() || !std::all_of(required_source.begin(), required_source.end(),
                                          [&source](const auto &field) { return source.contains(field); }))
    root_fail("invalid-source-field-set", "payload.source has an invalid field set");
  for (const auto &[key, item] : source.items()) {
    if (!allowed_source.contains(key))
      root_fail("invalid-source-field-set", "payload.source has an invalid field set");
    if (!item.is_string())
      root_fail("invalid-source", "source fields must be strings");
  }
  if (!std::all_of(required_source.begin(), required_source.end(),
                   [&source](const auto &field) { return root_nonempty_text(source, field.c_str()); }))
    root_fail("invalid-source", "required source fields must be non-empty strings");
  static const std::regex root_pattern("sha256:[0-9a-f]{64}");
  if (!std::regex_match(source.at("payload_hash").get<std::string>(), root_pattern))
    root_fail("invalid-source", "source.payload_hash must be a sha256 Root");

  const auto &links = payload.at("links");
  if (!links.is_object() || !links.contains("initiative_id") || links.empty() || links.size() > 2)
    root_fail("invalid-links-field-set", "payload.links has an invalid field set");
  for (const auto &[key, item] : links.items()) {
    if (key != "initiative_id" && key != "assignment_id")
      root_fail("invalid-links-field-set", "payload.links has an invalid field set");
    if (!item.is_string() || item.get<std::string>().empty())
      root_fail("invalid-links", "link fields must be non-empty strings");
  }
  if (links.at("initiative_id").get<std::string>() != "kungfu:" + record.at("initiative_id").get<std::string>())
    root_fail("invalid-links", "initiative link does not match the record");
  if (links.contains("assignment_id") && links.at("assignment_id").get<std::string>() != subject)
    root_fail("invalid-links", "assignment link does not match subjectKey");
}

} // namespace

nlohmann::json compute_initiative_assignment_root(const nlohmann::json &input) {
  validate_root_input(input);
  std::string canonical;
  try {
    canonical = action::action_canonical_json({{"payload", input.at("payload")},
                                               {"subjectKey", input.at("subjectKey")},
                                               {"surfaceId", input.at("surfaceId")}});
  } catch (const action::canonical_json_error &error) {
    throw initiative_assignment_root_error(error.code(), error.what());
  }
  std::string preimage(INITIATIVE_ASSIGNMENT_ROOT_V1);
  preimage.push_back('\0');
  preimage += canonical;
  return {{"canonicalHex", root_hex(canonical)}, {"preimageHex", root_hex(preimage)}, {"root", content_root(preimage)}};
}

nlohmann::json verify_initiative_assignment_root(const nlohmann::json &input, const std::string &canonical_hex,
                                                 const std::string &preimage_hex, const std::string &root) {
  const auto evidence = compute_initiative_assignment_root(input);
  if (canonical_hex != evidence.at("canonicalHex").get<std::string>())
    root_fail("canonical-byte-mismatch", "claimed canonical bytes do not match");
  if (preimage_hex != evidence.at("preimageHex").get<std::string>())
    root_fail("preimage-byte-mismatch", "claimed preimage bytes do not match");
  if (root != evidence.at("root").get<std::string>())
    root_fail("root-mismatch", "claimed Root does not match");
  return evidence;
}

nlohmann::json profile_lifecycle_contract() {
  return {{"schema", PROFILE_LIFECYCLE_CONTRACT_V1},
          {"authority", "workspace-journal"},
          {"source_schema", PROFILE_SCHEMA_V1},
          {"source_contract_root", kfx_source_contract().root},
          {"event_schema", PROFILE_LIFECYCLE_EVENT_V1},
          {"root", "Core-computed canonical sha256 over normalized Profile and verified content closure"},
          {"states", {"installed", "qualified", "activated", "removed"}},
          {"facts", {"Installed", "Qualified", "Activated", "Superseded", "RolledBack", "Removed", "Kfd3Qualified"}},
          {"operations", {"contract", "inspect", "plan", "apply", "get", "list", "history"}},
          {"journal", {{"namespace", PROFILE_NAMESPACE}, {"name", PROFILE_JOURNAL_NAME}}},
          {"projection", "deterministic-in-memory-fold/v1"},
          {"activation_is_gui_focus", false}};
}

nlohmann::json inspect_profile(const std::string &profile_path_text, const nlohmann::json &member_roots_input) {
  const auto profile_path = fs::weakly_canonical(fs::path(profile_path_text));
  if (!fs::is_regular_file(profile_path)) {
    throw std::invalid_argument("Profile document is not a regular file: " + profile_path_text);
  }
  const auto profile = normalize_profile(nlohmann::json::parse(read_file(profile_path)));
  const auto member_roots = normalize_member_roots(profile, member_roots_input);
  const auto package_root = profile_path.parent_path();
  auto artifacts = nlohmann::json::array();
  for (const auto &ref : profile_refs(profile)) {
    const auto relative = required_text(ref, "path");
    const auto bytes = read_file(confined_path(package_root, relative));
    const auto actual = bare_sha256(bytes);
    if (actual != required_text(ref, "sha256")) {
      throw std::invalid_argument("Profile artifact hash mismatch: " + relative);
    }
    artifacts.push_back({{"path", relative}, {"sha256", actual}, {"size", bytes.size()}});
  }

  nlohmann::json closure = {
      {"schema", "kungfu.profile-content-closure/v1"},
      {"profile_path", profile_path.string()},
      {"source_contract", {{"schema", "kungfu.kfx.contract/v1"}, {"root", kfx_source_contract().root}}},
      {"profile", profile},
      {"artifacts", artifacts},
      {"member_roots", member_roots}};
  auto root_input = closure;
  root_input.erase("profile_path");
  const auto root = content_root(root_input.dump());
  nlohmann::json inspection = {{"schema", PROFILE_INSPECTION_V1},
                               {"profile_path", profile_path.string()},
                               {"profile_suite_root", root},
                               {"profile", profile},
                               {"artifacts", artifacts},
                               {"member_roots", member_roots},
                               {"closure", closure},
                               {"verified", true}};
  inspection["work_capable"] = work_capable_profile(inspection);
  return inspection;
}

nlohmann::json plan_profile_lifecycle(const std::string &runtime_dir, const nlohmann::json &request) {
  if (!request.is_object())
    throw std::invalid_argument("Profile lifecycle request must be an object");
  const auto action_name = required_text(request, "action");
  const std::set<std::string> supported{"install",  "qualify", "activate",    "upgrade",
                                        "rollback", "remove",  "kfd3-qualify"};
  if (!supported.contains(action_name))
    throw std::invalid_argument("unsupported Profile lifecycle action: " + action_name);

  const auto states = fold_profiles(read_events(runtime_dir));
  nlohmann::json normalized_request = {{"action", action_name}};
  nlohmann::json inspection;
  std::string profile_id;
  if (action_name == "install" || action_name == "qualify" || action_name == "activate" || action_name == "upgrade" ||
      action_name == "kfd3-qualify") {
    if (!request.contains("member_roots"))
      throw std::invalid_argument("member_roots is required");
    inspection = inspect_profile(required_text(request, "profile_path"), request.at("member_roots"));
    normalized_request["profile_path"] = inspection.at("profile_path");
    normalized_request["member_roots"] = inspection.at("member_roots");
    profile_id = inspection.at("profile").at("id").get<std::string>();
    if ((action_name == "qualify" || action_name == "activate") && work_capable_profile(inspection)) {
      if (!request.contains("work_conformance")) {
        throw std::invalid_argument("Work-capable Profile lifecycle requires a conformance result");
      }
      const auto *surface = action_name == "qualify" ? "qualify" : "installed-runtime";
      normalized_request["work_conformance"] =
          require_work_conformance(inspection, request.at("work_conformance"), surface);
    }
  } else {
    profile_id = required_text(request, "profile_id");
    validate_profile_id(profile_id);
    normalized_request["profile_id"] = profile_id;
  }
  const auto found = states.find(profile_id);
  const auto exists = found != states.end();
  const auto current_root = exists ? found->second.current_root : std::string{};
  const auto revision = exists ? found->second.revision : 0;
  const auto expected_root = text_or(request, "expected_current_root");
  if (!expected_root.empty() && expected_root != current_root) {
    throw std::invalid_argument("Profile current root conflict");
  }
  normalized_request["expected_current_root"] = current_root;

  auto effects = nlohmann::json::array();
  nlohmann::json qualification = nlohmann::json::object();
  nlohmann::json permissions = nlohmann::json::array();
  if (action_name == "install") {
    if (exists && !found->second.removed)
      throw std::invalid_argument("Profile is already installed; use upgrade");
    effects.push_back({{"kind", "Installed"}, {"profile_suite_root", inspection.at("profile_suite_root")}});
  } else if (action_name == "qualify") {
    if (!exists || found->second.removed || current_root != inspection.at("profile_suite_root").get<std::string>()) {
      throw std::invalid_argument("qualification requires the exact current installed Profile root");
    }
    qualification = qualify_inspection(inspection, request.value("work_conformance", nlohmann::json::object()));
    effects.push_back({{"kind", "Qualified"}, {"profile_suite_root", current_root}});
  } else if (action_name == "activate") {
    if (!exists || found->second.removed || current_root != inspection.at("profile_suite_root").get<std::string>()) {
      throw std::invalid_argument("activation requires the exact current Profile root");
    }
    const auto root_found = found->second.roots.find(current_root);
    if (root_found == found->second.roots.end() || !root_found->second.qualified) {
      throw std::invalid_argument("activation requires a qualified Profile root");
    }
    if (work_capable_profile(inspection) && text_or(root_found->second.qualification, "work_conformance_root") !=
                                                required_text(request.at("work_conformance"), "conformanceRoot")) {
      throw std::invalid_argument("activation Work conformance root differs from the qualified root");
    }
    const auto requested = request.contains("granted_permissions")
                               ? normalize_tokens(request.at("granted_permissions"), "granted_permissions", false)
                               : std::vector<std::string>{};
    const auto declared = declared_permissions(inspection);
    for (const auto &permission : requested) {
      if (!std::binary_search(declared.begin(), declared.end(), permission)) {
        throw std::invalid_argument("activation requests undeclared permission: " + permission);
      }
    }
    permissions = requested;
    normalized_request["granted_permissions"] = permissions;
    effects.push_back(
        {{"kind", "Activated"}, {"profile_suite_root", current_root}, {"granted_permissions", permissions}});
  } else if (action_name == "kfd3-qualify") {
    if (!exists || found->second.removed || current_root != inspection.at("profile_suite_root").get<std::string>()) {
      throw std::invalid_argument("KFD-3 qualification requires the exact current Profile root");
    }
    const auto root_found = found->second.roots.find(current_root);
    if (root_found == found->second.roots.end() || !root_found->second.activated) {
      throw std::invalid_argument("KFD-3 qualification requires an active Profile root");
    }
    if (!request.contains("qualification") || !request.at("qualification").is_object()) {
      throw std::invalid_argument("KFD-3 qualification receipt is required");
    }
    qualification = request.at("qualification");
    if (text_or(qualification, "schema") != "kungfu.profile-kfd3-qualification-receipt/v1" ||
        !qualification.value("qualified", false) || text_or(qualification, "profileId") != profile_id ||
        text_or(qualification, "profileSuiteRoot") != current_root) {
      throw std::invalid_argument("KFD-3 qualification receipt does not bind the exact Profile root");
    }
    normalized_request["qualification"] = qualification;
    effects.push_back({{"kind", "Kfd3Qualified"}, {"profile_suite_root", current_root}});
  } else if (action_name == "upgrade") {
    if (!exists || found->second.removed)
      throw std::invalid_argument("upgrade requires an installed Profile");
    if (current_root == inspection.at("profile_suite_root").get<std::string>()) {
      throw std::invalid_argument("upgrade root is unchanged");
    }
    effects.push_back({{"kind", "Superseded"}, {"profile_suite_root", current_root}});
    effects.push_back({{"kind", "Installed"}, {"profile_suite_root", inspection.at("profile_suite_root")}});
  } else if (action_name == "rollback") {
    if (!exists || found->second.removed)
      throw std::invalid_argument("rollback requires an installed Profile");
    const auto target_root = required_text(request, "target_root");
    const auto target = found->second.roots.find(target_root);
    if (target == found->second.roots.end() || !target->second.installed || !target->second.qualified) {
      throw std::invalid_argument("rollback target must be a historically installed and qualified root");
    }
    if (target_root == current_root)
      throw std::invalid_argument("rollback target is already current");
    inspection = inspection_for_root(found->second, target_root);
    permissions = target->second.granted_permissions;
    normalized_request["target_root"] = target_root;
    effects.push_back({{"kind", "RolledBack"}, {"profile_suite_root", target_root}, {"from_root", current_root}});
  } else if (action_name == "remove") {
    if (!exists || found->second.removed)
      throw std::invalid_argument("Profile is not installed");
    inspection = inspection_for_root(found->second, current_root);
    effects.push_back({{"kind", "Removed"}, {"profile_suite_root", current_root}});
  }

  nlohmann::json plan = {{"schema", PROFILE_PLAN_V1},
                         {"plan_id", ""},
                         {"runtime_dir", fs::weakly_canonical(fs::path(runtime_dir)).string()},
                         {"profile_id", profile_id},
                         {"request", normalized_request},
                         {"basis", {{"current_root", current_root}, {"revision", revision}}},
                         {"inspection", inspection},
                         {"qualification", qualification},
                         {"granted_permissions", permissions},
                         {"effects", effects},
                         {"requires_authorization", true}};
  auto identity = plan;
  identity.erase("plan_id");
  plan["plan_id"] = content_root(identity.dump());
  return plan;
}

nlohmann::json apply_profile_lifecycle(const std::string &runtime_dir, const nlohmann::json &plan,
                                       const std::string &authorization_id, int64_t system_time) {
  if (!plan.is_object() || text_or(plan, "schema") != PROFILE_PLAN_V1) {
    throw std::invalid_argument("apply requires kungfu.profile-lifecycle-plan/v1");
  }
  if (authorization_id.empty())
    throw std::invalid_argument("authorization_id is required");
  const auto runtime_path = fs::weakly_canonical(fs::path(runtime_dir)).string();
  if (text_or(plan, "runtime_dir") != runtime_path)
    throw std::invalid_argument("Profile plan targets another runtime");
  const auto refreshed = plan_profile_lifecycle(runtime_dir, plan.at("request"));
  if (required_text(refreshed, "plan_id") != required_text(plan, "plan_id")) {
    throw std::invalid_argument("stale Profile lifecycle plan; inspect and authorize a new plan");
  }
  const auto now = system_time == 0 ? yy::time::now_in_nano() : system_time;
  auto revision = plan.at("basis").value("revision", uint64_t{0});
  auto previous_root = text_or(plan.at("basis"), "current_root");
  const auto &default_inspection = plan.at("inspection");
  auto recorded = nlohmann::json::array();
  for (const auto &effect : plan.at("effects")) {
    const auto kind = required_text(effect, "kind");
    auto event_inspection = default_inspection;
    if (kind == "Superseded") {
      const auto states = fold_profiles(read_events(runtime_dir));
      event_inspection = inspection_for_root(states.at(required_text(plan, "profile_id")),
                                             required_text(effect, "profile_suite_root"));
    }
    ++revision;
    const auto event = make_event(kind, event_inspection, revision, previous_root, required_text(plan, "plan_id"),
                                  authorization_id, now, plan.at("granted_permissions"), plan.at("qualification"));
    const auto result = append_event(runtime_dir, event);
    recorded.push_back(render_event(result));
    previous_root = required_text(effect, "profile_suite_root");
  }
  return {{"schema", PROFILE_RECEIPT_V1},
          {"plan_id", plan.at("plan_id")},
          {"authorization_id", authorization_id},
          {"profile_id", plan.at("profile_id")},
          {"events", recorded},
          {"state", get_profile(runtime_dir, required_text(plan, "profile_id"), true)},
          {"verified", true}};
}

nlohmann::json get_profile(const std::string &runtime_dir, const std::string &profile_id, bool include_removed,
                           int64_t cut_system_time) {
  validate_profile_id(profile_id);
  const auto states = fold_profiles(read_events(runtime_dir, cut_system_time));
  const auto found = states.find(profile_id);
  if (found == states.end() || (!include_removed && found->second.removed)) {
    throw std::invalid_argument("Profile not found: " + profile_id);
  }
  auto rendered = render_state(found->second);
  rendered["cut_system_time"] = cut_system_time;
  return rendered;
}

nlohmann::json list_profiles(const std::string &runtime_dir, bool include_removed, int64_t cut_system_time) {
  const auto states = fold_profiles(read_events(runtime_dir, cut_system_time));
  auto profiles = nlohmann::json::array();
  for (const auto &[ignored, state] : states) {
    (void)ignored;
    if (!include_removed && state.removed)
      continue;
    profiles.push_back(render_state(state));
  }
  return {{"schema", "kungfu.profile-catalog/v1"},
          {"runtime_dir", runtime_dir},
          {"cut_system_time", cut_system_time},
          {"profiles", profiles},
          {"count", profiles.size()}};
}

nlohmann::json profile_history(const std::string &runtime_dir, const std::string &profile_id) {
  validate_profile_id(profile_id);
  auto events = nlohmann::json::array();
  for (const auto &record : read_events(runtime_dir)) {
    if (text_or(record.event, "profile_id") == profile_id)
      events.push_back(render_event(record));
  }
  if (events.empty())
    throw std::invalid_argument("Profile not found: " + profile_id);
  return {{"schema", "kungfu.profile-history/v1"}, {"profile_id", profile_id}, {"events", events}};
}

} // namespace kungfu::runtime::profile
