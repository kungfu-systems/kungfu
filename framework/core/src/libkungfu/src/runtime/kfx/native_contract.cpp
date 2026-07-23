// SPDX-License-Identifier: Apache-2.0

#include <kungfu/runtime/kfx/native_contract.h>

#include <algorithm>
#include <regex>
#include <set>
#include <stdexcept>
#include <string>
#include <unordered_set>

#include <kungfu/runtime/profile/profile_source_contract.h>
#include <kungfu/yijinjing/storage/content_hash.h>

namespace kungfu::runtime::kfx {

namespace {

using json = nlohmann::json;

[[noreturn]] void refuse(const std::string &code, const std::string &message) {
  throw std::invalid_argument(code + ": " + message);
}

const json &source_contract() {
  static const auto value = json::parse(profile::schema::KFX_CONTRACT_JSON);
  return value;
}

std::string root_of(const std::string &value) {
  return "sha256:" +
         yijinjing::storage::compute_content_hash_value(value, yijinjing::storage::CONTENT_HASH_ALGORITHM_SHA256);
}

const json &native_contract_source() {
  const auto &source = source_contract();
  if (!source.contains("nativeRuntime") || !source.at("nativeRuntime").is_object()) {
    refuse("KF_KFX_SCHEMA_INVALID", "source contract does not contain nativeRuntime");
  }
  return source.at("nativeRuntime");
}

const json &resolve_schema_ref(const json &root, const std::string &reference) {
  constexpr const char *prefix = "#/$defs/";
  if (!reference.starts_with(prefix))
    refuse("KF_KFX_SCHEMA_INVALID", "unsupported KFX schema reference: " + reference);
  const auto key = reference.substr(std::char_traits<char>::length(prefix));
  if (!root.contains("$defs") || !root.at("$defs").contains(key))
    refuse("KF_KFX_SCHEMA_INVALID", "missing KFX schema reference: " + reference);
  return root.at("$defs").at(key);
}

void validate_schema_value(const json &value, const json &rule, const json &root, const std::string &path) {
  if (rule.contains("$ref")) {
    if (!rule.at("$ref").is_string())
      refuse("KF_KFX_SCHEMA_INVALID", path + " contains an invalid schema reference");
    validate_schema_value(value, resolve_schema_ref(root, rule.at("$ref").get<std::string>()), root, path);
    return;
  }
  if (rule.contains("anyOf")) {
    if (!rule.at("anyOf").is_array())
      refuse("KF_KFX_SCHEMA_INVALID", path + " contains an invalid anyOf rule");
    for (const auto &candidate : rule.at("anyOf")) {
      try {
        validate_schema_value(value, candidate, root, path);
        return;
      } catch (const std::invalid_argument &) {
      }
    }
    refuse("KF_KFX_SCHEMA_INVALID", path + " does not match any allowed schema");
  }
  if (rule.contains("const") && value != rule.at("const"))
    refuse("KF_KFX_SCHEMA_INVALID", path + " does not match the KFX contract constant");
  if (rule.contains("enum") && (!rule.at("enum").is_array() || std::find(rule.at("enum").begin(), rule.at("enum").end(),
                                                                         value) == rule.at("enum").end()))
    refuse("KF_KFX_SCHEMA_INVALID", path + " is not in the KFX contract enum");

  const auto type = rule.contains("type") && rule.at("type").is_string() ? rule.at("type").get<std::string>() : "";
  if (type == "object") {
    if (!value.is_object())
      refuse("KF_KFX_SCHEMA_INVALID", path + " must be an object");
    if (rule.contains("required")) {
      for (const auto &field : rule.at("required")) {
        if (!field.is_string() || !value.contains(field.get<std::string>()))
          refuse("KF_KFX_SCHEMA_INVALID", path + " is missing a required field");
      }
    }
    const auto properties = rule.value("properties", json::object());
    if (rule.contains("additionalProperties") && rule.at("additionalProperties").is_boolean() &&
        !rule.at("additionalProperties").get<bool>()) {
      for (const auto &[field, ignored] : value.items()) {
        (void)ignored;
        if (!properties.contains(field))
          refuse("KF_KFX_SCHEMA_INVALID", path + " contains unknown field " + field);
      }
    }
    for (const auto &[field, child] : properties.items()) {
      if (value.contains(field))
        validate_schema_value(value.at(field), child, root, path + "." + field);
    }
    return;
  }
  if (type == "array") {
    if (!value.is_array())
      refuse("KF_KFX_SCHEMA_INVALID", path + " must be an array");
    if (rule.contains("minItems") &&
        (!rule.at("minItems").is_number_unsigned() || value.size() < rule.at("minItems").get<size_t>()))
      refuse("KF_KFX_SCHEMA_INVALID", path + " has too few items");
    if (rule.value("uniqueItems", false)) {
      std::set<std::string> identities;
      for (const auto &item : value) {
        if (!identities.insert(item.dump()).second)
          refuse("KF_KFX_SCHEMA_INVALID", path + " contains duplicate items");
      }
    }
    if (rule.contains("items")) {
      size_t index = 0;
      for (const auto &item : value)
        validate_schema_value(item, rule.at("items"), root, path + "[" + std::to_string(index++) + "]");
    }
    return;
  }
  if (type == "string") {
    if (!value.is_string())
      refuse("KF_KFX_SCHEMA_INVALID", path + " must be a string");
    const auto text = value.get<std::string>();
    if (rule.contains("minLength") && text.size() < rule.at("minLength").get<size_t>())
      refuse("KF_KFX_SCHEMA_INVALID", path + " is too short");
    if (rule.contains("pattern") && !std::regex_match(text, std::regex(rule.at("pattern").get<std::string>())))
      refuse("KF_KFX_SCHEMA_INVALID", path + " does not match the KFX contract pattern");
    return;
  }
  if (type == "integer") {
    if (!value.is_number_integer())
      refuse("KF_KFX_SCHEMA_INVALID", path + " must be an integer");
    const auto number = value.get<int64_t>();
    if (rule.contains("minimum") && number < rule.at("minimum").get<int64_t>())
      refuse("KF_KFX_SCHEMA_INVALID", path + " is below the KFX contract minimum");
    if (rule.contains("maximum") && number > rule.at("maximum").get<int64_t>())
      refuse("KF_KFX_SCHEMA_INVALID", path + " exceeds the KFX contract maximum");
    return;
  }
  if (type == "boolean" && !value.is_boolean())
    refuse("KF_KFX_SCHEMA_INVALID", path + " must be a boolean");
}

void require_object(const json &value, const std::string &path) {
  if (!value.is_object()) {
    refuse("KF_KFX_SCHEMA_INVALID", path + " must be an object");
  }
}

void require_string(const json &value, const std::string &field, const std::string &path) {
  if (!value.contains(field) || !value.at(field).is_string() || value.at(field).get<std::string>().empty()) {
    refuse("KF_KFX_SCHEMA_INVALID", path + "." + field + " must be a non-empty string");
  }
}

void require_non_negative_integer(const json &value, const std::string &field, const std::string &path) {
  if (!value.contains(field) || !value.at(field).is_number_integer() || value.at(field).get<int64_t>() < 0) {
    refuse("KF_KFX_SCHEMA_INVALID", path + "." + field + " must be a non-negative integer");
  }
}

std::vector<std::string> string_array(const json &value, const std::string &field, const std::string &path,
                                      bool allow_empty = true) {
  if (!value.contains(field) || !value.at(field).is_array() || (!allow_empty && value.at(field).empty())) {
    refuse("KF_KFX_SCHEMA_INVALID",
           path + "." + field + " must be " + (allow_empty ? "an array" : "a non-empty array"));
  }
  std::vector<std::string> result;
  for (const auto &entry : value.at(field)) {
    if (!entry.is_string() || entry.get<std::string>().empty()) {
      refuse("KF_KFX_SCHEMA_INVALID", path + "." + field + " must contain non-empty strings");
    }
    result.push_back(entry.get<std::string>());
  }
  return result;
}

void enforce_document_shape(const std::string &kind, const json &document) {
  require_object(document, kind);
  if (!document.contains("contractVersion") || !document.at("contractVersion").is_number_integer()) {
    refuse("KF_KFX_CONTRACT_VERSION_UNSUPPORTED", kind + " contractVersion is not supported");
  }
  const auto version = document.at("contractVersion").get<int64_t>();
  const auto version_key = std::to_string(version);
  const auto &supported = native_contract_source().at("versionNegotiation").at("supported");
  if (std::find(supported.begin(), supported.end(), version) == supported.end()) {
    refuse("KF_KFX_CONTRACT_VERSION_UNSUPPORTED", kind + " contractVersion is not supported");
  }
  const auto &documents = native_contract_source().at("documents");
  if (!documents.contains(version_key) || !documents.at(version_key).contains(kind)) {
    refuse("KF_KFX_DOCUMENT_KIND_UNKNOWN", "unknown native KFX document kind: " + kind);
  }
  const auto &shape = documents.at(version_key).at(kind);
  for (const auto &field : shape.at("required")) {
    if (!document.contains(field.get<std::string>())) {
      const auto name = field.get<std::string>();
      if (kind == "inspection" && name == "closure") {
        refuse("KF_KFX_CLOSURE_MISSING", "inspection must contain its complete closure");
      }
      refuse("KF_KFX_SCHEMA_INVALID", kind + " is missing required field " + name);
    }
  }
  std::unordered_set<std::string> allowed;
  for (const auto &field : shape.at("allowed")) {
    allowed.insert(field.get<std::string>());
  }
  for (auto item = document.begin(); item != document.end(); ++item) {
    if (!allowed.contains(item.key())) {
      if (item.key() == "packageRoot" || item.key() == "trust" || item.key() == "trustGrade" ||
          item.key() == "systemAuthority" || item.key() == "authority") {
        refuse("KF_KFX_AUTHORITY_CLAIM_FORBIDDEN", kind + " may not claim Core-owned field " + item.key());
      }
      refuse("KF_KFX_SCHEMA_INVALID", kind + " contains unknown field " + item.key());
    }
  }
  require_string(document, "schema", kind);
  if (document.at("schema") != shape.at("schema")) {
    refuse("KF_KFX_SCHEMA_INVALID", kind + " schema identifier does not match the contract");
  }
}

void validate_path(const std::string &value, const std::string &path) {
  if (value.empty() || value.front() == '/' || value.front() == '\\') {
    refuse("KF_KFX_PATH_TRAVERSAL", path + " must be a confined relative path");
  }
  std::string component;
  for (const char ch : value) {
    if (ch == '/' || ch == '\\') {
      if (component == "..") {
        refuse("KF_KFX_PATH_TRAVERSAL", path + " escapes its package root");
      }
      component.clear();
    } else {
      component.push_back(ch);
    }
  }
  if (component == "..") {
    refuse("KF_KFX_PATH_TRAVERSAL", path + " escapes its package root");
  }
}

void validate_request(const json &document) {
  require_string(document, "operation", "request");
  require_string(document, "packagePath", "request");
  (void)string_array(document, "requestedCapabilities", "request");
  validate_path(document.at("packagePath").get<std::string>(), "request.packagePath");
  const auto version = document.at("contractVersion").get<int64_t>();
  const std::set<std::string> operations =
      version == 1 ? std::set<std::string>{"inspect", "plan", "apply", "status", "history"}
                   : std::set<std::string>{"list", "inspect", "resolve", "plan", "apply", "status", "history"};
  if (!operations.contains(document.at("operation").get<std::string>())) {
    refuse("KF_KFX_AUTHORITY_CLAIM_FORBIDDEN", "only the native service may perform lifecycle mutations");
  }
  if (document.contains("actor") && !document.at("actor").is_string()) {
    refuse("KF_KFX_SCHEMA_INVALID", "request.actor must be a string");
  }
}

void validate_inspection(const json &document) {
  require_string(document, "packageKey", "inspection");
  require_string(document, "packageRoot", "inspection");
  const auto version = document.at("contractVersion").get<int64_t>();
  if (version == 1) {
    require_string(document, "trustGrade", "inspection");
  } else {
    require_string(document, "runtimeTier", "inspection");
    require_string(document, "admissionGrade", "inspection");
  }
  (void)string_array(document, "declaredCapabilities", "inspection");
  if (!document.at("owners").is_array()) {
    refuse("KF_KFX_SCHEMA_INVALID", "inspection.owners must be an array");
  }
  std::set<std::string> scopes;
  for (const auto &owner : document.at("owners")) {
    require_object(owner, "inspection.owners[]");
    if (owner.size() != 2 || !owner.contains("scope") || !owner.contains("owner")) {
      refuse("KF_KFX_SCHEMA_INVALID", "inspection owner must contain only scope and owner");
    }
    require_string(owner, "scope", "inspection.owners[]");
    require_string(owner, "owner", "inspection.owners[]");
    if (!scopes.insert(owner.at("scope").get<std::string>()).second) {
      refuse("KF_KFX_OWNER_DUPLICATE", "one contribution scope may have only one owner");
    }
  }
  if (!document.at("closure").is_array() || document.at("closure").empty()) {
    refuse("KF_KFX_CLOSURE_MISSING", "inspection closure must be non-empty");
  }
  for (const auto &entry : document.at("closure")) {
    require_object(entry, "inspection.closure[]");
    if (entry.size() != 2 || !entry.contains("path") || !entry.contains("sha256")) {
      refuse("KF_KFX_SCHEMA_INVALID", "closure entry must contain only path and sha256");
    }
    require_string(entry, "path", "inspection.closure[]");
    require_string(entry, "sha256", "inspection.closure[]");
    validate_path(entry.at("path").get<std::string>(), "inspection.closure[].path");
  }
  const auto &tiers = version == 1 ? native_contract_source().at("legacyV1").at("runtimeTiers")
                                   : native_contract_source().at("runtimeTiers");
  const auto &tier = version == 1 ? document.at("trustGrade") : document.at("runtimeTier");
  if (std::find(tiers.begin(), tiers.end(), tier) == tiers.end()) {
    refuse("KF_KFX_SCHEMA_INVALID", "inspection runtime tier is not in the native contract");
  }
  if (version == 2) {
    const auto &grades = native_contract_source().at("admissionGrades");
    if (std::find(grades.begin(), grades.end(), document.at("admissionGrade")) == grades.end()) {
      refuse("KF_KFX_SCHEMA_INVALID", "inspection.admissionGrade is not in the native contract");
    }
  }
}

void validate_plan(const json &document) {
  require_string(document, "planId", "plan");
  require_object(document.at("basis"), "plan.basis");
  const auto &basis = document.at("basis");
  if (basis.size() != 2 || !basis.contains("packageRoot") || !basis.contains("generation")) {
    refuse("KF_KFX_SCHEMA_INVALID", "plan.basis must contain only packageRoot and generation");
  }
  require_string(basis, "packageRoot", "plan.basis");
  require_non_negative_integer(basis, "generation", "plan.basis");
  require_non_negative_integer(document, "nextGeneration", "plan");
  const auto requested = string_array(document, "requestedCapabilities", "plan");
  const auto granted = string_array(document, "grantedCapabilities", "plan");
  if (!document.at("effects").is_array()) {
    refuse("KF_KFX_SCHEMA_INVALID", "plan.effects must be an array");
  }
  const std::set<std::string> requested_set(requested.begin(), requested.end());
  for (const auto &capability : granted) {
    if (!requested_set.contains(capability)) {
      refuse("KF_KFX_CAPABILITY_BROADENING", "plan grants an undeclared capability: " + capability);
    }
  }
  const auto expected = basis.at("generation").get<int64_t>() + (document.at("effects").empty() ? 0 : 1);
  if (document.at("nextGeneration").get<int64_t>() != expected) {
    refuse("KF_KFX_GENERATION_MISMATCH", "nextGeneration does not match the basis and effects");
  }
}

void validate_receipt(const json &document) {
  require_string(document, "receiptId", "receipt");
  require_string(document, "planId", "receipt");
  require_non_negative_integer(document, "generation", "receipt");
  if (!document.at("verified").is_boolean()) {
    refuse("KF_KFX_SCHEMA_INVALID", "receipt.verified must be a boolean");
  }
}

} // namespace

json native_kfx_contract() {
  auto contract = native_contract_source();
  contract["sourceContractSchema"] = source_contract().at("schema");
  contract["sourceContractVersion"] = source_contract().at("version");
  contract["sourceContractRoot"] = root_of(profile::schema::KFX_CONTRACT_JSON);
  contract["nativeContractRoot"] = root_of(native_contract_source().dump());
  return contract;
}

json normalize_native_kfx_manifest(const json &manifest) {
  const auto &contract = source_contract();
  if (!contract.contains("packageManifestSchema") || !contract.at("packageManifestSchema").is_object())
    refuse("KF_KFX_SCHEMA_INVALID", "source contract does not contain packageManifestSchema");
  validate_schema_value(manifest, contract.at("packageManifestSchema"), contract.at("packageManifestSchema"),
                        "packageManifest");
  return json::parse(manifest.dump());
}

json validate_native_kfx_document(const std::string &kind, const json &document) {
  enforce_document_shape(kind, document);
  if (kind == "request") {
    validate_request(document);
  } else if (kind == "inspection") {
    validate_inspection(document);
  } else if (kind == "plan") {
    validate_plan(document);
  } else if (kind == "receipt") {
    validate_receipt(document);
  } else {
    refuse("KF_KFX_DOCUMENT_KIND_UNKNOWN", "unknown native KFX document kind: " + kind);
  }
  const auto version = document.at("contractVersion").get<int64_t>();
  return {{"schema", version == 1 ? NATIVE_KFX_VALIDATION_V1 : NATIVE_KFX_VALIDATION_V2},
          {"kind", kind},
          {"contractVersion", version},
          {"nativeContractRoot", native_kfx_contract().at("nativeContractRoot")},
          {"valid", true}};
}

json invoke_native_kfx_service(native_kfx_service &service, const json &request) {
  (void)validate_native_kfx_document("request", request);
  const auto operation = request.at("operation").get<std::string>();
  if (operation == "list")
    return service.list(request);
  if (operation == "inspect")
    return service.inspect(request);
  if (operation == "resolve")
    return service.resolve(request);
  if (operation == "plan")
    return service.plan(request);
  if (operation == "apply")
    return service.apply(request);
  if (operation == "status")
    return service.status(request);
  if (operation == "history")
    return service.history(request);
  refuse("KF_KFX_AUTHORITY_CLAIM_FORBIDDEN", "unsupported native KFX operation: " + operation);
}

} // namespace kungfu::runtime::kfx
