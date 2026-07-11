// SPDX-License-Identifier: Apache-2.0

#ifndef KUNGFU_VIEW_ACTION_ENVELOPE_H
#define KUNGFU_VIEW_ACTION_ENVELOPE_H

#include <cstddef>
#include <cstdint>
#include <optional>
#include <string>
#include <vector>

namespace kungfu::view::action {

inline constexpr uint16_t ACTION_ENVELOPE_VERSION = 1;
inline constexpr int32_t ACTION_ENVELOPE_CARRIER_TYPE = 1000;
inline constexpr const char *ACTION_ENVELOPE_SCHEMA = "kungfu.action-envelope/v1";

enum class payload_encoding : uint8_t { None = 0, FlatBuffers = 1, Json = 2, ContentReference = 3, Opaque = 4 };

struct schema_ref {
  std::string id = {};
  uint32_t version = 1;
};

struct actor_metadata {
  std::string id = {};
  std::string kind = {};
  std::string storage_source_id = {};
  std::string source_type = {};
};

struct session_metadata {
  std::string run_id = {};
  std::string import_id = {};
};

struct source_metadata {
  std::string kind = {};
  std::string source_id = {};
  std::string source_path = {};
  std::string source_time = {};
  uint32_t schema_version = 0;
};

struct batch_metadata {
  std::string repo_root = {};
  std::string repo_head = {};
  uint32_t schema_version = 0;
  uint64_t missions = 0;
  uint64_t goals = 0;
  uint64_t markers = 0;
  uint64_t warnings = 0;
};

struct journal_metadata {
  uint64_t frame_uid = 0;
  uint64_t trigger_frame_uid = 0;
  uint64_t stream_id = 0;
  int64_t gen_time = 0;
  int64_t trigger_time = 0;
  int32_t carrier_type = ACTION_ENVELOPE_CARRIER_TYPE;
  uint32_t source = 0;
  uint32_t initial_source = 0;
  uint32_t dest = 0;
  uint32_t data_length = 0;
  int8_t data_type = 0;
  uint32_t integrity_version = 0;
  std::string checksum_algorithm = {};
  uint64_t payload_checksum = 0;
  uint64_t frame_checksum = 0;
};

struct payload_view {
  payload_encoding encoding = payload_encoding::None;
  std::vector<uint8_t> data = {};
  std::string hash_algorithm = {};
  std::string hash = {};
  uint64_t byte_len = 0;
  std::string content_type = {};
  std::string state = {};
};

struct envelope {
  uint16_t version = ACTION_ENVELOPE_VERSION;
  std::string action_type = {};
  schema_ref schema_ref = {};
  std::optional<actor_metadata> actor = {};
  std::optional<session_metadata> session = {};
  std::optional<source_metadata> source = {};
  std::optional<batch_metadata> batch = {};
  std::optional<journal_metadata> journal = {};
  std::optional<payload_view> payload = {};
};

// The implementation is the sole raw FlatBuffers access point. Decode verifies
// the whole untrusted buffer, file identifier, required fields, payload length,
// and a declared sha256 before returning any owned values.
[[nodiscard]] std::vector<uint8_t> encode(const envelope &value);

[[nodiscard]] std::optional<envelope> decode(const uint8_t *data, size_t size, std::string *error = nullptr);

[[nodiscard]] inline std::optional<envelope> decode(const std::vector<uint8_t> &data, std::string *error = nullptr) {
  return decode(data.data(), data.size(), error);
}

} // namespace kungfu::view::action

#endif // KUNGFU_VIEW_ACTION_ENVELOPE_H
