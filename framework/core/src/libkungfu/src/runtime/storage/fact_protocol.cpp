// SPDX-License-Identifier: Apache-2.0

#include "fact_kernel_internal.h"

#include <algorithm>
#include <array>
#include <bit>
#include <charconv>
#include <cmath>
#include <cstdlib>
#include <cstring>
#include <regex>
#include <stdexcept>
#include <utility>

#include <kungfu/runtime/storage/fact_kernel.h>
#include <kungfu/runtime/storage/json_edge.h>
#include <kungfu/yijinjing/storage/content_hash.h>

namespace kungfu::runtime::storage_service_api::fact_kernel_internal {

namespace yy = kungfu::yijinjing;

constexpr std::array<unsigned char, 4> PORTABLE_ROOT_MAGIC = {'K', 'F', 'R', '2'};

struct portable_record_field {
  uint64_t id;
  const char *name;
  bool optional = false;
};

// The machine contract owns field meaning. This single ordered registry is
// independent from the Python encoder and is welded to that contract by the
// KFR2 conformance gate.
const std::map<std::string, std::vector<portable_record_field>> PORTABLE_RECORD_SCHEMAS = {
    {"kungfu.fact.object/v2", {{1, "schema"}, {2, "objectId"}, {3, "objectType"}, {4, "createdByReceiptRoot"}}},
    {"kungfu.fact.version/v2",
     {{1, "schema"},
      {2, "objectId"},
      {3, "bodyRoot"},
      {4, "schemaRoot"},
      {5, "parentVersionRoots"},
      {6, "declarationRoots"},
      {7, "admissionRoots"}}},
    {"kungfu.fact.relation-endpoint/v2", {{1, "kind"}, {2, "id"}, {3, "mapping_receipt_root", true}}},
    {"kungfu.fact.relation-add/v2",
     {{1, "schema"},
      {2, "relationId"},
      {3, "relationType"},
      {4, "source"},
      {5, "target"},
      {6, "attributesRoot"},
      {7, "admissionRoots"}}},
    {"kungfu.fact.relation-revoke/v2", {{1, "schema"}, {2, "relationRoot"}, {3, "reasonRoot"}}},
    {"kungfu.fact.cut/v2",
     {{1, "schema"},
      {2, "parentCutRoots"},
      {3, "objectVersions"},
      {4, "activeRelationRoots"},
      {5, "declarationRoots"},
      {6, "admissionRoots"},
      {7, "episodeFrontier"},
      {8, "omissionRoots"},
      {9, "conflictRoots"}}},
    {"kungfu.fact.ref-transition/v2",
     {{1, "schema"},
      {2, "transitionId"},
      {3, "refName"},
      {4, "expectedOldCutRoot"},
      {5, "expectedOldRevision"},
      {6, "newCutRoot"},
      {7, "kind"},
      {8, "reasonRoot"}}},
    {"kungfu.fact.operation-receipt/v2",
     {{1, "schema"},
      {2, "operationId"},
      {3, "operation"},
      {4, "status"},
      {5, "failureCode"},
      {6, "recordRoot"},
      {7, "priorCutRoot"},
      {8, "currentCutRoot"},
      {9, "priorRevision"},
      {10, "currentRevision"}}},
    {"kungfu.fact.operation-request/v2", {{1, "action"}, {2, "arguments"}}},
    {"kungfu.fact.root-set/v2", {{1, "domain"}, {2, "roots"}}},
    {"kungfu.fact.authority-bundle/v2", {{1, "schema"}, {2, "capabilities"}, {3, "inventory"}, {4, "bodyRoots"}}},
    {"kungfu.fact.temporal-predicate/v1",
     {{1, "schema"},
      {2, "predicateId"},
      {3, "operations"},
      {4, "direction"},
      {5, "pathPolicy"},
      {6, "cyclePolicy"},
      {7, "authorityRoot"}}},
    {"kungfu.fact.temporal-relation/v1",
     {{1, "schema"},
      {2, "relationId"},
      {3, "predicateRoot"},
      {4, "sourceRoot"},
      {5, "targetRoot"},
      {6, "validFromCutRoot"},
      {7, "scopeRoot"},
      {8, "authorityRoot"},
      {9, "admissionRoots"}}},
    {"kungfu.fact.temporal-supersession/v1",
     {{1, "schema"},
      {2, "priorRelationRoot"},
      {3, "successorRelationRoot"},
      {4, "effectiveCutRoot"},
      {5, "reasonRoot"},
      {6, "authorityRoot"},
      {7, "admissionRoots"}}},
    {"kungfu.fact.temporal-revocation/v1",
     {{1, "schema"},
      {2, "relationRoot"},
      {3, "effectiveCutRoot"},
      {4, "reasonRoot"},
      {5, "authorityRoot"},
      {6, "admissionRoots"}}},
    {"kungfu.fact.temporal-authority-proof/v1",
     {{1, "schema"},
      {2, "proofId"},
      {3, "subjectAuthorityRoot"},
      {4, "governingAuthorityRoot"},
      {5, "operations"},
      {6, "validFromCutRoot"},
      {7, "revokedAtCutRoot"},
      {8, "admissionRoots"}}},
    {"kungfu.fact.provenance-object/v1",
     {{1, "schema"},
      {2, "objectId"},
      {3, "subjectRoot"},
      {4, "materialRoots"},
      {5, "relationRoots"},
      {6, "cutRoot"},
      {7, "authorityRoot"},
      {8, "admissionRoots"}}},
    {"kungfu.fact.temporal-path-query/v1",
     {{1, "schema"},
      {2, "queryId"},
      {3, "operation"},
      {4, "predicateRoot"},
      {5, "sourceRoot"},
      {6, "targetRoot"},
      {7, "cutRoot"},
      {8, "relationPathRoots"},
      {9, "requiredAuthorityRoot"},
      {10, "maxDepth"}}},
    {"kungfu.fact.temporal-path-receipt/v1",
     {{1, "schema"},
      {2, "queryRoot"},
      {3, "status"},
      {4, "failureCode"},
      {5, "cutRoot"},
      {6, "relationPathRoots"},
      {7, "authorityProofRoots"},
      {8, "omissionRoots"}}},
    {"kungfu.fact.root-mapping-receipt/v1",
     {{1, "schema"},
      {2, "legacyProtocol"},
      {3, "legacyRoot"},
      {4, "successorProtocol"},
      {5, "successorRoot"},
      {6, "admissionRoot"}}},
};

const std::map<std::string, std::vector<std::string>> RECORD_ROOT_FIELDS = {
    {"kungfu.fact.object/v1", {"schema", "objectId", "objectType", "createdByReceiptRoot"}},
    {"kungfu.fact.version/v1",
     {"schema", "objectId", "bodyRoot", "schemaRoot", "parentVersionRoots", "declarationRoots", "admissionRoots"}},
    {"kungfu.fact.relation-add/v1",
     {"schema", "relationId", "relationType", "source", "target", "attributesRoot", "admissionRoots"}},
    {"kungfu.fact.relation-revoke/v1", {"schema", "relationRoot", "reasonRoot"}},
    {"kungfu.fact.cut/v1",
     {"schema", "parentCutRoots", "objectVersions", "activeRelationRoots", "declarationRoots", "admissionRoots",
      "episodeFrontier", "omissionRoots", "conflictRoots"}},
    {"kungfu.fact.ref-transition/v1",
     {"schema", "transitionId", "refName", "expectedOldCutRoot", "expectedOldRevision", "newCutRoot", "kind",
      "reasonRoot"}},
    {"kungfu.fact.operation-receipt/v1",
     {"schema", "operationId", "operation", "status", "failureCode", "recordRoot", "priorCutRoot", "currentCutRoot",
      "priorRevision", "currentRevision"}},
};

template <size_t N> std::string fixed_string(const kungfu::array<char, N> &value) {
  size_t length = 0;
  while (length < N && value.value[length] != '\0') {
    ++length;
  }
  return std::string(value.value, length);
}

template <size_t N> void set_fixed(kungfu::array<char, N> &target, const std::string &value, const char *field) {
  if (value.size() >= N) {
    throw std::invalid_argument(std::string(field) + " exceeds native record capacity");
  }
  kungfu::copy_string(target, value.c_str());
}

std::string required_text(const nlohmann::json &value, const char *field) {
  if (!value.is_object() || !value.contains(field) || !value.at(field).is_string() ||
      value.at(field).get<std::string>().empty()) {
    throw fact_request_error("invalid-field", std::string(field) + " is required and must be a non-empty string");
  }
  return value.at(field).get<std::string>();
}

std::string text_or(const nlohmann::json &value, const char *field, const std::string &fallback) {
  return value.is_object() && value.contains(field) && value.at(field).is_string() ? value.at(field).get<std::string>()
                                                                                   : fallback;
}

uint64_t uint64_or(const nlohmann::json &value, const char *field, uint64_t fallback) {
  if (!value.is_object() || !value.contains(field)) {
    return fallback;
  }
  const auto &candidate = value.at(field);
  if (candidate.is_number_unsigned()) {
    return candidate.get<uint64_t>();
  }
  if (candidate.is_number_integer()) {
    const auto signed_value = candidate.get<int64_t>();
    return signed_value >= 0 ? static_cast<uint64_t>(signed_value) : fallback;
  }
  return fallback;
}

bool is_nonnegative_integer(const nlohmann::json &value) {
  return value.is_number_unsigned() || (value.is_number_integer() && value.get<int64_t>() >= 0);
}

nlohmann::json array_or_empty(const nlohmann::json &value, const char *field) {
  if (!value.is_object() || !value.contains(field)) {
    return nlohmann::json::array();
  }
  if (!value.at(field).is_array()) {
    throw fact_request_error("invalid-field", std::string(field) + " must be an array");
  }
  return value.at(field);
}

void append_u64(std::string &output, uint64_t value) {
  for (int shift = 56; shift >= 0; shift -= 8) {
    output.push_back(static_cast<char>((value >> shift) & 0xffU));
  }
}

class canonical_encoding_error : public std::invalid_argument {
public:
  canonical_encoding_error(std::string code, const std::string &message)
      : std::invalid_argument(message), code_(std::move(code)) {}

