// SPDX-License-Identifier: Apache-2.0

#ifndef KUNGFU_RUNTIME_ACTION_ACTION_CANONICAL_JSON_H
#define KUNGFU_RUNTIME_ACTION_ACTION_CANONICAL_JSON_H

#include <cstdint>
#include <limits>
#include <stdexcept>
#include <string>

#include <nlohmann/json.hpp>

namespace kungfu::runtime::action {

inline constexpr auto ACTION_CANONICAL_JSON_V1 = "kungfu.action.canonical-json/v1";
inline constexpr int64_t CANONICAL_JSON_MAX_INTEGER = std::numeric_limits<int64_t>::max();

class canonical_json_error : public std::invalid_argument {
public:
  canonical_json_error(std::string code, const std::string &message)
      : std::invalid_argument(message), code_(std::move(code)) {}

  [[nodiscard]] const std::string &code() const noexcept { return code_; }

private:
  std::string code_;
};

// Native implementation of framework/work/action/action-canonical-json-v1.json.
// Only the closed interoperable JSON domain is admitted; every float and every
// integer outside signed 64-bit fails before identity-bearing bytes exist.
[[nodiscard]] std::string action_canonical_json(const nlohmann::json &value);

} // namespace kungfu::runtime::action

#endif // KUNGFU_RUNTIME_ACTION_ACTION_CANONICAL_JSON_H
