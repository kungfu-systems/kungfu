// SPDX-License-Identifier: Apache-2.0

#include <kungfu/runtime/action/domain_profile.h>

#include <kungfu/runtime/action/action_contract_registry.h>
#include <kungfu/runtime/action/action_geometry.h>
#include <kungfu/yijinjing/storage/content_hash.h>

#include <algorithm>
#include <filesystem>
#include <fstream>
#include <regex>
#include <sstream>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

namespace kungfu::runtime::action {

namespace {

namespace fs = std::filesystem;
namespace yy_storage = kungfu::yijinjing::storage;

// The exact JSON Schema (Draft 2020-12) keyword subset the role schemas use
// (kfd7-role-schema-subset/v1). Any keyword outside this set is rejected at load
// time (fail-closed), matching the design's explicit-architecture-decision gate
// rather than silently ignoring unsupported constraints.
bool is_supported_schema_keyword(const std::string &key) {
  static const std::vector<std::string> supported = {"type",    "required", "properties", "const",
                                                     "enum",    "pattern",  "$ref",       "$defs",
                                                     "$schema", "$id",      "title",      "additionalProperties"};
  return std::find(supported.begin(), supported.end(), key) != supported.end();
}

std::string read_file(const fs::path &path) {
  std::ifstream stream(path, std::ios::binary);
  if (!stream) {
    throw std::runtime_error("cannot open Agent Work role schema: " + path.string());
  }
  std::ostringstream buffer;
  buffer << stream.rdbuf();
  return buffer.str();
}

std::string content_root(const std::string &bytes) {
  return yy_storage::format_content_hash(yy_storage::compute_content_hash(bytes));
}

// Python str repr: single quotes preferred, switch to double quotes when the
// string contains a single quote and no double quote; backslash / matching quote
// / \n \r \t escaped; other C0 controls and DEL as \xNN; printable ASCII and
// UTF-8 bytes are passed through. Best-effort match to CPython repr for the
// ASCII-dominant role-body domain (byte parity for failure messages is pinned by
// follow-up jsonschema fixtures).
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

std::string py_repr(const nlohmann::json &value); // forward

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
  case nlohmann::json::value_t::number_float:
    return value.dump();
  case nlohmann::json::value_t::array: {
    std::string out = "[";
    bool first = true;
    for (const auto &item : value) {
      if (!first) {
        out += ", ";
      }
      first = false;
      out += py_repr(item);
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
      out += repr_string(item.key());
      out += ": ";
      out += py_repr(item.value());
    }
    out += "}";
    return out;
  }
  default:
    return value.dump();
  }
}

bool type_matches(const nlohmann::json &instance, const std::string &type) {
  if (type == "object") {
    return instance.is_object();
  }
  if (type == "array") {
    return instance.is_array();
  }
  if (type == "string") {
    return instance.is_string();
  }
  if (type == "boolean") {
    return instance.is_boolean();
  }
  if (type == "null") {
    return instance.is_null();
  }
  if (type == "number") {
    return instance.is_number();
  }
  if (type == "integer") {
    if (instance.is_number_integer() || instance.is_number_unsigned()) {
      return true;
    }
    if (instance.is_number_float()) {
      const double d = instance.get<double>();
      return d == static_cast<double>(static_cast<std::int64_t>(d));
    }
    return false;
  }
  return false;
}

struct schema_error {
  std::vector<std::string> path;
  std::string message;
};

