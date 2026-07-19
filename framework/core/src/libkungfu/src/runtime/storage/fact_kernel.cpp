// SPDX-License-Identifier: Apache-2.0

#include <kungfu/runtime/storage/fact_kernel.h>

#include <algorithm>
#include <array>
#include <cctype>
#include <cstdint>
#include <filesystem>
#include <limits>
#include <map>
#include <memory>
#include <random>
#include <regex>
#include <set>
#include <stdexcept>
#include <string>
#include <tuple>
#include <utility>
#include <vector>

#include <kungfu/common.h>
#include <kungfu/runtime/storage/json_edge.h>
#include <kungfu/yijinjing/common.h>
#include <kungfu/yijinjing/journal/journal.h>
#include <kungfu/yijinjing/schema/types.h>
#include <kungfu/yijinjing/storage/content_hash.h>
#include <kungfu/yijinjing/time.h>

#ifdef _WIN32
#include <windows.h>
#else
#include <fcntl.h>
#include <sys/file.h>
#include <unistd.h>
#endif

namespace kungfu::runtime::storage_service_api {

namespace {

namespace fs = std::filesystem;
namespace yy = kungfu::yijinjing;
using namespace kungfu::yijinjing::data;
using namespace kungfu::yijinjing::enums;
using namespace kungfu::yijinjing::journal;
using namespace kungfu::yijinjing::types;

constexpr uint32_t SCHEMA_VERSION = 1;
constexpr const char *JOURNAL_NAMESPACE = "facts";
constexpr const char *JOURNAL_NAME = "kernel";
constexpr const char *METADATA_NAMESPACE = "fact-kernel-metadata";
constexpr const char *BODY_NAMESPACE = "fact-bodies";
constexpr const char *ROOT_PROTOCOL = "sha256-length-framed-fields-v1";
constexpr const char *PORTABLE_ROOT_PROTOCOL = "kungfu.fact-root.canonical/v2";
constexpr std::array<unsigned char, 4> PORTABLE_ROOT_MAGIC = {'K', 'F', 'R', '2'};

const std::map<std::string, std::set<uint64_t>> PORTABLE_RECORD_FIELDS = {
    {"kungfu.fact.object/v2", {1, 2, 3, 4}},
    {"kungfu.fact.version/v2", {1, 2, 3, 4, 5, 6, 7}},
    {"kungfu.fact.relation-endpoint/v2", {1, 2, 3}},
    {"kungfu.fact.relation-add/v2", {1, 2, 3, 4, 5, 6, 7}},
    {"kungfu.fact.relation-revoke/v2", {1, 2, 3}},
    {"kungfu.fact.cut/v2", {1, 2, 3, 4, 5, 6, 7, 8, 9}},
    {"kungfu.fact.ref-transition/v2", {1, 2, 3, 4, 5, 6, 7, 8}},
    {"kungfu.fact.operation-receipt/v2", {1, 2, 3, 4, 5, 6, 7, 8, 9, 10}},
    {"kungfu.fact.operation-request/v2", {1, 2}},
    {"kungfu.fact.root-set/v2", {1, 2}},
    {"kungfu.fact.authority-bundle/v2", {1, 2, 3, 4}},
    {"kungfu.fact.root-mapping-receipt/v1", {1, 2, 3, 4, 5, 6}},
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
    throw std::invalid_argument(std::string(field) + " is required");
  }
  return value.at(field).get<std::string>();
}

std::string text_or(const nlohmann::json &value, const char *field, const std::string &fallback = {}) {
  return value.is_object() && value.contains(field) && value.at(field).is_string() ? value.at(field).get<std::string>()
                                                                                   : fallback;
}

uint64_t uint64_or(const nlohmann::json &value, const char *field, uint64_t fallback = 0) {
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
    throw std::invalid_argument(std::string(field) + " must be an array");
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
    if (!value.contains("items") || !value.at("items").is_array()) {
      canonical_fail("canonical-invalid-descriptor", type + " items must be an array");
    }
    std::vector<std::string> items;
    for (const auto &item : value.at("items")) {
      items.push_back(portable_typed_value(item));
    }
    if (type == "set") {
      std::sort(items.begin(), items.end());
      if (std::adjacent_find(items.begin(), items.end()) != items.end()) {
        canonical_fail("canonical-duplicate-item", "set contains equal canonical items");
      }
    }
    output.push_back(static_cast<char>(type == "array" ? 0x30 : 0x31));
    append_u64(output, items.size());
    for (const auto &item : items) {
      output.append(item);
    }
    return output;
  }
  if (type == "map") {
    if (!value.contains("entries") || !value.at("entries").is_array()) {
      canonical_fail("canonical-invalid-descriptor", "map entries must be an array");
    }
    std::vector<std::pair<std::string, std::string>> entries;
    for (const auto &entry : value.at("entries")) {
      if (!entry.is_object() || entry.size() != 2 || !entry.contains("key") || !entry.contains("value") ||
          !entry.at("key").is_object() || entry.at("key").value("type", std::string{}) != "text") {
        canonical_fail("canonical-invalid-descriptor", "map entry requires one text key and one value");
      }
      entries.emplace_back(portable_typed_value(entry.at("key")), portable_typed_value(entry.at("value")));
    }
    std::sort(entries.begin(), entries.end(),
              [](const auto &left, const auto &right) { return left.first < right.first; });
    if (std::adjacent_find(entries.begin(), entries.end(), [](const auto &left, const auto &right) {
          return left.first == right.first;
        }) != entries.end()) {
      canonical_fail("canonical-duplicate-key", "map contains equal canonical keys");
    }
    output.push_back(static_cast<char>(0x32));
    append_u64(output, entries.size());
    for (const auto &[key, child] : entries) {
      output.append(key);
      output.append(child);
    }
    return output;
  }
  if (type == "record") {
    const auto schema = required_descriptor_text(value, "schema");
    const auto known_schema = PORTABLE_RECORD_FIELDS.find(schema);
    if (known_schema == PORTABLE_RECORD_FIELDS.end()) {
      canonical_fail("canonical-unknown-schema", "record schema is not registered");
    }
    if (!value.contains("fields") || !value.at("fields").is_array()) {
      canonical_fail("canonical-invalid-descriptor", "record fields must be an array");
    }
    std::vector<std::pair<uint64_t, std::string>> fields;
    for (const auto &field : value.at("fields")) {
      if (!field.is_object() || field.size() != 2 || !field.contains("id") || !field.contains("value")) {
        canonical_fail("canonical-invalid-descriptor", "record field requires id and value");
      }
      const auto field_id = parse_canonical_u64(required_descriptor_text(field, "id"));
      if (known_schema->second.count(field_id) == 0) {
        canonical_fail("canonical-unknown-field", "record field is not registered");
      }
      fields.emplace_back(field_id, portable_typed_value(field.at("value")));
    }
    std::sort(fields.begin(), fields.end(),
              [](const auto &left, const auto &right) { return left.first < right.first; });
    if (std::adjacent_find(fields.begin(), fields.end(), [](const auto &left, const auto &right) {
          return left.first == right.first;
        }) != fields.end()) {
      canonical_fail("canonical-duplicate-field", "record contains a duplicate field id");
    }
    output.push_back(static_cast<char>(0x40));
    append_text_value(output, schema);
    append_u64(output, fields.size());
    for (const auto &[field_id, child] : fields) {
      append_u64(output, field_id);
      output.append(child);
    }
    return output;
  }
  canonical_fail("canonical-unsupported-type", "unsupported canonical type: " + type);
}

