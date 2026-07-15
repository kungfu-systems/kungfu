// SPDX-License-Identifier: Apache-2.0

#include "service_internal.h"

#include <array>
#include <charconv>
#include <stdexcept>
#include <string>

namespace kungfu::runtime::storage_service_api {

namespace yy_storage = kungfu::yijinjing::storage;
namespace yy_enums = kungfu::yijinjing::enums;

namespace detail {

// ADR-0053: frame bytes cross the JSON edge as base64. The codec lives here
// because the edge is the only place binary material meets JSON.
inline constexpr const char *BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

std::string base64_encode(const std::string &raw) {
  std::string encoded;
  encoded.reserve((raw.size() + 2) / 3 * 4);
  size_t index = 0;
  while (index + 3 <= raw.size()) {
    const uint32_t chunk = (static_cast<uint8_t>(raw[index]) << 16u) | (static_cast<uint8_t>(raw[index + 1]) << 8u) |
                           static_cast<uint8_t>(raw[index + 2]);
    encoded.push_back(BASE64_ALPHABET[(chunk >> 18u) & 0x3Fu]);
    encoded.push_back(BASE64_ALPHABET[(chunk >> 12u) & 0x3Fu]);
    encoded.push_back(BASE64_ALPHABET[(chunk >> 6u) & 0x3Fu]);
    encoded.push_back(BASE64_ALPHABET[chunk & 0x3Fu]);
    index += 3;
  }
  const auto remaining = raw.size() - index;
  if (remaining == 1) {
    const uint32_t chunk = static_cast<uint8_t>(raw[index]) << 16u;
    encoded.push_back(BASE64_ALPHABET[(chunk >> 18u) & 0x3Fu]);
    encoded.push_back(BASE64_ALPHABET[(chunk >> 12u) & 0x3Fu]);
    encoded.push_back('=');
    encoded.push_back('=');
  } else if (remaining == 2) {
    const uint32_t chunk = (static_cast<uint8_t>(raw[index]) << 16u) | (static_cast<uint8_t>(raw[index + 1]) << 8u);
    encoded.push_back(BASE64_ALPHABET[(chunk >> 18u) & 0x3Fu]);
    encoded.push_back(BASE64_ALPHABET[(chunk >> 12u) & 0x3Fu]);
    encoded.push_back(BASE64_ALPHABET[(chunk >> 6u) & 0x3Fu]);
    encoded.push_back('=');
  }
  return encoded;
}

std::string base64_decode(const std::string &encoded) {
  static const auto reverse = [] {
    std::array<int8_t, 256> table{};
    table.fill(-1);
    for (int i = 0; i < 64; ++i) {
      table[static_cast<uint8_t>(BASE64_ALPHABET[i])] = static_cast<int8_t>(i);
    }
    return table;
  }();
  if (encoded.size() % 4 != 0) {
    throw std::invalid_argument("base64 payload length must be a multiple of 4");
  }
  std::string raw;
  raw.reserve(encoded.size() / 4 * 3);
  for (size_t index = 0; index < encoded.size(); index += 4) {
    uint32_t chunk = 0;
    int padding = 0;
    for (size_t offset = 0; offset < 4; ++offset) {
      const auto symbol = static_cast<uint8_t>(encoded[index + offset]);
      if (symbol == '=') {
        if (index + 4 != encoded.size() || offset < 2) {
          throw std::invalid_argument("base64 padding is malformed");
        }
        ++padding;
        chunk <<= 6u;
        continue;
      }
      if (padding > 0 || reverse[symbol] < 0) {
        throw std::invalid_argument("base64 payload contains an invalid symbol");
      }
      chunk = (chunk << 6u) | static_cast<uint32_t>(reverse[symbol]);
    }
    raw.push_back(static_cast<char>((chunk >> 16u) & 0xFFu));
    if (padding < 2) {
      raw.push_back(static_cast<char>((chunk >> 8u) & 0xFFu));
    }
    if (padding < 1) {
      raw.push_back(static_cast<char>(chunk & 0xFFu));
    }
  }
  return raw;
}

const char *source_kind_text(yy_enums::SourceKind kind) {
  switch (kind) {
  case yy_enums::SourceKind::Local:
    return "local";
  case yy_enums::SourceKind::ImportedBundle:
    return "imported_bundle";
  case yy_enums::SourceKind::KungfuRuntime:
    return "kungfu_runtime";
  case yy_enums::SourceKind::Adapter:
    return "adapter";
  }
  return "unknown";
}

const char *payload_state_text(yy_enums::PayloadState state) {
  switch (state) {
  case yy_enums::PayloadState::Present:
    return PAYLOAD_STATE_PRESENT;
  case yy_enums::PayloadState::Redacted:
    return PAYLOAD_STATE_REDACTED;
  case yy_enums::PayloadState::Absent:
    return PAYLOAD_STATE_ABSENT;
  case yy_enums::PayloadState::Missing:
    return "missing";
  }
  return "missing";
}
std::string text_or(const nlohmann::json &object, const std::string &field, const std::string &fallback) {
  if (!object.is_object() || !object.contains(field)) {
    return fallback;
  }
  const auto &value = object.at(field);
  if (value.is_string()) {
    return value.get<std::string>();
  }
  if (value.is_null()) {
    return fallback;
  }
  return value.dump(-1, ' ', false);
}

std::string required_text(const nlohmann::json &object, const std::string &field) {
  const auto value = text_or(object, field);
  if (value.empty()) {
    throw std::invalid_argument(field + " is required");
  }
  return value;
}

nlohmann::json object_or_empty(const nlohmann::json &object, const std::string &field);
nlohmann::json array_or_empty(const nlohmann::json &object, const std::string &field);

bool managed_json_type_matches(const nlohmann::json &value, const std::string &type) {
  if (type == "object")
    return value.is_object();
  if (type == "array")
    return value.is_array();
  if (type == "string")
    return value.is_string();
  if (type == "boolean")
    return value.is_boolean();
  if (type == "integer")
    return value.is_number_integer() || value.is_number_unsigned();
  if (type == "number")
    return value.is_number();
  if (type == "null")
    return value.is_null();
  return false;
}

void validate_managed_json_value(const nlohmann::json &schema, const nlohmann::json &value, const std::string &path) {
  const auto type = text_or(schema, "type");
  if (type.empty() || !managed_json_type_matches(value, type)) {
    throw std::invalid_argument("fact payload schema validation failed at " + path + ": expected " +
                                (type.empty() ? "declared type" : type));
  }
  if (type == "object") {
    const auto properties = object_or_empty(schema, "properties");
    for (const auto &required : array_or_empty(schema, "required")) {
      if (!required.is_string() || !value.contains(required.get<std::string>())) {
        throw std::invalid_argument("fact payload schema validation failed at " + path + ": missing required " +
                                    (required.is_string() ? required.get<std::string>() : std::string("field")));
      }
    }
    for (auto iter = value.begin(); iter != value.end(); ++iter) {
      if (!properties.contains(iter.key())) {
        if (schema.value("additionalProperties", true) == false) {
          throw std::invalid_argument("fact payload schema validation failed at " + path + ": unexpected " +
                                      iter.key());
        }
        continue;
      }
      validate_managed_json_value(properties.at(iter.key()), iter.value(), path + "." + iter.key());
    }
  } else if (type == "array" && schema.contains("items") && schema.at("items").is_object()) {
    for (size_t index = 0; index < value.size(); ++index) {
      validate_managed_json_value(schema.at("items"), value.at(index), path + "[" + std::to_string(index) + "]");
    }
  }
}

bool bool_or(const nlohmann::json &object, const std::string &field, bool fallback) {
  if (!object.is_object() || !object.contains(field)) {
    return fallback;
  }
  const auto &value = object.at(field);
  return value.is_boolean() ? value.get<bool>() : fallback;
}

nlohmann::json object_or_empty(const nlohmann::json &object, const std::string &field) {
  if (!object.is_object() || !object.contains(field) || !object.at(field).is_object()) {
    return nlohmann::json::object();
  }
  return object.at(field);
}

nlohmann::json array_or_empty(const nlohmann::json &object, const std::string &field) {
  if (!object.is_object() || !object.contains(field) || !object.at(field).is_array()) {
    return nlohmann::json::array();
  }
  return object.at(field);
}

std::string canonical_json(const nlohmann::json &value) { return value.dump(-1, ' ', false); }

uint64_t uint64_or(const nlohmann::json &object, const std::string &field, uint64_t fallback) {
  if (!object.is_object() || !object.contains(field)) {
    return fallback;
  }
  const auto &value = object.at(field);
  if (value.is_number_unsigned()) {
    return value.get<uint64_t>();
  }
  if (value.is_number_integer()) {
    return static_cast<uint64_t>(value.get<int64_t>());
  }
  if (value.is_string()) {
    const auto text = value.get<std::string>();
    uint64_t parsed = 0;
    const auto *begin = text.data();
    const auto *end = begin + text.size();
    const auto [ptr, error] = std::from_chars(begin, end, parsed);
    if (error == std::errc{} && ptr == end) {
      return parsed;
    }
  }
  return fallback;
}

int64_t int64_or(const nlohmann::json &object, const std::string &field, int64_t fallback) {
  if (!object.is_object() || !object.contains(field)) {
    return fallback;
  }
  const auto &value = object.at(field);
  if (value.is_number_integer()) {
    return value.get<int64_t>();
  }
  if (value.is_number_unsigned()) {
    return static_cast<int64_t>(value.get<uint64_t>());
  }
  return fallback;
}

uint32_t uint32_or(const nlohmann::json &object, const std::string &field, uint32_t fallback) {
  return static_cast<uint32_t>(uint64_or(object, field, fallback));
}

int32_t int32_or(const nlohmann::json &object, const std::string &field, int32_t fallback) {
  return static_cast<int32_t>(int64_or(object, field, fallback));
}

yy_enums::EpisodeStatus episode_status_or(const nlohmann::json &object, const std::string &field,
                                          yy_enums::EpisodeStatus fallback) {
  const auto value = text_or(object, field);
  if (value.empty() || value == "ended" || value == "end" || value == "Ended") {
    return fallback;
  }
  if (value == "aborted" || value == "abort" || value == "Aborted") {
    return yy_enums::EpisodeStatus::Aborted;
  }
  if (value == "tombstoned" || value == "tombstone" || value == "Tombstoned") {
    return yy_enums::EpisodeStatus::Tombstoned;
  }
  if (value == "open" || value == "Open") {
    return yy_enums::EpisodeStatus::Open;
  }
  return fallback;
}

yy_enums::EpisodeRefKind episode_ref_kind_or(const nlohmann::json &object, const std::string &field,
                                             yy_enums::EpisodeRefKind fallback) {
  const auto value = text_or(object, field);
  if (value.empty() || value == "input_frame" || value == "input" || value == "InputFrame") {
    return fallback;
  }
  if (value == "payload" || value == "Payload") {
    return yy_enums::EpisodeRefKind::Payload;
  }
  if (value == "schema" || value == "Schema") {
    return yy_enums::EpisodeRefKind::Schema;
  }
  if (value == "episode" || value == "Episode") {
    return yy_enums::EpisodeRefKind::Episode;
  }
  return fallback;
}

yy_storage::episode_begin_options parse_episode_begin_options(const nlohmann::json &value) {
  yy_storage::episode_begin_options parsed{};
  parsed.episode_id = uint64_or(value, "episode_id");
  parsed.parent_episode_id = uint64_or(value, "parent_episode_id");
  parsed.root_trigger_frame_uid = uint64_or(value, "root_trigger_frame_uid");
  parsed.location_uid = uint32_or(value, "location_uid");
  parsed.begin_time = int64_or(value, "begin_time");
  parsed.title = text_or(value, "title");
  parsed.actor = text_or(value, "actor");
  parsed.source = text_or(value, "source");
  return parsed;
}

yy_storage::episode_heartbeat_options parse_episode_heartbeat_options(const nlohmann::json &value) {
  yy_storage::episode_heartbeat_options parsed{};
  parsed.episode_id = uint64_or(value, "episode_id");
  parsed.location_uid = uint32_or(value, "location_uid");
  parsed.update_time = int64_or(value, "update_time");
  parsed.last_frame_uid = uint64_or(value, "last_frame_uid");
  parsed.frame_count = uint64_or(value, "frame_count");
  parsed.note = text_or(value, "note");
  return parsed;
}

yy_storage::episode_close_options parse_episode_close_options(const nlohmann::json &value,
                                                              yy_enums::EpisodeStatus fallback_status) {
  yy_storage::episode_close_options parsed{};
  parsed.episode_id = uint64_or(value, "episode_id");
  parsed.location_uid = uint32_or(value, "location_uid");
  parsed.status = episode_status_or(value, "status", fallback_status);
  parsed.end_time = int64_or(value, "end_time");
  parsed.last_frame_uid = uint64_or(value, "last_frame_uid");
  parsed.frame_count = uint64_or(value, "frame_count");
  parsed.reason = text_or(value, "reason");
  return parsed;
}

yy_storage::episode_frame_attach_options parse_episode_frame_attach_options(const nlohmann::json &value) {
  yy_storage::episode_frame_attach_options parsed{};
  parsed.episode_id = uint64_or(value, "episode_id");
  parsed.location_uid = uint32_or(value, "location_uid");
  parsed.frame_uid = uint64_or(value, "frame_uid");
  parsed.trigger_frame_uid = uint64_or(value, "trigger_frame_uid");
  parsed.stream_id = uint64_or(value, "stream_id");
  parsed.gen_time = int64_or(value, "gen_time");
  parsed.trigger_time = int64_or(value, "trigger_time");
  parsed.carrier_type = int32_or(value, "carrier_type");
  parsed.source = uint32_or(value, "source");
  parsed.dest = uint32_or(value, "dest");
  parsed.data_length = uint32_or(value, "data_length");
  parsed.integrity_version = uint32_or(value, "integrity_version");
  parsed.payload_checksum = uint64_or(value, "payload_checksum");
  parsed.frame_checksum = uint64_or(value, "frame_checksum");
  return parsed;
}

yy_storage::episode_ref_attach_options parse_episode_ref_attach_options(const nlohmann::json &value) {
  yy_storage::episode_ref_attach_options parsed{};
  parsed.episode_id = uint64_or(value, "episode_id");
  parsed.location_uid = uint32_or(value, "location_uid");
  parsed.ref_kind = episode_ref_kind_or(value, "ref_kind", yy_enums::EpisodeRefKind::InputFrame);
  parsed.ref_uid = uint64_or(value, "ref_uid");
  parsed.update_time = int64_or(value, "update_time");
  parsed.ref_id = text_or(value, "ref_id");
  parsed.ref_hash = text_or(value, "ref_hash");
  return parsed;
}

yy_storage::episode_recover_options parse_episode_recover_options(const nlohmann::json &value) {
  yy_storage::episode_recover_options parsed{};
  parsed.episode_id = uint64_or(value, "episode_id");
  parsed.location_uid = uint32_or(value, "location_uid");
  parsed.end_time = int64_or(value, "end_time");
  parsed.reason = text_or(value, "reason");
  return parsed;
}

yy_enums::SourceKind source_kind_or(const nlohmann::json &object, const std::string &field,
                                    yy_enums::SourceKind fallback) {
  const auto value = text_or(object, field);
  if (value == "imported_bundle" || value == "ImportedBundle") {
    return yy_enums::SourceKind::ImportedBundle;
  }
  if (value == "kungfu_runtime" || value == "KungfuRuntime") {
    return yy_enums::SourceKind::KungfuRuntime;
  }
  if (value == "adapter" || value == "Adapter") {
    return yy_enums::SourceKind::Adapter;
  }
  if (value == "local" || value == "Local") {
    return yy_enums::SourceKind::Local;
  }
  return fallback;
}

yy_enums::SourceVerificationStatus source_verification_status_or(const nlohmann::json &object, const std::string &field,
                                                                 yy_enums::SourceVerificationStatus fallback) {
  const auto value = text_or(object, field);
  if (value == "degraded" || value == "Degraded") {
    return yy_enums::SourceVerificationStatus::Degraded;
  }
  if (value == "failed" || value == "Failed") {
    return yy_enums::SourceVerificationStatus::Failed;
  }
  if (value == "ok" || value == "Ok") {
    return yy_enums::SourceVerificationStatus::Ok;
  }
  return fallback;
}

yy_storage::source_register_options parse_source_register_options(const nlohmann::json &value) {
  yy_storage::source_register_options parsed{};
  parsed.source_id = text_or(value, "source_id");
  parsed.kind = source_kind_or(value, "kind", yy_enums::SourceKind::Local);
  parsed.coordinate = text_or(value, "coordinate");
  parsed.head = text_or(value, "head");
  parsed.location_uid = uint32_or(value, "location_uid");
  parsed.register_time = int64_or(value, "register_time");
  return parsed;
}

yy_storage::source_head_update_options parse_source_head_update_options(const nlohmann::json &value) {
  yy_storage::source_head_update_options parsed{};
  parsed.source_id = text_or(value, "source_id");
  parsed.location_uid = uint32_or(value, "location_uid");
  parsed.update_time = int64_or(value, "update_time");
  parsed.first_frame_uid = uint64_or(value, "first_frame_uid");
  parsed.last_frame_uid = uint64_or(value, "last_frame_uid");
  parsed.since = int64_or(value, "since");
  parsed.until = int64_or(value, "until");
  parsed.head = text_or(value, "head");
  parsed.inventory_hash_algo = text_or(value, "inventory_hash_algo");
  parsed.inventory_hash = text_or(value, "inventory_hash");
  return parsed;
}

yy_storage::accepted_range_options parse_accepted_range_options(const nlohmann::json &value) {
  yy_storage::accepted_range_options parsed{};
  parsed.source_id = text_or(value, "source_id");
  parsed.manifest_id = text_or(value, "manifest_id");
  parsed.location_uid = uint32_or(value, "location_uid");
  parsed.accept_time = int64_or(value, "accept_time");
  parsed.first_frame_uid = uint64_or(value, "first_frame_uid");
  parsed.last_frame_uid = uint64_or(value, "last_frame_uid");
  parsed.since = int64_or(value, "since");
  parsed.until = int64_or(value, "until");
  parsed.status = source_verification_status_or(value, "status", yy_enums::SourceVerificationStatus::Ok);
  return parsed;
}

} // namespace detail

} // namespace kungfu::runtime::storage_service_api