// Verify a role schema uses only the supported keyword subset, recursing through
// properties and $defs. Fail-closed on any unsupported keyword, non-string type,
// or schema-form additionalProperties (only the boolean form is supported).
void check_schema_subset(const nlohmann::json &schema) {
  if (!schema.is_object()) {
    return;
  }
  for (const auto &item : schema.items()) {
    if (!is_supported_schema_keyword(item.key())) {
      throw std::runtime_error("Agent Work role schema uses unsupported keyword '" + item.key() +
                               "' outside kfd7-role-schema-subset/v1");
    }
  }
  if (schema.contains("type") && !schema.at("type").is_string()) {
    throw std::runtime_error("Agent Work role schema uses unsupported non-string 'type' outside "
                             "kfd7-role-schema-subset/v1");
  }
  if (schema.contains("additionalProperties") && !schema.at("additionalProperties").is_boolean()) {
    throw std::runtime_error("Agent Work role schema uses unsupported schema-form 'additionalProperties' "
                             "outside kfd7-role-schema-subset/v1");
  }
  if (schema.contains("properties") && schema.at("properties").is_object()) {
    for (const auto &item : schema.at("properties").items()) {
      check_schema_subset(item.value());
    }
  }
  if (schema.contains("$defs") && schema.at("$defs").is_object()) {
    for (const auto &item : schema.at("$defs").items()) {
      check_schema_subset(item.value());
    }
  }
}

const nlohmann::json &resolve_ref(const std::string &ref, const nlohmann::json &root) {
  if (ref.rfind("#/", 0) != 0) {
    throw std::runtime_error("Agent Work role schema uses unsupported $ref: " + ref);
  }
  const nlohmann::json *node = &root;
  std::string token;
  std::istringstream stream(ref.substr(2));
  while (std::getline(stream, token, '/')) {
    // JSON Pointer unescape (~1 -> /, ~0 -> ~); the role schemas only use plain
    // segments, but keep the decode faithful.
    std::string decoded;
    for (std::size_t i = 0; i < token.size(); ++i) {
      if (token[i] == '~' && i + 1 < token.size()) {
        if (token[i + 1] == '1') {
          decoded.push_back('/');
          ++i;
          continue;
        }
        if (token[i + 1] == '0') {
          decoded.push_back('~');
          ++i;
          continue;
        }
      }
      decoded.push_back(token[i]);
    }
    if (!node->is_object() || !node->contains(decoded)) {
      throw std::runtime_error("Agent Work role schema $ref does not resolve: " + ref);
    }
    node = &node->at(decoded);
  }
  return *node;
}

// Collect subset validation errors for instance against schema, mirroring
// jsonschema Draft202012Validator.iter_errors for the supported keyword subset.
void collect_errors(const nlohmann::json &schema, const nlohmann::json &instance, std::vector<std::string> path,
                    const nlohmann::json &root, std::vector<schema_error> &errors) {
  if (schema.contains("$ref")) {
    collect_errors(resolve_ref(schema.at("$ref").get<std::string>(), root), instance, path, root, errors);
    return;
  }
  if (schema.contains("type")) {
    const auto type = schema.at("type").get<std::string>();
    if (!type_matches(instance, type)) {
      errors.push_back({path, py_repr(instance) + " is not of type '" + type + "'"});
    }
  }
  if (schema.contains("const")) {
    if (instance != schema.at("const")) {
      errors.push_back({path, py_repr(schema.at("const")) + " was expected"});
    }
  }
  if (schema.contains("enum")) {
    bool found = false;
    for (const auto &candidate : schema.at("enum")) {
      if (instance == candidate) {
        found = true;
        break;
      }
    }
    if (!found) {
      errors.push_back({path, py_repr(instance) + " is not one of " + py_repr(schema.at("enum"))});
    }
  }
  if (schema.contains("pattern") && instance.is_string()) {
    const auto pattern = schema.at("pattern").get<std::string>();
    const std::regex re(pattern, std::regex::ECMAScript);
    if (!std::regex_search(instance.get<std::string>(), re)) {
      errors.push_back({path, py_repr(instance) + " does not match " + py_repr(schema.at("pattern"))});
    }
  }
  if (schema.contains("required") && instance.is_object()) {
    for (const auto &name : schema.at("required")) {
      if (!instance.contains(name.get<std::string>())) {
        errors.push_back({path, py_repr(name) + " is a required property"});
      }
    }
  }
  if (schema.contains("properties") && instance.is_object()) {
    for (const auto &item : schema.at("properties").items()) {
      if (instance.contains(item.key())) {
        auto child = path;
        child.push_back(item.key());
        collect_errors(item.value(), instance.at(item.key()), child, root, errors);
      }
    }
  }
  if (schema.contains("additionalProperties") && schema.at("additionalProperties").is_boolean() &&
      !schema.at("additionalProperties").get<bool>() && instance.is_object()) {
    std::vector<std::string> extras;
    for (const auto &item : instance.items()) {
      const bool declared = schema.contains("properties") && schema.at("properties").is_object() &&
                            schema.at("properties").contains(item.key());
      if (!declared) {
        extras.push_back(item.key());
      }
    }
    if (!extras.empty()) {
      std::string parts;
      for (std::size_t i = 0; i < extras.size(); ++i) {
        if (i != 0) {
          parts += ", ";
        }
        parts += py_repr(nlohmann::json(extras[i]));
      }
      const char *verb = extras.size() == 1 ? "was" : "were";
      errors.push_back({path, "Additional properties are not allowed (" + parts + " " + verb + " unexpected)"});
    }
  }
}

