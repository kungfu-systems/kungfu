// SPDX-License-Identifier: Apache-2.0

#ifndef KUNGFU_YIJINJING_STORAGE_COMMON_H
#define KUNGFU_YIJINJING_STORAGE_COMMON_H

#include <cstdint>
#include <string>

#include <kungfu/longfist/core.h>

namespace kungfu::yijinjing::storage {

enum class payload_state : uint8_t { Present, Redacted, Absent, Missing };

enum class verification_status : uint8_t { Ok, Degraded, Failed };

enum class issue_severity : uint8_t { Info, Warning, Error };

enum class source_kind : uint8_t { Local, ImportedBundle, KungfuRuntime, Adapter };

enum class channel_request_kind : uint8_t { Fetch, Import, Export, Repair };

struct content_hash {
  std::string algorithm = "sha256";
  std::string value = {};

  [[nodiscard]] bool empty() const { return value.empty(); }
};

struct payload_ref {
  std::string content_type = {};
  content_hash hash = {};
  uint64_t byte_length = 0;
  payload_state state = payload_state::Missing;

  [[nodiscard]] bool is_present() const { return state == payload_state::Present; }

  [[nodiscard]] bool is_verifiable() const { return is_present() && !hash.empty(); }
};

struct location_ref {
  uint32_t uid = 0;
  longfist::enums::mode mode = longfist::enums::mode::LIVE;
  longfist::enums::location_role role = longfist::enums::location_role::SYSTEM;
  std::string group = {};
  std::string name = {};
};

struct event_range {
  uint64_t first_frame_uid = 0;
  uint64_t last_frame_uid = 0;
  int64_t since = 0;
  int64_t until = 0;
  std::string cursor = {};

  [[nodiscard]] bool has_frame_bounds() const { return first_frame_uid != 0 || last_frame_uid != 0; }

  [[nodiscard]] bool has_time_bounds() const { return since != 0 || until != 0; }
};

} // namespace kungfu::yijinjing::storage

#endif // KUNGFU_YIJINJING_STORAGE_COMMON_H