  [[nodiscard]] const std::string &code() const { return code_; }

private:
  std::string code_;
};

[[noreturn]] void canonical_fail(const std::string &code, const std::string &message) {
  throw canonical_encoding_error(code, message);
}

std::string required_descriptor_text(const nlohmann::json &value, const char *field) {
  if (!value.is_object() || !value.contains(field) || !value.at(field).is_string()) {
    canonical_fail("canonical-invalid-descriptor", std::string(field) + " must be a string");
  }
  return value.at(field).get<std::string>();
}

unsigned char hex_nibble(char value) {
  if (value >= '0' && value <= '9') {
    return static_cast<unsigned char>(value - '0');
  }
  if (value >= 'a' && value <= 'f') {
    return static_cast<unsigned char>(value - 'a' + 10);
  }
  canonical_fail("canonical-invalid-hex", "hex must use lower-case digits");
}

std::string decode_lower_hex(const nlohmann::json &value, const char *field) {
  const auto raw = required_descriptor_text(value, field);
  if (raw.size() % 2 != 0) {
    canonical_fail("canonical-invalid-hex", std::string(field) + " must contain whole bytes");
  }
  std::string result;
  result.reserve(raw.size() / 2);
  for (size_t index = 0; index < raw.size(); index += 2) {
    result.push_back(static_cast<char>((hex_nibble(raw[index]) << 4U) | hex_nibble(raw[index + 1])));
  }
  return result;
}

void validate_scalar_utf8(const std::string &raw) {
  size_t index = 0;
  while (index < raw.size()) {
    const auto first = static_cast<unsigned char>(raw[index]);
    uint32_t scalar = 0;
    size_t width = 0;
    if (first <= 0x7fU) {
      scalar = first;
      width = 1;
    } else if (first >= 0xc2U && first <= 0xdfU) {
      scalar = first & 0x1fU;
      width = 2;
    } else if (first >= 0xe0U && first <= 0xefU) {
      scalar = first & 0x0fU;
      width = 3;
    } else if (first >= 0xf0U && first <= 0xf4U) {
      scalar = first & 0x07U;
      width = 4;
    } else {
      canonical_fail("canonical-invalid-unicode", "text is not shortest-form UTF-8");
    }
    if (raw.size() - index < width) {
      canonical_fail("canonical-invalid-unicode", "text has a truncated UTF-8 scalar");
    }
    for (size_t offset = 1; offset < width; ++offset) {
      const auto next = static_cast<unsigned char>(raw[index + offset]);
      if ((next & 0xc0U) != 0x80U) {
        canonical_fail("canonical-invalid-unicode", "text has an invalid UTF-8 continuation byte");
      }
      scalar = (scalar << 6U) | (next & 0x3fU);
    }
    const auto overlong =
        (width == 2 && scalar < 0x80U) || (width == 3 && scalar < 0x800U) || (width == 4 && scalar < 0x10000U);
    if (overlong || scalar > 0x10ffffU || (scalar >= 0xd800U && scalar <= 0xdfffU)) {
      canonical_fail("canonical-invalid-unicode", "text contains a non-scalar or non-shortest UTF-8 sequence");
    }
    index += width;
  }
}

uint64_t parse_canonical_u64(const std::string &raw) {
  if (raw.empty() || (raw.size() > 1 && raw.front() == '0')) {
    canonical_fail("canonical-invalid-descriptor", "u64 must use canonical decimal");
  }
  uint64_t result = 0;
  for (const auto digit : raw) {
    if (!std::isdigit(static_cast<unsigned char>(digit))) {
      canonical_fail("canonical-invalid-descriptor", "u64 must use canonical decimal");
    }
    const auto value = static_cast<uint64_t>(digit - '0');
    if (result > (std::numeric_limits<uint64_t>::max() - value) / 10U) {
      canonical_fail("canonical-integer-range", "u64 is out of range");
    }
    result = result * 10U + value;
  }
  return result;
}

int64_t parse_canonical_i64(const std::string &raw) {
  const auto negative = !raw.empty() && raw.front() == '-';
  const auto digits = negative ? raw.substr(1) : raw;
  if (digits.empty() || (digits.size() > 1 && digits.front() == '0') || (negative && digits == "0")) {
    canonical_fail("canonical-invalid-descriptor", "i64 must use canonical decimal");
  }
  uint64_t magnitude = 0;
  for (const auto digit : digits) {
    if (!std::isdigit(static_cast<unsigned char>(digit))) {
      canonical_fail("canonical-invalid-descriptor", "i64 must use canonical decimal");
    }
    const auto value = static_cast<uint64_t>(digit - '0');
    if (magnitude > (std::numeric_limits<uint64_t>::max() - value) / 10U) {
      canonical_fail("canonical-integer-range", "i64 is out of range");
    }
    magnitude = magnitude * 10U + value;
  }
  const auto negative_limit = uint64_t{1} << 63U;
  if ((!negative && magnitude > static_cast<uint64_t>(std::numeric_limits<int64_t>::max())) ||
      (negative && magnitude > negative_limit)) {
    canonical_fail("canonical-integer-range", "i64 is out of range");
  }
  if (!negative) {
    return static_cast<int64_t>(magnitude);
  }
  if (magnitude == negative_limit) {
    return std::numeric_limits<int64_t>::min();
  }
  return -static_cast<int64_t>(magnitude);
}

void append_text_value(std::string &output, const std::string &raw) {
  validate_scalar_utf8(raw);
  output.push_back(static_cast<char>(0x20));
  append_u64(output, raw.size());
  output.append(raw);
}

std::string portable_typed_value(const nlohmann::json &value);

std::string portable_sequence_value(const nlohmann::json &value, const std::string &type) {
  if (!value.contains("items") || !value.at("items").is_array()) {
    canonical_fail("canonical-invalid-descriptor", type + " items must be an array");
  }
  std::vector<std::string> items;
  for (const auto &item : value.at("items"))
    items.push_back(portable_typed_value(item));
  if (type == "set") {
    std::sort(items.begin(), items.end());
    if (std::adjacent_find(items.begin(), items.end()) != items.end())
      canonical_fail("canonical-duplicate-item", "set contains equal canonical items");
  }
  std::string output;
  output.push_back(static_cast<char>(type == "array" ? 0x30 : 0x31));
  append_u64(output, items.size());
  for (const auto &item : items)
    output.append(item);
  return output;
}

std::string portable_map_value(const nlohmann::json &value) {
  if (!value.contains("entries") || !value.at("entries").is_array())
    canonical_fail("canonical-invalid-descriptor", "map entries must be an array");
  std::vector<std::pair<std::string, std::string>> entries;
  for (const auto &entry : value.at("entries")) {
    if (!entry.is_object() || entry.size() != 2 || !entry.contains("key") || !entry.contains("value") ||
        !entry.at("key").is_object() || entry.at("key").value("type", std::string{}) != "text")
      canonical_fail("canonical-invalid-descriptor", "map entry requires one text key and one value");
    entries.emplace_back(portable_typed_value(entry.at("key")), portable_typed_value(entry.at("value")));
  }
  std::sort(entries.begin(), entries.end(),
            [](const auto &left, const auto &right) { return left.first < right.first; });
  if (std::adjacent_find(entries.begin(), entries.end(), [](const auto &left, const auto &right) {
        return left.first == right.first;
      }) != entries.end())
    canonical_fail("canonical-duplicate-key", "map contains equal canonical keys");
  std::string output;
  output.push_back(static_cast<char>(0x32));
  append_u64(output, entries.size());
  for (const auto &[key, child] : entries) {
    output.append(key);
    output.append(child);
  }
  return output;
}

std::string portable_record_value(const nlohmann::json &value) {
  const auto schema = required_descriptor_text(value, "schema");
  const auto known_schema = PORTABLE_RECORD_SCHEMAS.find(schema);
  if (known_schema == PORTABLE_RECORD_SCHEMAS.end())
    canonical_fail("canonical-unknown-schema", "record schema is not registered");
  if (!value.contains("fields") || !value.at("fields").is_array())
    canonical_fail("canonical-invalid-descriptor", "record fields must be an array");
  std::vector<std::pair<uint64_t, std::string>> fields;
  for (const auto &field : value.at("fields")) {
    if (!field.is_object() || field.size() != 2 || !field.contains("id") || !field.contains("value"))
      canonical_fail("canonical-invalid-descriptor", "record field requires id and value");
    const auto field_id = parse_canonical_u64(required_descriptor_text(field, "id"));
    const auto registered_field = std::find_if(known_schema->second.begin(), known_schema->second.end(),
                                               [field_id](const auto &candidate) { return candidate.id == field_id; });
    if (registered_field == known_schema->second.end())
      canonical_fail("canonical-unknown-field", "record field is not registered");
    fields.emplace_back(field_id, portable_typed_value(field.at("value")));
  }
  std::sort(fields.begin(), fields.end(), [](const auto &left, const auto &right) { return left.first < right.first; });
  if (std::adjacent_find(fields.begin(), fields.end(),
                         [](const auto &left, const auto &right) { return left.first == right.first; }) != fields.end())
    canonical_fail("canonical-duplicate-field", "record contains a duplicate field id");
  for (const auto &registered_field : known_schema->second) {
    const auto is_present = std::any_of(fields.begin(), fields.end(), [&registered_field](const auto &field) {
      return field.first == registered_field.id;
    });
    if (!registered_field.optional && !is_present)
      canonical_fail("canonical-missing-field", "record is missing a required field");
  }
  std::string output;
  output.push_back(static_cast<char>(0x40));
  append_text_value(output, schema);
  append_u64(output, fields.size());
  for (const auto &[field_id, child] : fields) {
    append_u64(output, field_id);
    output.append(child);
  }
  return output;
}

std::string portable_typed_value(const nlohmann::json &value) {
  if (!value.is_object() || !value.contains("type") || !value.at("type").is_string()) {
    canonical_fail("canonical-invalid-descriptor", "typed value requires a type");
  }
  const auto type = value.at("type").get<std::string>();
  std::string output;
  if (type == "absent") {
    canonical_fail("canonical-absent", "absent is a schema condition, not a value");
  }
  if (type == "null") {
    output.push_back(static_cast<char>(0x00));
    return output;
  }
  if (type == "bool") {
    if (!value.contains("value") || !value.at("value").is_boolean()) {
      canonical_fail("canonical-invalid-descriptor", "bool value must be boolean");
    }
    output.push_back(static_cast<char>(value.at("value").get<bool>() ? 0x02 : 0x01));
    return output;
  }
  if (type == "u64") {
    output.push_back(static_cast<char>(0x10));
    append_u64(output, parse_canonical_u64(required_descriptor_text(value, "value")));
    return output;
  }
  if (type == "i64") {
    output.push_back(static_cast<char>(0x11));
    append_u64(output, static_cast<uint64_t>(parse_canonical_i64(required_descriptor_text(value, "value"))));
    return output;
  }
  if (type == "f64") {
    const auto bits = decode_lower_hex(value, "bits");
    if (bits.size() != 8) {
      canonical_fail("canonical-invalid-hex", "f64 bits must contain 8 bytes");
    }
    const auto exponent =
        (static_cast<unsigned char>(bits[0]) & 0x7fU) << 4U | (static_cast<unsigned char>(bits[1]) >> 4U);
    if (exponent == 0x7ffU) {
      canonical_fail("canonical-non-finite-float", "NaN and infinity are forbidden");
    }
    output.push_back(static_cast<char>(0x12));
    output.append(bits);
    return output;
  }
  if (type == "text") {
    const auto raw =
        value.contains("utf8_hex") ? decode_lower_hex(value, "utf8_hex") : required_descriptor_text(value, "value");
    append_text_value(output, raw);
    return output;
  }
  if (type == "bytes") {
    const auto raw = decode_lower_hex(value, "hex");
    output.push_back(static_cast<char>(0x21));
    append_u64(output, raw.size());
    output.append(raw);
    return output;
  }
  if (type == "array" || type == "set") {
    return portable_sequence_value(value, type);
  }
  if (type == "map") {
    return portable_map_value(value);
  }
  if (type == "record") {
    return portable_record_value(value);
  }
  canonical_fail("canonical-unsupported-type", "unsupported canonical type: " + type);
}

std::string portable_root_preimage(const nlohmann::json &value) {
  std::string output(PORTABLE_ROOT_MAGIC.begin(), PORTABLE_ROOT_MAGIC.end());
  output.append(portable_typed_value(value));
  return output;
}

nlohmann::json typed_text(const nlohmann::json &value) { return {{"type", "text"}, {"value", value}}; }
nlohmann::json typed_u64(const nlohmann::json &value) {
  return {{"type", "u64"}, {"value", std::to_string(value.get<uint64_t>())}};
}
nlohmann::json typed_record(const std::string &schema, const std::vector<std::pair<uint64_t, nlohmann::json>> &fields) {
  auto encoded = nlohmann::json::array();
  for (const auto &[id, value] : fields) {
    encoded.push_back({{"id", std::to_string(id)}, {"value", value}});
  }
  return {{"type", "record"}, {"schema", schema}, {"fields", std::move(encoded)}};
}

nlohmann::json typed_json(const nlohmann::json &value) {
  if (value.is_null())
    return {{"type", "null"}};
  if (value.is_boolean())
    return {{"type", "bool"}, {"value", value}};
  if (value.is_number_unsigned() || (value.is_number_integer() && value.get<int64_t>() >= 0))
    return typed_u64(value);
  if (value.is_number_integer())
    return {{"type", "i64"}, {"value", std::to_string(value.get<int64_t>())}};
  if (value.is_string())
    return typed_text(value);
  if (value.is_array()) {
    auto items = nlohmann::json::array();
    for (const auto &item : value)
      items.push_back(typed_json(item));
    return {{"type", "array"}, {"items", std::move(items)}};
  }
  if (value.is_object()) {
    auto entries = nlohmann::json::array();
    for (const auto &[key, child] : value.items())
      entries.push_back({{"key", typed_text(key)}, {"value", typed_json(child)}});
    return {{"type", "map"}, {"entries", std::move(entries)}};
  }
  canonical_fail("canonical-invalid-descriptor", "metadata contains an unsupported JSON value");
}

nlohmann::json typed_set(const nlohmann::json &values) {
  auto items = nlohmann::json::array();
  for (const auto &value : values)
    items.push_back(typed_json(value));
  return {{"type", "set"}, {"items", std::move(items)}};
}

nlohmann::json typed_endpoint(const nlohmann::json &value) {
  std::vector<std::pair<uint64_t, nlohmann::json>> fields = {{1, typed_text(value.at("kind"))},
                                                             {2, typed_text(value.at("id"))}};
  if (value.contains("mapping_receipt_root"))
    fields.push_back({3, typed_text(value.at("mapping_receipt_root"))});
  return typed_record("kungfu.fact.relation-endpoint/v2", fields);
}

std::string portable_schema_for_domain(const std::string &domain) {
  static const std::map<std::string, std::string> schemas = {
      {"kungfu.fact.object/v1", "kungfu.fact.object/v2"},
      {"kungfu.fact.version/v1", "kungfu.fact.version/v2"},
      {"kungfu.fact.relation-add/v1", "kungfu.fact.relation-add/v2"},
      {"kungfu.fact.relation-revoke/v1", "kungfu.fact.relation-revoke/v2"},
      {"kungfu.fact.cut/v1", "kungfu.fact.cut/v2"},
      {"kungfu.fact.ref-transition/v1", "kungfu.fact.ref-transition/v2"},
      {"kungfu.fact.operation-receipt/v1", "kungfu.fact.operation-receipt/v2"},
      {"fact-operation-request/v1", "kungfu.fact.operation-request/v2"},
      {"kungfu.fact.root-mapping-receipt/v1", "kungfu.fact.root-mapping-receipt/v1"},
  };
  const auto found = schemas.find(domain);
  return found == schemas.end() ? std::string{} : found->second;
}

nlohmann::json portable_metadata_descriptor(const std::string &domain, const nlohmann::json &value) {
  const auto schema = portable_schema_for_domain(domain);
  if (domain == "fact-operation-request/v1") {
    auto arguments = value;
    const auto action = arguments.at("action");
    arguments.erase("action");
    return typed_record(schema, {{1, typed_text(action)}, {2, typed_json(arguments)}});
  }
  if (domain == "kungfu.fact.root-mapping-receipt/v1") {
    return typed_record(schema, {{1, typed_text("kungfu.fact.root-mapping-receipt/v1")},
                                 {2, typed_text(value.at("legacyProtocol"))},
                                 {3, typed_text(value.at("legacyRoot"))},
                                 {4, typed_text(value.at("successorProtocol"))},
                                 {5, typed_text(value.at("successorRoot"))},
                                 {6, typed_text(value.at("admissionRoot"))}});
  }
  if (schema.empty()) {
    return typed_record("kungfu.fact.root-set/v2", {{1, typed_text(domain)}, {2, typed_set(value)}});
  }
  const auto schema_value = typed_text(schema);
  if (domain == "kungfu.fact.object/v1")
    return typed_record(schema, {{1, schema_value},
                                 {2, typed_text(value.at("objectId"))},
                                 {3, typed_text(value.at("objectType"))},
                                 {4, typed_text(value.at("createdByReceiptRoot"))}});
  if (domain == "kungfu.fact.version/v1")
    return typed_record(schema, {{1, schema_value},
                                 {2, typed_text(value.at("objectId"))},
                                 {3, typed_text(value.at("bodyRoot"))},
                                 {4, typed_text(value.at("schemaRoot"))},
                                 {5, typed_set(value.at("parentVersionRoots"))},
                                 {6, typed_set(value.at("declarationRoots"))},
                                 {7, typed_set(value.at("admissionRoots"))}});
  if (domain == "kungfu.fact.relation-add/v1")
    return typed_record(schema, {{1, schema_value},
                                 {2, typed_text(value.at("relationId"))},
                                 {3, typed_text(value.at("relationType"))},
                                 {4, typed_endpoint(value.at("source"))},
                                 {5, typed_endpoint(value.at("target"))},
                                 {6, typed_text(value.at("attributesRoot"))},
                                 {7, typed_set(value.at("admissionRoots"))}});
  if (domain == "kungfu.fact.relation-revoke/v1")
    return typed_record(
        schema,
        {{1, schema_value}, {2, typed_text(value.at("relationRoot"))}, {3, typed_text(value.at("reasonRoot"))}});
  if (domain == "kungfu.fact.cut/v1")
    return typed_record(schema, {{1, schema_value},
                                 {2, typed_set(value.at("parentCutRoots"))},
                                 {3, typed_set(value.at("objectVersions"))},
                                 {4, typed_set(value.at("activeRelationRoots"))},
                                 {5, typed_set(value.at("declarationRoots"))},
                                 {6, typed_set(value.at("admissionRoots"))},
                                 {7, typed_set(value.at("episodeFrontier"))},
                                 {8, typed_set(value.at("omissionRoots"))},
                                 {9, typed_set(value.at("conflictRoots"))}});
  if (domain == "kungfu.fact.ref-transition/v1")
    return typed_record(schema, {{1, schema_value},
                                 {2, typed_text(value.at("transitionId"))},
                                 {3, typed_text(value.at("refName"))},
                                 {4, typed_text(value.at("expectedOldCutRoot"))},
                                 {5, typed_u64(value.at("expectedOldRevision"))},
                                 {6, typed_text(value.at("newCutRoot"))},
                                 {7, typed_text(value.at("kind"))},
                                 {8, typed_text(value.at("reasonRoot"))}});
  return typed_record(schema, {{1, schema_value},
                               {2, typed_text(value.at("operationId"))},
                               {3, typed_text(value.at("operation"))},
                               {4, typed_text(value.at("status"))},
                               {5, typed_json(value.at("failureCode"))},
                               {6, typed_text(value.at("recordRoot"))},
                               {7, typed_text(value.at("priorCutRoot"))},
                               {8, typed_text(value.at("currentCutRoot"))},
                               {9, typed_u64(value.at("priorRevision"))},
                               {10, typed_u64(value.at("currentRevision"))}});
}

std::string lower_hex(const std::string &raw) {
  static constexpr std::array<char, 16> HEX = {'0', '1', '2', '3', '4', '5', '6', '7',
                                               '8', '9', 'a', 'b', 'c', 'd', 'e', 'f'};
  std::string output;
  output.reserve(raw.size() * 2);
  for (const auto value : raw) {
    const auto byte = static_cast<unsigned char>(value);
    output.push_back(HEX[byte >> 4U]);
    output.push_back(HEX[byte & 0x0fU]);
  }
  return output;
}

uint64_t read_u64(const std::string &input, size_t &position) {
  if (input.size() - position < 8) {
    throw std::runtime_error("fact metadata preimage is truncated");
  }
  uint64_t value = 0;
  for (size_t index = 0; index < 8; ++index) {
    value = (value << 8U) | static_cast<unsigned char>(input[position++]);
  }
  return value;
}

std::string read_portable_bytes(const std::string &input, size_t &position) {
  const auto size = read_u64(input, position);
  if (size > input.size() - position)
    throw std::runtime_error("portable Fact metadata is truncated");
  auto result = input.substr(position, static_cast<size_t>(size));
  position += static_cast<size_t>(size);
  return result;
}

void validate_portable_count(uint64_t count, size_t remaining_bytes, size_t minimum_bytes_per_entry, const char *kind) {
  if (count > remaining_bytes / minimum_bytes_per_entry) {
    throw std::runtime_error(std::string("portable Fact ") + kind + " count exceeds the remaining input");
  }
}

nlohmann::json decode_portable_value(const std::string &input, size_t &position) {
  if (position >= input.size())
    throw std::runtime_error("portable Fact metadata is truncated");
  const auto tag = static_cast<unsigned char>(input[position++]);
  if (tag == 0x00U)
    return nullptr;
  if (tag == 0x01U || tag == 0x02U)
    return tag == 0x02U;
  if (tag == 0x10U)
    return read_u64(input, position);
  if (tag == 0x11U)
    return std::bit_cast<int64_t>(read_u64(input, position));
  if (tag == 0x12U) {
    const auto bits = read_u64(input, position);
    return std::bit_cast<double>(bits);
  }
  if (tag == 0x20U) {
    auto text = read_portable_bytes(input, position);
    validate_scalar_utf8(text);
    return text;
  }
  if (tag == 0x21U)
    return lower_hex(read_portable_bytes(input, position));
  if (tag == 0x30U || tag == 0x31U) {
    const auto count = read_u64(input, position);
    validate_portable_count(count, input.size() - position, 1, tag == 0x30U ? "array" : "set");
    auto values = nlohmann::json::array();
    for (uint64_t index = 0; index < count; ++index)
      values.push_back(decode_portable_value(input, position));
    return values;
  }
  if (tag == 0x32U) {
    const auto count = read_u64(input, position);
    validate_portable_count(count, input.size() - position, 2, "map");
    auto value = nlohmann::json::object();
    for (uint64_t index = 0; index < count; ++index) {
      const auto key = decode_portable_value(input, position);
      if (!key.is_string())
        throw std::runtime_error("portable Fact map key is not text");
      value[key.get<std::string>()] = decode_portable_value(input, position);
    }
    return value;
  }
  if (tag == 0x40U) {
    const auto schema = decode_portable_value(input, position);
    if (!schema.is_string())
      throw std::runtime_error("portable Fact record schema is not text");
    const auto registered_schema = PORTABLE_RECORD_SCHEMAS.find(schema.get<std::string>());
    if (registered_schema == PORTABLE_RECORD_SCHEMAS.end())
      throw std::runtime_error("portable Fact record schema is unknown");
    const auto count = read_u64(input, position);
    validate_portable_count(count, input.size() - position, 9, "record field");
    auto value = nlohmann::json::object();
    for (uint64_t index = 0; index < count; ++index) {
      const auto field_id = read_u64(input, position);
      const auto registered_field = std::find_if(registered_schema->second.begin(), registered_schema->second.end(),
                                                 [field_id](const auto &field) { return field.id == field_id; });
      if (registered_field == registered_schema->second.end())
        throw std::runtime_error("portable Fact record field is unknown");
      value[registered_field->name] = decode_portable_value(input, position);
    }
    return value;
  }
  throw std::runtime_error("portable Fact metadata type tag is unknown");
}

nlohmann::json decode_portable_metadata(const std::string &raw, const std::string &expected_domain) {
  if (raw.size() < PORTABLE_ROOT_MAGIC.size() ||
      !std::equal(PORTABLE_ROOT_MAGIC.begin(), PORTABLE_ROOT_MAGIC.end(), raw.begin()))
    throw std::runtime_error("portable Fact metadata magic is missing");
  size_t position = PORTABLE_ROOT_MAGIC.size();
  auto value = decode_portable_value(raw, position);
  if (position != raw.size() || !value.is_object())
    throw std::runtime_error("portable Fact metadata has trailing bytes or a non-record root");
  const auto expected_schema = portable_schema_for_domain(expected_domain);
  if (!expected_schema.empty() && value.value("schema", expected_schema) != expected_schema)
    throw std::runtime_error("portable Fact metadata domain mismatch");
  if (value.contains("domain") && !expected_domain.empty() && value.at("domain") != expected_domain)
    throw std::runtime_error("portable Fact root-set domain mismatch");
  auto document = value.contains("roots") && value.contains("domain") ? value.at("roots") : value;
  if (expected_domain.empty() || portable_root_preimage(portable_metadata_descriptor(expected_domain, document)) != raw)
    throw std::runtime_error("portable Fact metadata is not the canonical preimage for its declared domain");
  return document;
}

std::string encode_atoms(const std::vector<std::string> &atoms) {
  std::string output;
  append_u64(output, atoms.size());
  for (const auto &atom : atoms) {
    append_u64(output, atom.size());
    output.append(atom);
  }
  return output;
}

std::vector<std::string> decode_atoms(const std::string &input) {
  size_t position = 0;
  const auto count = read_u64(input, position);
  std::vector<std::string> atoms;
  atoms.reserve(static_cast<size_t>(count));
  for (uint64_t index = 0; index < count; ++index) {
    const auto size = read_u64(input, position);
    if (size > input.size() - position) {
      throw std::runtime_error("fact metadata atom is truncated");
    }
    atoms.emplace_back(input.data() + position, static_cast<size_t>(size));
    position += static_cast<size_t>(size);
  }
  if (position != input.size()) {
    throw std::runtime_error("fact metadata preimage has trailing bytes");
  }
  return atoms;
}

std::string canonical_json(const nlohmann::json &value) { return value.dump(); }

std::string content_root(const std::string &raw) {
  return yy::storage::format_content_hash(yy::storage::compute_content_hash(raw));
}

std::string legacy_metadata_preimage(const std::string &domain, const nlohmann::json &input) {
  auto value = input;
  if (RECORD_ROOT_FIELDS.count(domain) != 0 && value.is_object() && value.contains("schema"))
    value["schema"] = domain;
  const auto fields = RECORD_ROOT_FIELDS.find(domain);
  if (fields == RECORD_ROOT_FIELDS.end()) {
    return encode_atoms({LEGACY_ROOT_PROTOCOL, domain, canonical_json(value)});
  }
  std::vector<std::string> atoms = {domain};
  atoms.reserve(fields->second.size() + 1);
  for (const auto &field : fields->second) {
    if (!value.contains(field)) {
      throw std::invalid_argument("missing root field " + field + " for " + domain);
    }
    atoms.push_back(canonical_json(value.at(field)));
  }
  return encode_atoms(atoms);
}

std::string metadata_preimage(const std::string &domain, const nlohmann::json &value, const std::string &protocol) {
  if (protocol == LEGACY_ROOT_PROTOCOL)
    return legacy_metadata_preimage(domain, value);
  if (protocol == PORTABLE_ROOT_PROTOCOL)
    return portable_root_preimage(portable_metadata_descriptor(domain, value));
  throw fact_request_error("unsupported-version", "unsupported Fact root writer protocol: " + protocol);
}

std::string metadata_root(const std::string &domain, const nlohmann::json &value, const std::string &protocol) {
  return content_root(metadata_preimage(domain, value, protocol));
}

std::string store_metadata(const std::string &runtime_dir, const std::string &domain, const nlohmann::json &value,
                           const std::string &protocol) {
  const auto raw = metadata_preimage(domain, value, protocol);
  const auto root = content_root(raw);
  const auto result = content_store_put_if_absent(runtime_dir, METADATA_NAMESPACE, raw, root);
  if (!result.value("ok", false)) {
    throw std::runtime_error("fact metadata store failed: " + result.value("message", std::string("unknown")));
  }
  return root;
}

nlohmann::json load_metadata(const std::string &runtime_dir, const std::string &root,
                             const std::string &expected_domain) {
  const auto raw = content_store_get(runtime_dir, METADATA_NAMESPACE, root);
  if (raw.size() >= PORTABLE_ROOT_MAGIC.size() &&
      std::equal(PORTABLE_ROOT_MAGIC.begin(), PORTABLE_ROOT_MAGIC.end(), raw.begin()))
    return decode_portable_metadata(raw, expected_domain);
  const auto atoms = decode_atoms(raw);
  if (atoms.size() == 3 && atoms[0] == LEGACY_ROOT_PROTOCOL) {
    if (!expected_domain.empty() && atoms[1] != expected_domain) {
      throw std::runtime_error("fact metadata domain mismatch for " + root);
    }
    return nlohmann::json::parse(atoms[2]);
  }
  const auto fields = RECORD_ROOT_FIELDS.find(atoms.empty() ? std::string{} : atoms[0]);
  if (fields == RECORD_ROOT_FIELDS.end() || atoms.size() != fields->second.size() + 1 ||
      (!expected_domain.empty() && atoms[0] != expected_domain)) {
    throw std::runtime_error("fact metadata domain mismatch for " + root);
  }
  auto document = nlohmann::json::object();
  for (size_t index = 0; index < fields->second.size(); ++index) {
    document[fields->second[index]] = nlohmann::json::parse(atoms[index + 1]);
  }
  return document;
}

nlohmann::json root_mapping_receipt(const std::string &domain, const nlohmann::json &document,
                                    const std::string &successor_root, const std::string &admission_root) {
  return {{"schema", "kungfu.fact.root-mapping-receipt/v1"},
          {"legacyProtocol", LEGACY_ROOT_PROTOCOL},
          {"legacyRoot", metadata_root(domain, document, LEGACY_ROOT_PROTOCOL)},
          {"successorProtocol", PORTABLE_ROOT_PROTOCOL},
          {"successorRoot", successor_root},
          {"admissionRoot", admission_root}};
}

std::string root_mapping_receipt_root(const nlohmann::json &receipt) {
  return metadata_root("kungfu.fact.root-mapping-receipt/v1", receipt, PORTABLE_ROOT_PROTOCOL);
}

std::vector<std::string> normalized_roots(const nlohmann::json &value, const char *field) {
  std::vector<std::string> roots;
  size_t index = 0;
  for (const auto &entry : array_or_empty(value, field)) {
    if (!entry.is_string() || entry.get<std::string>().empty()) {
      throw fact_request_error("invalid-field", std::string(field) + "[" + std::to_string(index) +
                                                    "] must be a non-empty sha256 content root");
    }
    const auto root = entry.get<std::string>();
    try {
      validate_root(root, field);
    } catch (const fact_request_error &) {
      throw fact_request_error("invalid-field",
                               std::string(field) + "[" + std::to_string(index) + "] must be a sha256 content root");
    }
    roots.push_back(root);
    ++index;
  }
  std::sort(roots.begin(), roots.end());
  if (std::adjacent_find(roots.begin(), roots.end()) != roots.end()) {
    throw fact_request_error("invalid-field", std::string(field) + " contains duplicate roots");
  }
  return roots;
}

nlohmann::json root_array(const std::vector<std::string> &roots) {
  auto result = nlohmann::json::array();
  for (const auto &root : roots) {
    result.push_back(root);
  }
  return result;
}

std::string store_root_set(const std::string &runtime_dir, const std::string &domain,
                           const std::vector<std::string> &roots, const std::string &protocol) {
  return store_metadata(runtime_dir, domain, root_array(roots), protocol);
}

void validate_fact_id(const std::string &value, const char *field) {
  static const std::regex pattern("^fact:[0-9a-f]{32}$");
  if (!std::regex_match(value, pattern)) {
    throw fact_request_error("invalid-identity", std::string(field) + " must match fact:<32-lower-hex>");
  }
}

void validate_root(const std::string &value, const char *field, bool allow_empty) {
  static const std::regex pattern("^sha256:[0-9a-f]{64}$");
  if ((allow_empty && value.empty()) || std::regex_match(value, pattern)) {
    return;
  }
  throw fact_request_error("invalid-identity", std::string(field) + " must be a sha256 content root");
}

void validate_ref_name(const std::string &value) {
  static const std::regex pattern("^[a-z][a-z0-9._/-]{0,127}$");
  if (!std::regex_match(value, pattern) || value.find("..") != std::string::npos) {
    throw fact_request_error("invalid-identity", "ref_name is not canonical");
  }
}

void validate_transition_id(const std::string &value) {
  static const std::regex pattern("^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$");
  if (!std::regex_match(value, pattern)) {
    throw fact_request_error("invalid-identity", "transition_id is not canonical");
  }
}

void reject_environment_identity(const nlohmann::json &value) {
  static const std::set<std::string> forbidden = {"wall_clock", "timestamp",  "storage_path", "database_key",
                                                  "git_ref",    "process_id", "gui_route",    "runtime_dir",
                                                  "hostname",   "host",       "pid",          "absolute_path"};
  if (value.is_object()) {
    for (const auto &[key, child] : value.items()) {
      if (forbidden.count(key) != 0) {
        throw fact_request_error("invalid-identity", "environment-derived identity field is forbidden: " + key);
      }
      reject_environment_identity(child);
    }
  } else if (value.is_array()) {
    for (const auto &child : value) {
      reject_environment_identity(child);
    }
  }
}

bool qualification_faults_enabled() {
  const auto *value = std::getenv("KUNGFU_FACT_QUALIFICATION_FAULTS");
  return value != nullptr && std::string_view(value) == "1";
}

void require_qualification_fault_gate() {
  if (!qualification_faults_enabled()) {
    throw fact_request_error("invalid-field", "qualification_fault requires KUNGFU_FACT_QUALIFICATION_FAULTS=1");
  }
}

std::string failure_category_for(const std::string &code) {
  static const std::set<std::string> stable = {"invalid-request",  "invalid-action", "invalid-field",
                                               "invalid-identity", "stale-ref",      "integrity-failure",
                                               "backend-failure"};
  if (stable.count(code) != 0) {
    return code;
  }
  if (code == "unsupported-version") {
    return "invalid-action";
  }
  if (code == "import-interrupted" || code == "outcome-unknown") {
    return "backend-failure";
  }
  if (code == "durable-evidence-corrupt" || code == "authority-evidence-corrupt" ||
      code == "import-final-state-mismatch") {
    return "integrity-failure";
  }
  if (code == "expected-old-required" || code == "transition-id-reused" || code == "destination-drift" ||
      code == "destination-diverged") {
    return "stale-ref";
  }
  if (code.rfind("canonical-", 0) == 0 || code == "body-missing" || code == "invalid-cut" || code == "bundle-invalid") {
    return "invalid-field";
  }
  if (code.rfind("unknown-", 0) == 0 || code == "admission-missing" || code == "relation-endpoint-invalid" ||
      code == "relation-already-revoked" || code == "bundle-root-mismatch" || code == "import-operation-mismatch" ||
      code == "import-preflight-operation-mismatch" || code == "import-preflight-final-state-mismatch") {
    return "invalid-identity";
  }
  return "invalid-request";
}

nlohmann::json failure(const std::string &action, const std::string &code, const std::string &message,
                       const nlohmann::json &details) {
  return {{"schema", FACT_KERNEL_SCHEMA_V1},
          {"ok", false},
          {"action", action},
          {"status", "rejected"},
          {"failure_code", code},
          {"failure_category", failure_category_for(code)},
          {"message", message},
          {"details", details},
          {"write_occurred", false},
          {"receipt", nullptr}};
}

nlohmann::json canonical_root_result(const nlohmann::json &input) {
  try {
    if (!input.contains("value")) {
      canonical_fail("canonical-invalid-descriptor", "canonical-root requires value");
    }
    const auto preimage = portable_root_preimage(input.at("value"));
    return {{"schema", "kungfu.fact-root-canonical.result/v2"},
            {"ok", true},
            {"action", "canonical-root"},
            {"protocol", PORTABLE_ROOT_PROTOCOL},
            {"canonical_bytes_hex", lower_hex(preimage)},
            {"root", content_root(preimage)},
            {"write_occurred", false}};
  } catch (const canonical_encoding_error &error) {
    return failure("canonical-root", error.code(), error.what());
  } catch (const fact_request_error &error) {
    return failure("canonical-root", error.code(), error.what());
  } catch (const std::invalid_argument &error) {
    return failure("canonical-root", "invalid-request", error.what());
  } catch (const std::exception &error) {
    return failure("canonical-root", "backend-failure", error.what());
  }
}

} // namespace kungfu::runtime::storage_service_api::fact_kernel_internal