// Locate a role schema file relative to the resolved domain profile contract,
// mirroring domain_profile._role_schema_path: role-schemas/<basename> next to the
// profile, then <source>/<artifact> walked upward from the profile directory.
fs::path role_schema_path(const fs::path &profile_path, const nlohmann::json &row) {
  const auto profile = fs::absolute(profile_path);
  const auto basename = fs::path(row.at("artifact").get<std::string>()).filename();
  std::vector<fs::path> candidates;
  candidates.push_back(profile.parent_path() / "role-schemas" / basename);
  for (fs::path dir = profile.parent_path();; dir = dir.parent_path()) {
    if (row.contains("source") && row.at("source").is_string()) {
      candidates.push_back(dir / row.at("source").get<std::string>());
    }
    if (row.contains("artifact") && row.at("artifact").is_string()) {
      candidates.push_back(dir / row.at("artifact").get<std::string>());
    }
    if (dir == dir.parent_path()) {
      break;
    }
  }
  for (const auto &candidate : candidates) {
    std::error_code ec;
    if (fs::is_regular_file(candidate, ec)) {
      return candidate;
    }
  }
  throw std::runtime_error("Agent Work role schema not found: " + basename.string());
}

struct loaded_role_schema {
  nlohmann::json schema;
  std::string root;
};

loaded_role_schema load_role_schema(const registered_contract &profile, const std::string &role) {
  const auto &role_schemas = profile.document.at("roleSchemas");
  if (!role_schemas.is_object() || !role_schemas.contains(role) || !role_schemas.at(role).is_object()) {
    throw std::runtime_error("Unknown Agent Work role: " + role);
  }
  const auto &row = role_schemas.at(role);
  const auto path = role_schema_path(profile.path, row);
  const auto raw = read_file(path);
  const auto actual_root = content_root(raw);
  const auto expected_root = row.at("root").get<std::string>();
  if (actual_root != expected_root) {
    throw std::runtime_error("Agent Work " + role + " role schema root mismatch: expected " + expected_root + ", got " +
                             actual_root);
  }
  auto schema = nlohmann::json::parse(raw);
  if (!schema.is_object()) {
    throw std::runtime_error("Agent Work " + role + " role schema must be an object");
  }
  check_schema_subset(schema);
  return loaded_role_schema{std::move(schema), actual_root};
}

nlohmann::json json_get(const nlohmann::json &body, const std::string &key) {
  if (body.is_object() && body.contains(key)) {
    return body.at(key);
  }
  return nlohmann::json(nullptr);
}

} // namespace