std::string portable_root_preimage(const nlohmann::json &value) {
  std::string output(PORTABLE_ROOT_MAGIC.begin(), PORTABLE_ROOT_MAGIC.end());
  output.append(portable_typed_value(value));
  return output;
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

std::string metadata_preimage(const std::string &domain, const nlohmann::json &value) {
  const auto fields = RECORD_ROOT_FIELDS.find(domain);
  if (fields == RECORD_ROOT_FIELDS.end()) {
    return encode_atoms({ROOT_PROTOCOL, domain, canonical_json(value)});
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

std::string metadata_root(const std::string &domain, const nlohmann::json &value) {
  return content_root(metadata_preimage(domain, value));
}

std::string store_metadata(const std::string &runtime_dir, const std::string &domain, const nlohmann::json &value) {
  const auto raw = metadata_preimage(domain, value);
  const auto root = content_root(raw);
  const auto result = content_store_put_if_absent(runtime_dir, METADATA_NAMESPACE, raw, root);
  if (!result.value("ok", false)) {
    throw std::runtime_error("fact metadata store failed: " + result.value("message", std::string("unknown")));
  }
  return root;
}

nlohmann::json load_metadata(const std::string &runtime_dir, const std::string &root,
                             const std::string &expected_domain = {}) {
  const auto raw = content_store_get(runtime_dir, METADATA_NAMESPACE, root);
  const auto atoms = decode_atoms(raw);
  if (atoms.size() == 3 && atoms[0] == ROOT_PROTOCOL) {
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

std::vector<std::string> normalized_roots(const nlohmann::json &value, const char *field) {
  std::vector<std::string> roots;
  for (const auto &entry : array_or_empty(value, field)) {
    if (!entry.is_string() || entry.get<std::string>().empty()) {
      throw std::invalid_argument(std::string(field) + " entries must be non-empty roots");
    }
    roots.push_back(entry.get<std::string>());
  }
  std::sort(roots.begin(), roots.end());
  if (std::adjacent_find(roots.begin(), roots.end()) != roots.end()) {
    throw std::invalid_argument(std::string(field) + " contains duplicate roots");
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
                           const std::vector<std::string> &roots) {
  return store_metadata(runtime_dir, domain, root_array(roots));
}

void validate_fact_id(const std::string &value, const char *field) {
  static const std::regex pattern("^fact:[0-9a-f]{32}$");
  if (!std::regex_match(value, pattern)) {
    throw std::invalid_argument(std::string(field) + " must match fact:<32-lower-hex>");
  }
}

void validate_root(const std::string &value, const char *field, bool allow_empty = false) {
  static const std::regex pattern("^sha256:[0-9a-f]{64}$");
  if ((allow_empty && value.empty()) || std::regex_match(value, pattern)) {
    return;
  }
  throw std::invalid_argument(std::string(field) + " must be a sha256 content root");
}

void validate_ref_name(const std::string &value) {
  static const std::regex pattern("^[a-z][a-z0-9._/-]{0,127}$");
  if (!std::regex_match(value, pattern) || value.find("..") != std::string::npos) {
    throw std::invalid_argument("ref_name is not canonical");
  }
}

void validate_transition_id(const std::string &value) {
  static const std::regex pattern("^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$");
  if (!std::regex_match(value, pattern)) {
    throw std::invalid_argument("transition_id is not canonical");
  }
}

void reject_environment_identity(const nlohmann::json &value) {
  static const std::set<std::string> forbidden = {"wall_clock", "timestamp",  "storage_path", "database_key",
                                                  "git_ref",    "process_id", "gui_route",    "runtime_dir",
                                                  "hostname",   "host",       "pid",          "absolute_path"};
  if (value.is_object()) {
    for (const auto &[key, child] : value.items()) {
      if (forbidden.count(key) != 0) {
        throw std::invalid_argument("environment-derived identity field is forbidden: " + key);
      }
      reject_environment_identity(child);
    }
  } else if (value.is_array()) {
    for (const auto &child : value) {
      reject_environment_identity(child);
    }
  }
}

location_ptr kernel_location(const std::string &runtime_dir) {
  auto locator = std::make_shared<yy::data::locator>(runtime_dir, mode::LIVE);
  return location::make_shared(mode::LIVE, location_role::SYSTEM, JOURNAL_NAMESPACE, JOURNAL_NAME, locator);
}

writer make_writer(const std::string &runtime_dir) {
  return writer(kernel_location(runtime_dir), location::PUBLIC, std::make_shared<noop_publisher>(), false,
                std::make_shared<bus>(false));
}

class writer_guard {
public:
  explicit writer_guard(const std::string &path) : path_(path) {
#ifdef _WIN32
    handle_ = CreateFileA(path.c_str(), GENERIC_READ | GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr,
                          OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (handle_ == INVALID_HANDLE_VALUE) {
      throw std::runtime_error("fact_kernel_writer_guard_open_failed");
    }
    OVERLAPPED overlap{};
    if (!LockFileEx(handle_, LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY, 0, 1, 0, &overlap)) {
      CloseHandle(handle_);
      handle_ = INVALID_HANDLE_VALUE;
      throw std::runtime_error("fact_kernel_writer_busy");
    }
#else
    fd_ = ::open(path.c_str(), O_CREAT | O_RDWR | O_CLOEXEC, 0644);
    if (fd_ < 0) {
      throw std::runtime_error("fact_kernel_writer_guard_open_failed");
    }
    if (::flock(fd_, LOCK_EX | LOCK_NB) != 0) {
      ::close(fd_);
      fd_ = -1;
      throw std::runtime_error("fact_kernel_writer_busy");
    }
#endif
  }
  writer_guard(const writer_guard &) = delete;
  writer_guard &operator=(const writer_guard &) = delete;
  ~writer_guard() {
#ifdef _WIN32
    if (handle_ != INVALID_HANDLE_VALUE) {
      OVERLAPPED overlap{};
      UnlockFileEx(handle_, 0, 1, 0, &overlap);
      CloseHandle(handle_);
    }
#else
    if (fd_ >= 0) {
      ::flock(fd_, LOCK_UN);
      ::close(fd_);
    }
#endif
  }

private:
  std::string path_;
#ifdef _WIN32
  HANDLE handle_ = INVALID_HANDLE_VALUE;
#else
  int fd_ = -1;
#endif
};

std::string writer_lock_path(const std::string &runtime_dir) {
  const auto target = kernel_location(runtime_dir);
  return (fs::path(target->locator->layout_dir(target, layout::JOURNAL, true)) / "writer.lock").string();
}

struct kernel_authority_record {
  uint32_t tag = 0;
  uint64_t sequence = 0;
  std::string key;
  std::string record_root;
  nlohmann::json document = nlohmann::json::object();
  nlohmann::json receipt = nlohmann::json::object();
};

struct kernel_state {
  uint64_t next_sequence = 1;
  size_t unknown_records = 0;
  std::map<std::string, nlohmann::json> objects;
  std::map<std::string, nlohmann::json> versions;
  std::map<std::string, nlohmann::json> relations;
  std::set<std::string> revoked_relations;
  std::map<std::string, nlohmann::json> revocations;
  std::map<std::string, nlohmann::json> cuts;
  std::map<std::string, nlohmann::json> refs;
  std::map<std::string, nlohmann::json> transitions;
  std::map<std::string, nlohmann::json> receipts;
  std::vector<kernel_authority_record> authority_records;
};

template <typename T> bool decode_record(const frame_ptr &frame, T &value) {
  if (frame->data_length() < sizeof(T)) {
    return false;
  }
  value = frame->data<T>();
  return value.schema_version == SCHEMA_VERSION;
}

kernel_state fold_kernel(const std::string &runtime_dir) {
  kernel_state state;
  std::vector<kernel_authority_record> pending;
  std::set<uint64_t> accepted_sequences;
  const auto target = kernel_location(runtime_dir);
  if (target->locator->list_page_id(target, location::PUBLIC).empty()) {
    return state;
  }
  auto reader = std::make_shared<yy::journal::reader>(true, false, std::make_shared<bus>(false));
  reader->join(target, location::PUBLIC, 0);
  while (reader->data_available()) {
    const auto frame = reader->current_frame();
    uint64_t sequence = 0;
    try {
      switch (frame->carrier_type()) {
      case FactObjectRecorded::tag: {
        FactObjectRecorded record{};
        if (!decode_record(frame, record)) {
          ++state.unknown_records;
          break;
        }
        sequence = record.sequence;
        const auto root = fixed_string(record.object_root);
        pending.push_back({FactObjectRecorded::tag, sequence, fixed_string(record.object_id), root,
                           load_metadata(runtime_dir, root, "kungfu.fact.object/v1")});
        break;
      }
      case FactVersionRecorded::tag: {
        FactVersionRecorded record{};
        if (!decode_record(frame, record)) {
          ++state.unknown_records;
          break;
        }
        sequence = record.sequence;
        const auto root = fixed_string(record.version_root);
        pending.push_back({FactVersionRecorded::tag, sequence, root, root,
                           load_metadata(runtime_dir, root, "kungfu.fact.version/v1")});
        break;
      }
      case FactRelationAdded::tag: {
        FactRelationAdded record{};
        if (!decode_record(frame, record)) {
          ++state.unknown_records;
          break;
        }
        sequence = record.sequence;
        const auto root = fixed_string(record.relation_root);
        pending.push_back({FactRelationAdded::tag, sequence, root, root,
                           load_metadata(runtime_dir, root, "kungfu.fact.relation-add/v1")});
        break;
      }
      case FactRelationRevoked::tag: {
        FactRelationRevoked record{};
        if (!decode_record(frame, record)) {
          ++state.unknown_records;
          break;
        }
        sequence = record.sequence;
        const auto root = fixed_string(record.revoke_root);
        pending.push_back({FactRelationRevoked::tag, sequence, fixed_string(record.relation_root), root,
                           load_metadata(runtime_dir, root, "kungfu.fact.relation-revoke/v1")});
        break;
      }
      case FactCutCommitted::tag: {
        FactCutCommitted record{};
        if (!decode_record(frame, record)) {
          ++state.unknown_records;
          break;
        }
        sequence = record.sequence;
        const auto root = fixed_string(record.cut_root);
        pending.push_back(
            {FactCutCommitted::tag, sequence, root, root, load_metadata(runtime_dir, root, "kungfu.fact.cut/v1")});
        break;
      }
      case FactRefTransition::tag: {
        FactRefTransition record{};
        if (!decode_record(frame, record)) {
          ++state.unknown_records;
          break;
        }
        sequence = record.sequence;
        const auto root = fixed_string(record.transition_root);
        auto document = load_metadata(runtime_dir, root, "kungfu.fact.ref-transition/v1");
        document["transition_root"] = root;
        document["revision"] = record.expected_old_revision + 1;
        pending.push_back(
            {FactRefTransition::tag, sequence, fixed_string(record.transition_id), root, std::move(document)});
        break;
      }
      case FactOperationReceipt::tag: {
        FactOperationReceipt record{};
        if (!decode_record(frame, record)) {
          ++state.unknown_records;
          break;
        }
        sequence = record.sequence;
        auto receipt =
            load_metadata(runtime_dir, fixed_string(record.receipt_root), "kungfu.fact.operation-receipt/v1");
        receipt["requestRoot"] = fixed_string(record.request_root);
        receipt["receiptRoot"] = fixed_string(record.receipt_root);
        receipt["writeOccurred"] = record.write_occurred != 0;
        if (pending.empty() || pending.back().sequence + 1 != sequence ||
            pending.back().record_root != receipt.value("recordRoot", std::string{})) {
          ++state.unknown_records;
          break;
        }
        accepted_sequences.insert(pending.back().sequence);
        pending.back().receipt = receipt;
        state.receipts[fixed_string(record.operation_id)] = std::move(receipt);
        break;
      }
      case PageEnd::tag:
        break;
      default:
        ++state.unknown_records;
        break;
      }
    } catch (const std::exception &) {
      ++state.unknown_records;
    }
    state.next_sequence = std::max(state.next_sequence, sequence + 1);
    reader->next();
  }
  // Every authoritative record and its accepted receipt are one logical
  // append decision. A torn or mismatched pair remains diagnostic material.
  for (const auto &record : pending) {
    if (accepted_sequences.count(record.sequence) == 0) {
      ++state.unknown_records;
      continue;
    }
    state.authority_records.push_back(record);
    switch (record.tag) {
    case FactObjectRecorded::tag:
      state.objects[record.key] = record.document;
      break;
    case FactVersionRecorded::tag:
      state.versions[record.key] = record.document;
      break;
    case FactRelationAdded::tag:
      state.relations[record.key] = record.document;
      break;
    case FactRelationRevoked::tag:
      state.revoked_relations.insert(record.key);
      state.revocations[record.record_root] = record.document;
      break;
    case FactCutCommitted::tag:
      state.cuts[record.key] = record.document;
      break;
    case FactRefTransition::tag:
      state.refs[record.document.at("refName").get<std::string>()] = {
          {"ref_name", record.document.at("refName")},
          {"cut_root", record.document.at("newCutRoot")},
          {"revision", record.document.at("revision")},
          {"transition_id", record.document.at("transitionId")},
          {"transition_root", record.document.at("transition_root")}};
      state.transitions[record.key] = record.document;
      break;
    default:
      ++state.unknown_records;
      break;
    }
  }
  return state;
}

nlohmann::json failure(const std::string &action, const std::string &code, const std::string &message,
                       const nlohmann::json &details = nlohmann::json::object()) {
  return {{"schema", FACT_KERNEL_SCHEMA_V1},
          {"ok", false},
          {"action", action},
          {"status", "rejected"},
          {"failure_code", code},
          {"message", message},
          {"details", details},
          {"write_occurred", false},
          {"receipt", nullptr}};
}

std::string request_id(const std::string &request_root) {
  return "op:" + request_root.substr(std::string("sha256:").size(), 32);
}

template <typename T>
nlohmann::json append_record_with_receipt(const std::string &runtime_dir, kernel_state &state,
                                          const std::string &action, const std::string &operation_id,
                                          const std::string &request_root, const std::string &record_root,
                                          const nlohmann::json &result, T record) {
  record.schema_version = SCHEMA_VERSION;
  record.sequence = state.next_sequence++;
  auto receipt_document = nlohmann::json{{"schema", "kungfu.fact.operation-receipt/v1"},
                                         {"operationId", operation_id},
                                         {"operation", action},
                                         {"status", "accepted"},
                                         {"failureCode", nullptr},
                                         {"requestRoot", request_root},
                                         {"recordRoot", record_root},
                                         {"priorCutRoot", result.value("prior_cut_root", std::string{})},
                                         {"currentCutRoot", result.value("current_cut_root", std::string{})},
                                         {"priorRevision", result.value("prior_revision", uint64_t{0})},
                                         {"currentRevision", result.value("current_revision", uint64_t{0})},
                                         {"writeOccurred", true},
                                         {"result", result}};
  const auto receipt_root = store_metadata(runtime_dir, "kungfu.fact.operation-receipt/v1", receipt_document);
  FactOperationReceipt receipt{};
  receipt.schema_version = SCHEMA_VERSION;
  receipt.sequence = state.next_sequence++;
  receipt.write_occurred = 1;
  set_fixed(receipt.operation_id, operation_id, "operation_id");
  set_fixed(receipt.operation, action, "operation");
  set_fixed(receipt.status, "accepted", "status");
  set_fixed(receipt.record_root, record_root, "record_root");
  set_fixed(receipt.request_root, request_root, "request_root");
  set_fixed(receipt.receipt_root, receipt_root, "receipt_root");
  if (action == "ref-cas") {
    receipt.prior_revision = result.value("prior_revision", uint64_t{0});
    receipt.current_revision = result.value("current_revision", uint64_t{0});
    set_fixed(receipt.prior_cut_root, result.value("prior_cut_root", std::string{}), "prior_cut_root");
    set_fixed(receipt.current_cut_root, result.value("current_cut_root", std::string{}), "current_cut_root");
  }
  auto output = make_writer(runtime_dir);
  output.write_at(yy::time::now_in_nano(), 0, record);
  output.write_at(yy::time::now_in_nano(), 0, receipt);
  return {{"schema", FACT_KERNEL_SCHEMA_V1},
          {"ok", true},
          {"action", action},
          {"status", "accepted"},
          {"write_occurred", true},
          {"result", result},
          {"receipt", receipt_document},
          {"receipt_root", receipt_root}};
}

nlohmann::json capabilities_document() {
  return {{"schema", "kungfu.fact-kernel.capabilities/v1"},
          {"owner", "libkungfu"},
          {"authority", "yijinjing-hana-pod-journal"},
          {"root_protocol", ROOT_PROTOCOL},
          {"root_protocols",
           {{{"id", ROOT_PROTOCOL},
             {"status", "legacy-reader-internal-only"},
             {"writer_default", true},
             {"independently_implementable", false}},
            {{"id", PORTABLE_ROOT_PROTOCOL},
             {"status", "portable-independently-implemented"},
             {"writer_default", false},
             {"independently_implementable", true},
             {"conformance_implementations", 2}}}},
          {"content_namespaces", {{"metadata", METADATA_NAMESPACE}, {"bodies", BODY_NAMESPACE}}},
          {"actions",
           {"capabilities", "canonical-root", "object-put", "version-put", "relation-add", "relation-revoke", "cut-put",
            "ref-cas", "query", "authority-export", "authority-import"}},
          {"cas", {{"mode", "exact-expected-old-and-revision"}, {"stale_write", "no-journal-append"}}},
          {"query",
           {{"include_bodies", "opt-in-immutable-content"},
            {"include_inventory", "opt-in-authority-scan-for-integrity-and-portability"}}},
          {"projection_role", "rebuildable-edge-only"},
          {"clock_free_identity", true},
          {"product_vocabulary", false}};
}

nlohmann::json query_kernel(const std::string &runtime_dir, const kernel_state &state, const nlohmann::json &request) {
  const auto ref_name = text_or(request, "ref_name");
  const auto include_bodies = request.value("include_bodies", false);
  auto cut_root = text_or(request, "cut_root");
  nlohmann::json resolution = nullptr;
  if (!ref_name.empty()) {
    const auto found = state.refs.find(ref_name);
    if (found == state.refs.end()) {
      return failure("query", "unknown-cut", "Fact ref does not resolve to a known Cut", {{"ref_name", ref_name}});
    }
    resolution = found->second;
    cut_root = found->second.at("cut_root").get<std::string>();
  }
  if (cut_root.empty()) {
    auto result = nlohmann::json{{"schema", FACT_KERNEL_STATE_SCHEMA_V1},
                                 {"ok", true},
                                 {"authority", "yijinjing-hana-pod-journal"},
                                 {"counts",
                                  {{"objects", state.objects.size()},
                                   {"versions", state.versions.size()},
                                   {"relations", state.relations.size()},
                                   {"cuts", state.cuts.size()},
                                   {"refs", state.refs.size()},
                                   {"receipts", state.receipts.size()},
                                   {"unknown_records", state.unknown_records}}},
                                 {"refs", state.refs}};
    if (request.value("include_inventory", false)) {
      auto inventory =
          nlohmann::json{{"objects", state.objects},     {"versions", state.versions},
                         {"relations", state.relations}, {"revoked_relation_roots", state.revoked_relations},
                         {"cuts", state.cuts},           {"transitions", state.transitions},
                         {"receipts", state.receipts}};
      if (request.value("include_bodies", false)) {
        auto bodies = nlohmann::json::object();
        for (const auto &[version_root, version] : state.versions) {
          const auto body_root = version.value("bodyRoot", std::string{});
          try {
            bodies[version_root] = {{"body", content_store_get(runtime_dir, BODY_NAMESPACE, body_root)},
                                    {"body_root", body_root},
                                    {"status", "available"}};
          } catch (const std::exception &error) {
            bodies[version_root] = {
                {"body", nullptr}, {"body_root", body_root}, {"status", "missing"}, {"error", error.what()}};
          }
        }
        inventory["bodies"] = std::move(bodies);
      }
      result["inventory"] = std::move(inventory);
    }
    return result;
  }
  const auto found = state.cuts.find(cut_root);
  if (found == state.cuts.end()) {
    return failure("query", "unknown-cut", "Fact cut does not exist", {{"cut_root", cut_root}});
  }
  const auto &cut = found->second;
  auto objects = nlohmann::json::array();
  for (const auto &member : cut.at("objectVersions")) {
    const auto version_root = member.at(1).get<std::string>();
    const auto version = state.versions.find(version_root);
    auto projected = nlohmann::json{
        {"member", member}, {"version", version == state.versions.end() ? nlohmann::json(nullptr) : version->second}};
    if (include_bodies) {
      if (version == state.versions.end()) {
        projected["body"] = nullptr;
        projected["body_status"] = "version-missing";
      } else {
        try {
          projected["body"] =
              content_store_get(runtime_dir, BODY_NAMESPACE, version->second.at("bodyRoot").get<std::string>());
          projected["body_status"] = "present";
        } catch (const std::exception &error) {
          projected["body"] = nullptr;
          projected["body_status"] = "unavailable";
          projected["body_error"] = error.what();
        }
      }
    }
    objects.push_back(std::move(projected));
  }
  auto relations = nlohmann::json::array();
  for (const auto &root : cut.at("activeRelationRoots")) {
    const auto relation = state.relations.find(root.get<std::string>());
    relations.push_back({{"relation_root", root},
                         {"relation", relation == state.relations.end() ? nlohmann::json(nullptr) : relation->second}});
  }
  return {{"schema", FACT_KERNEL_STATE_SCHEMA_V1},
          {"ok", true},
          {"authority", "yijinjing-hana-pod-journal"},
          {"cut_root", cut_root},
          {"cut", cut},
          {"objects", std::move(objects)},
          {"relations", std::move(relations)},
          {"ref_resolution", resolution}};
}

nlohmann::json object_version_requests(const nlohmann::json &members) {
  auto result = nlohmann::json::array();
  for (const auto &member : members) {
    if (!member.is_array() || member.size() != 2) {
      throw std::runtime_error("fact authority bundle contains a malformed Cut member");
    }
    result.push_back({{"object_id", member.at(0)}, {"version_root", member.at(1)}});
  }
  return result;
}

nlohmann::json episode_frontier_requests(const nlohmann::json &frontier) {
  auto result = nlohmann::json::array();
  for (const auto &entry : frontier) {
    if (!entry.is_array() || entry.size() != 3) {
      throw std::runtime_error("fact authority bundle contains a malformed Episode frontier");
    }
    result.push_back({{"episode_id", entry.at(0)},
                      {"sealed_content_root", entry.at(1)},
                      {"accepted_manifest_frame_uid", entry.at(2)}});
  }
  return result;
}

nlohmann::json authority_operation_request(const std::string &runtime_dir, const kernel_authority_record &record) {
  const auto &document = record.document;
  if (record.tag == FactObjectRecorded::tag) {
    return {{"action", "object-put"},
            {"object_id", document.at("objectId")},
            {"object_type", document.at("objectType")},
            {"created_by_receipt_root", document.at("createdByReceiptRoot")}};
  }
  if (record.tag == FactVersionRecorded::tag) {
    return {{"action", "version-put"},
            {"object_id", document.at("objectId")},
            {"body", content_store_get(runtime_dir, BODY_NAMESPACE, document.at("bodyRoot").get<std::string>())},
            {"schema_root", document.at("schemaRoot")},
            {"parent_version_roots", document.at("parentVersionRoots")},
            {"declaration_roots", document.at("declarationRoots")},
            {"admission_roots", document.at("admissionRoots")}};
  }
  if (record.tag == FactRelationAdded::tag) {
    return {{"action", "relation-add"},
            {"relation_id", document.at("relationId")},
            {"relation_type", document.at("relationType")},
            {"source", document.at("source")},
            {"target", document.at("target")},
            {"attributes_root", document.at("attributesRoot")},
            {"admission_roots", document.at("admissionRoots")}};
  }
  if (record.tag == FactRelationRevoked::tag) {
    return {{"action", "relation-revoke"},
            {"relation_root", document.at("relationRoot")},
            {"reason_root", document.at("reasonRoot")}};
  }
  if (record.tag == FactCutCommitted::tag) {
    return {{"action", "cut-put"},
            {"parent_cut_roots", document.at("parentCutRoots")},
            {"object_versions", object_version_requests(document.at("objectVersions"))},
            {"active_relation_roots", document.at("activeRelationRoots")},
            {"declaration_roots", document.at("declarationRoots")},
            {"admission_roots", document.at("admissionRoots")},
            {"episode_frontier", episode_frontier_requests(document.at("episodeFrontier"))},
            {"omission_roots", document.at("omissionRoots")},
            {"conflict_roots", document.at("conflictRoots")}};
  }
  if (record.tag == FactRefTransition::tag) {
    const auto transition = load_metadata(runtime_dir, record.record_root, "kungfu.fact.ref-transition/v1");
    const auto expected_old = transition.at("expectedOldCutRoot").get<std::string>();
    return {{"action", "ref-cas"},
            {"transition_id", transition.at("transitionId")},
            {"ref_name", transition.at("refName")},
            {"expected_old_cut_root", expected_old.empty() ? nlohmann::json(nullptr) : nlohmann::json(expected_old)},
            {"expected_old_revision", transition.at("expectedOldRevision")},
            {"new_cut_root", transition.at("newCutRoot")},
            {"kind", transition.at("kind")},
            {"reason_root", transition.at("reasonRoot")}};
  }
  throw std::runtime_error("fact authority bundle encountered an unsupported journal record");
}

std::set<std::string> authority_record_roots(const kernel_state &state) {
  std::set<std::string> result;
  for (const auto &record : state.authority_records) {
    result.insert(record.record_root);
  }
  return result;
}

nlohmann::json authority_bundle(const std::string &runtime_dir, const kernel_state &state) {
  if (state.unknown_records != 0) {
    throw std::runtime_error("fact_authority_export_unknown_records");
  }
  if (state.authority_records.empty()) {
    throw std::runtime_error("fact_authority_export_empty");
  }
  auto operations = nlohmann::json::array();
  auto roots = nlohmann::json::array();
  for (const auto &record : state.authority_records) {
    if (!record.receipt.is_object() || record.receipt.value("recordRoot", std::string{}) != record.record_root) {
      throw std::runtime_error("fact_authority_export_receipt_mismatch");
    }
    operations.push_back({{"sequence", record.sequence},
                          {"action", record.receipt.at("operation")},
                          {"request", authority_operation_request(runtime_dir, record)},
                          {"recordRoot", record.record_root},
                          {"sourceReceiptRoot", record.receipt.at("receiptRoot")}});
    roots.push_back(record.record_root);
  }
  auto bundle = nlohmann::json{{"schema", "kungfu.fact-authority-bundle/v1"},
                               {"authority", "yijinjing-hana-pod-journal"},
                               {"rootProtocol", ROOT_PROTOCOL},
                               {"operations", std::move(operations)},
                               {"recordRoots", std::move(roots)},
                               {"finalState",
                                {{"refs", state.refs},
                                 {"counts",
                                  {{"objects", state.objects.size()},
                                   {"versions", state.versions.size()},
                                   {"relations", state.relations.size()},
                                   {"revocations", state.revocations.size()},
                                   {"cuts", state.cuts.size()},
                                   {"transitions", state.transitions.size()}}}}}};
  bundle["bundleRoot"] = content_root(canonical_json(bundle));
  return bundle;
}

std::string response_record_root(const std::string &action, const nlohmann::json &response) {
  if (!response.is_object() || !response.value("ok", false)) {
    return {};
  }
  const auto result = response.value("result", nlohmann::json::object());
  static const std::map<std::string, std::string> fields = {
      {"object-put", "object_root"},      {"version-put", "version_root"}, {"relation-add", "relation_root"},
      {"relation-revoke", "revoke_root"}, {"cut-put", "cut_root"},         {"ref-cas", "transition_root"}};
  const auto field = fields.find(action);
  return field == fields.end() ? std::string{} : result.value(field->second, std::string{});
}

} // namespace

nlohmann::json fact_kernel_capabilities() { return capabilities_document(); }

nlohmann::json run_fact_kernel_operation(const std::string &runtime_dir, const nlohmann::json &input) {
  const auto action = text_or(input, "action", "capabilities");
  try {
    reject_environment_identity(input);
    if (action == "capabilities") {
      return capabilities_document();
    }
    if (action == "canonical-root") {
      if (!input.contains("value")) {
        canonical_fail("canonical-invalid-descriptor", "canonical-root requires value");
      }
      const auto preimage = portable_root_preimage(input.at("value"));
      return {{"schema", "kungfu.fact-root-canonical.result/v2"},
              {"ok", true},
              {"action", action},
              {"protocol", PORTABLE_ROOT_PROTOCOL},
              {"canonical_bytes_hex", lower_hex(preimage)},
              {"root", content_root(preimage)},
              {"write_occurred", false}};
    }
    if (action == "query") {
      return query_kernel(runtime_dir, fold_kernel(runtime_dir), input);
    }
    if (action == "authority-export") {
      const auto bundle = authority_bundle(runtime_dir, fold_kernel(runtime_dir));
      return {{"schema", FACT_KERNEL_SCHEMA_V1},
              {"ok", true},
              {"action", action},
              {"status", "exported"},
              {"write_occurred", false},
              {"result", {{"bundle", bundle}, {"bundle_root", bundle.at("bundleRoot")}}},
              {"receipt", nullptr}};
    }
    if (action == "authority-import") {
      if (!input.contains("bundle") || !input.at("bundle").is_object()) {
        return failure(action, "bundle-invalid", "Fact authority bundle is required");
      }
      const auto &bundle = input.at("bundle");
      if (text_or(bundle, "schema") != "kungfu.fact-authority-bundle/v1" ||
          text_or(bundle, "authority") != "yijinjing-hana-pod-journal" ||
          text_or(bundle, "rootProtocol") != ROOT_PROTOCOL) {
        return failure(action, "bundle-invalid", "Fact authority bundle contract is unsupported");
      }
      const auto declared_bundle_root = required_text(bundle, "bundleRoot");
      validate_root(declared_bundle_root, "bundleRoot");
      auto root_material = bundle;
      root_material.erase("bundleRoot");
      const auto computed_bundle_root = content_root(canonical_json(root_material));
      if (computed_bundle_root != declared_bundle_root) {
        return failure(action, "bundle-root-mismatch", "Fact authority bundle root does not match its content",
                       {{"declared", declared_bundle_root}, {"computed", computed_bundle_root}});
      }
      const auto operations = array_or_empty(bundle, "operations");
      const auto record_roots = array_or_empty(bundle, "recordRoots");
      if (operations.empty() || operations.size() != record_roots.size()) {
        return failure(action, "bundle-invalid",
                       "Fact authority bundle operations and roots must be non-empty and aligned");
      }
      std::set<std::string> expected_roots;
      for (size_t index = 0; index < operations.size(); ++index) {
        const auto &operation = operations.at(index);
        if (!operation.is_object() || !operation.contains("request") || !operation.at("request").is_object()) {
          return failure(action, "bundle-invalid", "Fact authority bundle operation request is missing",
                         {{"index", index}});
        }
        const auto operation_action = required_text(operation, "action");
        const auto request_action = text_or(operation.at("request"), "action");
        const auto record_root = required_text(operation, "recordRoot");
        const auto source_receipt_root = required_text(operation, "sourceReceiptRoot");
        validate_root(record_root, "recordRoot");
        validate_root(source_receipt_root, "sourceReceiptRoot");
        if (operation_action != request_action || record_roots.at(index) != record_root ||
            operation_action == "authority-import" || operation_action == "authority-export" ||
            operation_action == "query" || operation_action == "capabilities" ||
            !expected_roots.insert(record_root).second) {
          return failure(action, "bundle-invalid", "Fact authority bundle operation is inconsistent",
                         {{"index", index}, {"operation", operation_action}});
        }
      }
      auto before = fold_kernel(runtime_dir);
      if (before.unknown_records != 0) {
        return failure(action, "destination-diverged", "Destination Fact journal contains unknown records",
                       {{"unknown_records", before.unknown_records}});
      }
      auto current_roots = authority_record_roots(before);
      if (!std::includes(expected_roots.begin(), expected_roots.end(), current_roots.begin(), current_roots.end())) {
        return failure(action, "destination-diverged", "Destination Fact authority is not a subset of the bundle");
      }

      // A valid bundle root authenticates only the supplied bytes. Replay the
      // complete bundle in an isolated runtime so a later invalid request can
      // never reject after earlier immutable destination records have landed.
      const auto preflight_root =
          fs::temp_directory_path() / ("kungfu-fact-authority-import-" + std::to_string(std::random_device{}()) + "-" +
                                       std::to_string(std::random_device{}()));
      nlohmann::json preflight_failure = nullptr;
      try {
        for (size_t index = 0; index < operations.size(); ++index) {
          const auto &operation = operations.at(index);
          const auto operation_action = operation.at("action").get<std::string>();
          const auto expected_root = operation.at("recordRoot").get<std::string>();
          const auto response = run_fact_kernel_operation(preflight_root.string(), operation.at("request"));
          const auto actual_root = response_record_root(operation_action, response);
          if (!response.value("ok", false) || actual_root != expected_root) {
            preflight_failure = failure(action, "import-preflight-operation-mismatch",
                                        "Fact authority bundle failed isolated replay before destination mutation",
                                        {{"index", index},
                                         {"operation", operation_action},
                                         {"expected_record_root", expected_root},
                                         {"actual_record_root", actual_root},
                                         {"kernel_response", response}});
            break;
          }
        }
        if (preflight_failure.is_null()) {
          const auto preflight_state = fold_kernel(preflight_root.string());
          const auto preflight_roots = authority_record_roots(preflight_state);
          const auto final_state = bundle.value("finalState", nlohmann::json::object());
          const auto expected_counts = final_state.value("counts", nlohmann::json::object());
          const auto actual_counts = nlohmann::json{
              {"objects", preflight_state.objects.size()},     {"versions", preflight_state.versions.size()},
              {"relations", preflight_state.relations.size()}, {"revocations", preflight_state.revocations.size()},
              {"cuts", preflight_state.cuts.size()},           {"transitions", preflight_state.transitions.size()}};
          if (preflight_roots != expected_roots ||
              nlohmann::json(preflight_state.refs) != final_state.value("refs", nlohmann::json::object()) ||
              actual_counts != expected_counts) {
            preflight_failure =
                failure(action, "import-preflight-final-state-mismatch",
                        "Fact authority bundle isolated replay did not reproduce its declared final state",
                        {{"expected_refs", final_state.value("refs", nlohmann::json::object())},
                         {"actual_refs", preflight_state.refs},
                         {"expected_counts", expected_counts},
                         {"actual_counts", actual_counts}});
          }
        }
        std::error_code cleanup_error;
        fs::remove_all(preflight_root, cleanup_error);
        if (cleanup_error) {
          throw std::runtime_error("fact authority import preflight cleanup failed");
        }
      } catch (...) {
        std::error_code cleanup_error;
        fs::remove_all(preflight_root, cleanup_error);
        throw;
      }
      if (!preflight_failure.is_null()) {
        return preflight_failure;
      }
      if (!input.value("execute", false)) {
        return {{"schema", FACT_KERNEL_SCHEMA_V1},
                {"ok", true},
                {"action", action},
                {"status", "planned"},
                {"write_occurred", false},
                {"result",
                 {{"bundle_root", declared_bundle_root},
                  {"operation_count", operations.size()},
                  {"already_present", current_roots.size()},
                  {"remaining", expected_roots.size() - current_roots.size()}}},
                {"receipt", nullptr}};
      }

      bool write_occurred = false;
      auto mappings = nlohmann::json::array();
      for (size_t index = 0; index < operations.size(); ++index) {
        const auto &operation = operations.at(index);
        const auto record_root = operation.at("recordRoot").get<std::string>();
        if (current_roots.count(record_root) != 0) {
          mappings.push_back({{"recordRoot", record_root},
                              {"sourceReceiptRoot", operation.at("sourceReceiptRoot")},
                              {"destinationReceiptRoot", nullptr},
                              {"status", "already-present"}});
          continue;
        }
        const auto operation_action = operation.at("action").get<std::string>();
        const auto response = run_fact_kernel_operation(runtime_dir, operation.at("request"));
        write_occurred = write_occurred || response.value("write_occurred", false);
        const auto actual_root = response_record_root(operation_action, response);
        if (!response.value("ok", false) || actual_root != record_root) {
          return {{"schema", FACT_KERNEL_SCHEMA_V1},
                  {"ok", false},
                  {"action", action},
                  {"status", "rejected"},
                  {"failure_code", "import-operation-mismatch"},
                  {"message", "Fact authority import did not reproduce the declared record root"},
                  {"details",
                   {{"index", index},
                    {"operation", operation_action},
                    {"expected_record_root", record_root},
                    {"actual_record_root", actual_root},
                    {"kernel_response", response}}},
                  {"write_occurred", write_occurred},
                  {"receipt", nullptr}};
        }
        current_roots.insert(record_root);
        mappings.push_back({{"recordRoot", record_root},
                            {"sourceReceiptRoot", operation.at("sourceReceiptRoot")},
                            {"destinationReceiptRoot", response.value("receipt_root", nlohmann::json(nullptr))},
                            {"status", response.at("status")}});
      }
      const auto after = fold_kernel(runtime_dir);
      const auto final_roots = authority_record_roots(after);
      const auto final_state = bundle.value("finalState", nlohmann::json::object());
      const auto expected_counts = final_state.value("counts", nlohmann::json::object());
      const auto actual_counts =
          nlohmann::json{{"objects", after.objects.size()},     {"versions", after.versions.size()},
                         {"relations", after.relations.size()}, {"revocations", after.revocations.size()},
                         {"cuts", after.cuts.size()},           {"transitions", after.transitions.size()}};
      if (final_roots != expected_roots ||
          nlohmann::json(after.refs) != final_state.value("refs", nlohmann::json::object()) ||
          actual_counts != expected_counts) {
        return {{"schema", FACT_KERNEL_SCHEMA_V1},
                {"ok", false},
                {"action", action},
                {"status", "rejected"},
                {"failure_code", "import-final-state-mismatch"},
                {"message", "Fact authority import did not reproduce the declared final refs and record roots"},
                {"details",
                 {{"expected_refs", final_state.value("refs", nlohmann::json::object())},
                  {"actual_refs", after.refs},
                  {"expected_counts", expected_counts},
                  {"actual_counts", actual_counts}}},
                {"write_occurred", write_occurred},
                {"receipt", nullptr}};
      }
      return {{"schema", FACT_KERNEL_SCHEMA_V1},
              {"ok", true},
              {"action", action},
              {"status", "imported"},
              {"write_occurred", write_occurred},
              {"result",
               {{"bundle_root", declared_bundle_root},
                {"record_roots_preserved", true},
                {"refs_preserved", true},
                {"receipt_mappings", std::move(mappings)}}},
              {"receipt", nullptr}};
    }

    const auto guard = writer_guard(writer_lock_path(runtime_dir));
    auto state = fold_kernel(runtime_dir);
    // Request identity is committed by the receipt. Rejected requests do not
    // materialize an orphan content-store object or append a journal frame.
    const auto request_root = metadata_root("fact-operation-request/v1", input);
    const auto operation_id = request_id(request_root);
    const auto replay = state.receipts.find(operation_id);
    if (replay != state.receipts.end()) {
      if (replay->second.value("requestRoot", std::string{}) != request_root) {
        return failure(action, "transition-id-reused", "operation_id was reused for different bytes",
                       {{"operation_id", operation_id}});
      }
      return {{"schema", FACT_KERNEL_SCHEMA_V1},
              {"ok", true},
              {"action", action},
              {"status", "idempotent-replay"},
              {"write_occurred", false},
              {"result", {{"record_root", replay->second.value("recordRoot", std::string{})}}},
              {"receipt", replay->second}};
    }

    if (action == "object-put") {
      const auto object_id = required_text(input, "object_id");
      validate_fact_id(object_id, "object_id");
      const auto object_type = required_text(input, "object_type");
      const auto created_by = required_text(input, "created_by_receipt_root");
      validate_root(created_by, "created_by_receipt_root");
      const nlohmann::json document = {{"schema", "kungfu.fact.object/v1"},
                                       {"objectId", object_id},
                                       {"objectType", object_type},
                                       {"createdByReceiptRoot", created_by}};
      const auto object_root = store_metadata(runtime_dir, "kungfu.fact.object/v1", document);
      const auto existing = state.objects.find(object_id);
      if (existing != state.objects.end()) {
        const auto existing_root = store_metadata(runtime_dir, "kungfu.fact.object/v1", existing->second);
        if (existing_root != object_root) {
          return failure(action, "invalid-identity", "object_id already names different immutable metadata",
                         {{"object_id", object_id}, {"existing_root", existing_root}, {"requested_root", object_root}});
        }
        return {{"schema", FACT_KERNEL_SCHEMA_V1},
                {"ok", true},
                {"action", action},
                {"status", "idempotent"},
                {"write_occurred", false},
                {"result", {{"object_id", object_id}, {"object_root", object_root}}},
                {"receipt", nullptr}};
      }
      FactObjectRecorded record{};
      set_fixed(record.object_id, object_id, "object_id");
      set_fixed(record.object_type, object_type, "object_type");
      set_fixed(record.created_by_receipt_root, created_by, "created_by_receipt_root");
      set_fixed(record.object_root, object_root, "object_root");
      return append_record_with_receipt(runtime_dir, state, action, operation_id, request_root, object_root,
                                        {{"object_id", object_id}, {"object_root", object_root}}, record);
    }

    if (action == "version-put") {
      const auto object_id = required_text(input, "object_id");
      validate_fact_id(object_id, "object_id");
      if (state.objects.count(object_id) == 0) {
        return failure(action, "unknown-object", "version object does not exist", {{"object_id", object_id}});
      }
      if (!input.contains("body") || !input.at("body").is_string()) {
        return failure(action, "body-missing", "body must be an opaque string");
      }
      const auto body = input.at("body").get<std::string>();
      const auto body_root = content_root(body);
      const auto schema_root = required_text(input, "schema_root");
      validate_root(schema_root, "schema_root");
      const auto parents = normalized_roots(input, "parent_version_roots");
      const auto declarations = normalized_roots(input, "declaration_roots");
      const auto admissions = normalized_roots(input, "admission_roots");
      if (declarations.empty() || admissions.empty()) {
        return failure(action, "admission-missing", "version requires exact declaration and admission support");
      }
      for (const auto &parent : parents) {
        if (state.versions.count(parent) == 0) {
          return failure(action, "unknown-version", "parent version is unavailable", {{"version_root", parent}});
        }
      }
      const auto stored = content_store_put_if_absent(runtime_dir, BODY_NAMESPACE, body, body_root);
      if (!stored.value("ok", false)) {
        throw std::runtime_error("fact body store failed");
      }
      const auto parents_root = store_root_set(runtime_dir, "fact-version-parents/v1", parents);
      const auto declarations_root = store_root_set(runtime_dir, "fact-declaration-roots/v1", declarations);
      const auto admissions_root = store_root_set(runtime_dir, "fact-admission-roots/v1", admissions);
      const nlohmann::json document = {{"schema", "kungfu.fact.version/v1"},
                                       {"objectId", object_id},
                                       {"bodyRoot", body_root},
                                       {"schemaRoot", schema_root},
                                       {"parentVersionRoots", root_array(parents)},
                                       {"declarationRoots", root_array(declarations)},
                                       {"admissionRoots", root_array(admissions)}};
      const auto version_root = store_metadata(runtime_dir, "kungfu.fact.version/v1", document);
      if (state.versions.count(version_root) != 0) {
        return {{"schema", FACT_KERNEL_SCHEMA_V1},
                {"ok", true},
                {"action", action},
                {"status", "idempotent"},
                {"write_occurred", false},
                {"result", {{"object_id", object_id}, {"version_root", version_root}, {"body_root", body_root}}},
                {"receipt", nullptr}};
      }
      FactVersionRecorded record{};
      set_fixed(record.object_id, object_id, "object_id");
      set_fixed(record.version_root, version_root, "version_root");
      set_fixed(record.body_root, body_root, "body_root");
      set_fixed(record.schema_root, schema_root, "schema_root");
      set_fixed(record.parent_versions_root, parents_root, "parent_versions_root");
      set_fixed(record.declaration_roots_root, declarations_root, "declaration_roots_root");
      set_fixed(record.admission_roots_root, admissions_root, "admission_roots_root");
      return append_record_with_receipt(
          runtime_dir, state, action, operation_id, request_root, version_root,
          {{"object_id", object_id}, {"version_root", version_root}, {"body_root", body_root}}, record);
    }

    if (action == "relation-add") {
      const auto relation_id = required_text(input, "relation_id");
      validate_fact_id(relation_id, "relation_id");
      const auto relation_type = required_text(input, "relation_type");
      if (!input.contains("source") || !input.at("source").is_object() || !input.contains("target") ||
          !input.at("target").is_object()) {
        throw std::invalid_argument("source and target endpoint objects are required");
      }
      const auto source_kind = required_text(input.at("source"), "kind");
      const auto source_id = required_text(input.at("source"), "id");
      const auto target_kind = required_text(input.at("target"), "kind");
      const auto target_id = required_text(input.at("target"), "id");
      const auto attributes_root = required_text(input, "attributes_root");
      validate_root(attributes_root, "attributes_root");
      const auto admissions = normalized_roots(input, "admission_roots");
      if (admissions.empty()) {
        return failure(action, "admission-missing", "relation requires exact admission support");
      }
      const auto endpoint_is_valid = [&state](const std::string &kind, const std::string &id,
                                              const nlohmann::json &endpoint) {
        if (kind == "logical-object") {
          return state.objects.count(id) != 0;
        }
        if (kind == "pinned-version") {
          return state.versions.count(id) != 0;
        }
        if (kind == "external-identity-with-mapping-receipt") {
          const auto mapping = text_or(endpoint, "mapping_receipt_root");
          try {
            validate_root(mapping, "mapping_receipt_root");
            return true;
          } catch (const std::invalid_argument &) {
            return false;
          }
        }
        return false;
      };
      if (!endpoint_is_valid(source_kind, source_id, input.at("source")) ||
          !endpoint_is_valid(target_kind, target_id, input.at("target"))) {
        return failure(action, "relation-endpoint-invalid", "relation endpoint is absent or not explicitly external");
      }
      const auto canonical_endpoint = [](const nlohmann::json &endpoint, const std::string &kind,
                                         const std::string &id) {
        const auto external = kind == "external-identity-with-mapping-receipt";
        const std::set<std::string> allowed = external ? std::set<std::string>{"kind", "id", "mapping_receipt_root"}
                                                       : std::set<std::string>{"kind", "id"};
        for (const auto &[key, unused] : endpoint.items()) {
          (void)unused;
          if (allowed.count(key) == 0) {
            throw std::invalid_argument("relation endpoint contains unknown field: " + key);
          }
        }
        auto result = nlohmann::json{{"kind", kind}, {"id", id}};
        if (external) {
          result["mapping_receipt_root"] = endpoint.at("mapping_receipt_root");
        }
        return result;
      };
      nlohmann::json source;
      nlohmann::json target;
      try {
        source = canonical_endpoint(input.at("source"), source_kind, source_id);
        target = canonical_endpoint(input.at("target"), target_kind, target_id);
      } catch (const std::invalid_argument &error) {
        return failure(action, "relation-endpoint-invalid", error.what());
      }
      const auto admissions_root = store_root_set(runtime_dir, "fact-admission-roots/v1", admissions);
      const nlohmann::json document = {{"schema", "kungfu.fact.relation-add/v1"},
                                       {"relationId", relation_id},
                                       {"relationType", relation_type},
                                       {"source", source},
                                       {"target", target},
                                       {"attributesRoot", attributes_root},
                                       {"admissionRoots", root_array(admissions)}};
      const auto relation_root = store_metadata(runtime_dir, "kungfu.fact.relation-add/v1", document);
      if (state.relations.count(relation_root) != 0) {
        return {{"schema", FACT_KERNEL_SCHEMA_V1},
                {"ok", true},
                {"action", action},
                {"status", "idempotent"},
                {"write_occurred", false},
                {"result", {{"relation_id", relation_id}, {"relation_root", relation_root}}},
                {"receipt", nullptr}};
      }
      for (const auto &[root, relation] : state.relations) {
        if (relation.value("relationId", std::string{}) == relation_id && root != relation_root) {
          return failure(action, "invalid-identity", "relation_id already names different immutable metadata");
        }
      }
      FactRelationAdded record{};
      set_fixed(record.relation_id, relation_id, "relation_id");
      set_fixed(record.relation_type, relation_type, "relation_type");
      set_fixed(record.source_kind, source_kind, "source.kind");
      set_fixed(record.source_id, source_id, "source.id");
      set_fixed(record.target_kind, target_kind, "target.kind");
      set_fixed(record.target_id, target_id, "target.id");
      set_fixed(record.attributes_root, attributes_root, "attributes_root");
      set_fixed(record.admission_roots_root, admissions_root, "admission_roots_root");
      set_fixed(record.relation_root, relation_root, "relation_root");
      return append_record_with_receipt(runtime_dir, state, action, operation_id, request_root, relation_root,
                                        {{"relation_id", relation_id}, {"relation_root", relation_root}}, record);
    }

    if (action == "relation-revoke") {
      const auto relation_root = required_text(input, "relation_root");
      const auto reason_root = required_text(input, "reason_root");
      validate_root(relation_root, "relation_root");
      validate_root(reason_root, "reason_root");
      if (state.relations.count(relation_root) == 0) {
        return failure(action, "unknown-relation", "relation root does not exist");
      }
      if (state.revoked_relations.count(relation_root) != 0) {
        return failure(action, "relation-already-revoked", "relation has already been revoked");
      }
      const nlohmann::json document = {
          {"schema", "kungfu.fact.relation-revoke/v1"}, {"relationRoot", relation_root}, {"reasonRoot", reason_root}};
      const auto revoke_root = store_metadata(runtime_dir, "kungfu.fact.relation-revoke/v1", document);
      FactRelationRevoked record{};
      set_fixed(record.relation_root, relation_root, "relation_root");
      set_fixed(record.reason_root, reason_root, "reason_root");
      set_fixed(record.revoke_root, revoke_root, "revoke_root");
      return append_record_with_receipt(runtime_dir, state, action, operation_id, request_root, revoke_root,
                                        {{"relation_root", relation_root}, {"revoke_root", revoke_root}}, record);
    }

    if (action == "cut-put") {
      const auto parents = normalized_roots(input, "parent_cut_roots");
      const auto relations = normalized_roots(input, "active_relation_roots");
      const auto declarations = normalized_roots(input, "declaration_roots");
      const auto admissions = normalized_roots(input, "admission_roots");
      const auto omissions = normalized_roots(input, "omission_roots");
      const auto conflicts = normalized_roots(input, "conflict_roots");
      auto input_object_versions = array_or_empty(input, "object_versions");
      std::sort(input_object_versions.begin(), input_object_versions.end(), [](const auto &left, const auto &right) {
        return std::pair(left.value("object_id", std::string{}), left.value("version_root", std::string{})) <
               std::pair(right.value("object_id", std::string{}), right.value("version_root", std::string{}));
      });
      std::set<std::string> object_ids;
      auto object_versions = nlohmann::json::array();
      for (const auto &member : input_object_versions) {
        const auto object_id = required_text(member, "object_id");
        const auto version_root = required_text(member, "version_root");
        validate_fact_id(object_id, "object_versions.object_id");
        validate_root(version_root, "object_versions.version_root");
        if (!object_ids.insert(object_id).second) {
          throw std::invalid_argument("object_versions contains duplicate object_id");
        }
        const auto version = state.versions.find(version_root);
        if (version == state.versions.end() || version->second.value("objectId", std::string{}) != object_id) {
          return failure(action, "unknown-version", "cut member version is not admitted for object",
                         {{"object_id", object_id}, {"version_root", version_root}});
        }
        object_versions.push_back({object_id, version_root});
      }
      for (const auto &root : relations) {
        if (state.relations.count(root) == 0 || state.revoked_relations.count(root) != 0) {
          return failure(action, "unknown-relation", "cut relation is missing or revoked", {{"relation_root", root}});
        }
      }
      const auto input_frontier = array_or_empty(input, "episode_frontier");
      std::vector<std::tuple<uint64_t, std::string, std::string>> frontier_entries;
      std::set<uint64_t> episode_ids;
      for (const auto &entry : input_frontier) {
        if (!entry.is_object() || !entry.contains("episode_id") ||
            !(entry.at("episode_id").is_number_unsigned() ||
              (entry.at("episode_id").is_number_integer() && entry.at("episode_id").get<int64_t>() >= 0))) {
          return failure(action, "invalid-cut", "episode_frontier.episode_id must be an unsigned 64-bit integer");
        }
        const auto episode_id = uint64_or(entry, "episode_id");
        const auto sealed_root = required_text(entry, "sealed_content_root");
        const auto manifest_uid = required_text(entry, "accepted_manifest_frame_uid");
        validate_root(sealed_root, "episode_frontier.sealed_content_root");
        if (!episode_ids.insert(episode_id).second) {
          return failure(action, "invalid-cut", "episode_frontier contains duplicate episode_id");
        }
        frontier_entries.emplace_back(episode_id, sealed_root, manifest_uid);
      }
      std::sort(frontier_entries.begin(), frontier_entries.end());
      auto frontier = nlohmann::json::array();
      for (const auto &[episode_id, sealed_root, manifest_uid] : frontier_entries) {
        frontier.push_back({episode_id, sealed_root, manifest_uid});
      }
      for (const auto &root : parents) {
        if (state.cuts.count(root) == 0) {
          return failure(action, "unknown-cut", "parent cut is unavailable", {{"parent_cut_root", root}});
        }
      }
      const nlohmann::json document = {{"schema", "kungfu.fact.cut/v1"},
                                       {"parentCutRoots", root_array(parents)},
                                       {"objectVersions", object_versions},
                                       {"activeRelationRoots", root_array(relations)},
                                       {"declarationRoots", root_array(declarations)},
                                       {"admissionRoots", root_array(admissions)},
                                       {"episodeFrontier", frontier},
                                       {"omissionRoots", root_array(omissions)},
                                       {"conflictRoots", root_array(conflicts)}};
      const auto cut_root = store_metadata(runtime_dir, "kungfu.fact.cut/v1", document);
      if (state.cuts.count(cut_root) != 0) {
        return {{"schema", FACT_KERNEL_SCHEMA_V1},
                {"ok", true},
                {"action", action},
                {"status", "idempotent"},
                {"write_occurred", false},
                {"result", {{"cut_root", cut_root}}},
                {"receipt", nullptr}};
      }
      FactCutCommitted record{};
      set_fixed(record.cut_root, cut_root, "cut_root");
      set_fixed(record.parent_cuts_root, store_root_set(runtime_dir, "fact-parent-cuts/v1", parents),
                "parent_cuts_root");
      set_fixed(record.object_versions_root, store_metadata(runtime_dir, "fact-object-versions/v1", object_versions),
                "object_versions_root");
      set_fixed(record.active_relations_root, store_root_set(runtime_dir, "fact-active-relations/v1", relations),
                "active_relations_root");
      set_fixed(record.declaration_roots_root, store_root_set(runtime_dir, "fact-declaration-roots/v1", declarations),
                "declaration_roots_root");
      set_fixed(record.admission_roots_root, store_root_set(runtime_dir, "fact-admission-roots/v1", admissions),
                "admission_roots_root");
      set_fixed(record.episode_frontier_root, store_metadata(runtime_dir, "fact-episode-frontier/v1", frontier),
                "episode_frontier_root");
      set_fixed(record.omission_roots_root, store_root_set(runtime_dir, "fact-omission-roots/v1", omissions),
                "omission_roots_root");
      set_fixed(record.conflict_roots_root, store_root_set(runtime_dir, "fact-conflict-roots/v1", conflicts),
                "conflict_roots_root");
      return append_record_with_receipt(runtime_dir, state, action, operation_id, request_root, cut_root,
                                        {{"cut_root", cut_root}}, record);
    }

    if (action == "ref-cas") {
      const auto transition_id = required_text(input, "transition_id");
      validate_transition_id(transition_id);
      const auto ref_name = required_text(input, "ref_name");
      validate_ref_name(ref_name);
      const auto has_expected_root =
          input.contains("expected_old_cut_root") &&
          (input.at("expected_old_cut_root").is_null() || input.at("expected_old_cut_root").is_string());
      const auto has_expected_revision =
          input.contains("expected_old_revision") && is_nonnegative_integer(input.at("expected_old_revision"));
      const auto expected_old = text_or(input, "expected_old_cut_root");
      validate_root(expected_old, "expected_old_cut_root", true);
      const auto expected_revision = uint64_or(input, "expected_old_revision");
      const auto new_cut = required_text(input, "new_cut_root");
      validate_root(new_cut, "new_cut_root");
      if (state.cuts.count(new_cut) == 0) {
        return failure(action, "unknown-cut", "new cut is not admitted", {{"new_cut_root", new_cut}});
      }
      const auto kind = required_text(input, "kind");
      static const std::set<std::string> kinds = {"create", "advance", "fork", "merge-view", "rollback"};
      if (kinds.count(kind) == 0) {
        throw std::invalid_argument("kind is not a supported ref transition");
      }
      const auto reason_root = required_text(input, "reason_root");
      validate_root(reason_root, "reason_root");
      const nlohmann::json document = {{"schema", "kungfu.fact.ref-transition/v1"},
                                       {"transitionId", transition_id},
                                       {"refName", ref_name},
                                       {"expectedOldCutRoot", expected_old},
                                       {"expectedOldRevision", expected_revision},
                                       {"newCutRoot", new_cut},
                                       {"kind", kind},
                                       {"reasonRoot", reason_root}};
      const auto transition_root = metadata_root("kungfu.fact.ref-transition/v1", document);
      const auto transition_replay = state.transitions.find(transition_id);
      if (transition_replay != state.transitions.end()) {
        if (transition_replay->second.at("transition_root").get<std::string>() != transition_root) {
          return failure(action, "transition-id-reused", "transition_id was reused for different bytes",
                         {{"transition_id", transition_id}});
        }
        return {{"schema", FACT_KERNEL_SCHEMA_V1},
                {"ok", true},
                {"action", action},
                {"status", "idempotent-replay"},
                {"write_occurred", false},
                {"result", transition_replay->second},
                {"receipt", nullptr}};
      }
      const auto current = state.refs.find(ref_name);
      const auto current_cut =
          current == state.refs.end() ? std::string{} : current->second.at("cut_root").get<std::string>();
      const auto current_revision =
          current == state.refs.end() ? uint64_t{0} : current->second.at("revision").get<uint64_t>();
      if (!has_expected_root || !has_expected_revision ||
          (current == state.refs.end() && (!input.at("expected_old_cut_root").is_null() || expected_revision != 0)) ||
          (current != state.refs.end() && input.at("expected_old_cut_root").is_null())) {
        return failure(action, "expected-old-required", "exact expected-old cut root and revision are required");
      }
      if (current_cut != expected_old || current_revision != expected_revision) {
        return failure(action, "stale-ref", "ref changed since expected-old was observed",
                       {{"ref_name", ref_name},
                        {"expected_old_cut_root", expected_old},
                        {"expected_old_revision", expected_revision},
                        {"current_cut_root", current_cut},
                        {"current_revision", current_revision}});
      }
      // Only accepted transitions materialize their canonical preimage.
      const auto stored_transition_root = store_metadata(runtime_dir, "kungfu.fact.ref-transition/v1", document);
      if (stored_transition_root != transition_root) {
        throw std::runtime_error("fact transition root changed during admission");
      }
      FactRefTransition record{};
      record.expected_old_revision = expected_revision;
      set_fixed(record.transition_id, transition_id, "transition_id");
      set_fixed(record.ref_name, ref_name, "ref_name");
      set_fixed(record.expected_old_cut_root, expected_old, "expected_old_cut_root");
      set_fixed(record.new_cut_root, new_cut, "new_cut_root");
      set_fixed(record.transition_kind, kind, "kind");
      set_fixed(record.reason_root, reason_root, "reason_root");
      set_fixed(record.transition_root, transition_root, "transition_root");
      auto result = nlohmann::json{{"transition_id", transition_id},
                                   {"transition_root", transition_root},
                                   {"ref_name", ref_name},
                                   {"prior_cut_root", current_cut},
                                   {"current_cut_root", new_cut},
                                   {"prior_revision", current_revision},
                                   {"current_revision", current_revision + 1}};
      auto response = append_record_with_receipt(runtime_dir, state, action, operation_id, request_root,
                                                 transition_root, result, record);
      return response;
    }

    return failure(action, "unsupported-version", "unsupported Fact kernel action");
  } catch (const canonical_encoding_error &error) {
    return failure(action, error.code(), error.what());
  } catch (const std::invalid_argument &error) {
    return failure(action, "invalid-identity", error.what());
  } catch (const std::exception &error) {
    return failure(action, "backend-failure", error.what());
  }
}

} // namespace kungfu::runtime::storage_service_api
