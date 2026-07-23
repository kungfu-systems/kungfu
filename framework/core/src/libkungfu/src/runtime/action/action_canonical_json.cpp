// SPDX-License-Identifier: Apache-2.0

#include <kungfu/runtime/action/action_canonical_json.h>

namespace kungfu::runtime::action {

std::string action_canonical_json(const nlohmann::json &value) {
  // indent = -1 emits the compact form with "," and ":" separators and no
  // whitespace; ensure_ascii = false emits non-ASCII as raw UTF-8; strict error
  // handling rejects invalid UTF-8 rather than substituting replacement bytes.
  return value.dump(-1, ' ', /*ensure_ascii=*/false, nlohmann::json::error_handler_t::strict);
}

} // namespace kungfu::runtime::action