nlohmann::json domain_profile_roots(const std::string &search_base) {
  const auto profile = load_registered_contract(AGENT_WORK_DOMAIN_PROFILE_SURFACE, search_base);
  const auto geometry = load_registered_contract(ACTION_GEOMETRY_SURFACE, search_base);

  const auto expected_geometry = profile.document.at("actionGeometry").at("root").get<std::string>();
  if (geometry.root != expected_geometry) {
    throw std::runtime_error("Agent Work Action Geometry root mismatch: expected " + expected_geometry + ", got " +
                             geometry.root);
  }

  auto role_roots = nlohmann::json::object();
  for (const auto &role : profile.document.at("roleOrder")) {
    role_roots[role.get<std::string>()] = load_role_schema(profile, role.get<std::string>()).root;
  }

  nlohmann::json result;
  result["actionGeometryRoot"] = geometry.root;
  result["domainProfileRoot"] = profile.root;
  result["roleSchemaRoots"] = std::move(role_roots);
  return result;
}

std::string role_schema_id(const std::string &role, const std::string &search_base) {
  const auto profile = load_registered_contract(AGENT_WORK_DOMAIN_PROFILE_SURFACE, search_base);
  const auto &role_schemas = profile.document.at("roleSchemas");
  if (!role_schemas.is_object() || !role_schemas.contains(role) || !role_schemas.at(role).is_object()) {
    throw std::runtime_error("Unknown Agent Work role: " + role);
  }
  return role_schemas.at(role).at("schema").get<std::string>();
}

nlohmann::json role_bindings(const std::string &role, const std::string &search_base) {
  const auto resolved = domain_profile_roots(search_base);
  nlohmann::json result;
  result["actionGeometryRoot"] = resolved.at("actionGeometryRoot");
  result["domainProfileRoot"] = resolved.at("domainProfileRoot");
  result["roleSchemaRoot"] = resolved.at("roleSchemaRoots").at(role);
  return result;
}

nlohmann::json validate_role_body(const nlohmann::json &body, bool allow_legacy, const std::string &search_base) {
  const auto profile = load_registered_contract(AGENT_WORK_DOMAIN_PROFILE_SURFACE, search_base);
  const auto role_value = json_get(body, "role");

  bool known_role = false;
  for (const auto &candidate : profile.document.at("roleOrder")) {
    if (candidate == role_value) {
      known_role = true;
      break;
    }
  }
  if (!known_role) {
    throw std::runtime_error("Unknown Agent Work role: " + py_repr(role_value));
  }
  const auto role = role_value.get<std::string>();

  if (json_get(body, "schema") == nlohmann::json(LEGACY_ROLE_BODY_SCHEMA)) {
    if (!allow_legacy) {
      throw std::runtime_error("Legacy Agent Work role bodies are not accepted here");
    }
    return nlohmann::json{{"role", role}, {"legacy", true}};
  }

  const auto expected_schema = profile.document.at("roleSchemas").at(role).at("schema").get<std::string>();
  if (json_get(body, "schema") != nlohmann::json(expected_schema)) {
    throw std::runtime_error("Agent Work " + role + " role schema mismatch: expected " + expected_schema);
  }

  const auto loaded = load_role_schema(profile, role);
  std::vector<schema_error> errors;
  collect_errors(loaded.schema, body, {}, loaded.schema, errors);
  std::stable_sort(errors.begin(), errors.end(),
                   [](const schema_error &lhs, const schema_error &rhs) { return lhs.path < rhs.path; });
  if (!errors.empty()) {
    const auto &first = errors.front();
    std::string path_str;
    for (std::size_t i = 0; i < first.path.size(); ++i) {
      if (i != 0) {
        path_str += ".";
      }
      path_str += first.path[i];
    }
    if (path_str.empty()) {
      path_str = "<root>";
    }
    throw std::runtime_error("Agent Work " + role + " role body validation failed at " + path_str + ": " +
                             first.message);
  }

  const auto expected_bindings = role_bindings(role, search_base);
  if (json_get(body, "bindings") != expected_bindings) {
    throw std::runtime_error("Agent Work " + role + " role body does not bind the exact contract roots");
  }

  return nlohmann::json{{"role", role}, {"legacy", false}, {"bindings", expected_bindings}};
}

} // namespace kungfu::runtime::action
