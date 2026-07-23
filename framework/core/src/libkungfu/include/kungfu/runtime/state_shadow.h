// SPDX-License-Identifier: Apache-2.0

#ifndef KUNGFU_RUNTIME_STATE_SHADOW_H
#define KUNGFU_RUNTIME_STATE_SHADOW_H

#include <cstdint>
#include <map>
#include <optional>
#include <string>

#include <nlohmann/json.hpp>

#include <kungfu/runtime/durability.h>

namespace kungfu::runtime::state_service {

enum class shadow_lane : uint8_t { Compatibility, Split };

struct shadow_report {
  uint64_t equal = 0;
  uint64_t missing_compatibility = 0;
  uint64_t missing_split = 0;
  uint64_t mismatched = 0;
  uint64_t duplicate_compatibility = 0;
  uint64_t duplicate_split = 0;

  [[nodiscard]] bool converged() const noexcept {
    return missing_compatibility == 0 && missing_split == 0 && mismatched == 0;
  }
};

// Compares compatibility and split-path state digests at the same logical cut.
// It is diagnostic only: equality never advances a durable watermark.
class shadow_comparator {
public:
  void observe(shadow_lane lane, const durability::stream_position &position, std::string state_digest);
  [[nodiscard]] shadow_report report() const noexcept;
  [[nodiscard]] nlohmann::json snapshot() const;
  [[nodiscard]] static shadow_comparator restore(const nlohmann::json &snapshot);

private:
  struct observation {
    durability::stream_position position = {};
    std::optional<std::string> compatibility = std::nullopt;
    std::optional<std::string> split = std::nullopt;
    uint64_t duplicate_compatibility = 0;
    uint64_t duplicate_split = 0;
  };

  [[nodiscard]] static std::string key(const durability::stream_position &position);
  std::map<std::string, observation> observations_ = {};
};

} // namespace kungfu::runtime::state_service

#endif // KUNGFU_RUNTIME_STATE_SHADOW_H
