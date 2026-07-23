// SPDX-License-Identifier: Apache-2.0

#ifndef KUNGFU_RUNTIME_ACTION_ACTION_CANONICAL_JSON_H
#define KUNGFU_RUNTIME_ACTION_ACTION_CANONICAL_JSON_H

#include <string>

#include <nlohmann/json.hpp>

namespace kungfu::runtime::action {

// Byte-for-byte equivalent of the Python authority's canonical serialization
//   json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
// used for role-body version-put bodies, receipts, and geometry/profile output.
//
// nlohmann::json stores object members in a std::map ordered by UTF-8 byte
// value, which equals Python's sort_keys (Unicode code-point order) for the
// KFD-7 corpora; the compact separators and ensure_ascii=false raw UTF-8 output
// match json.dumps. This equivalence was validated byte-for-byte across the
// stage-2 canonical-json probe corpus before it became an authority path.
[[nodiscard]] std::string action_canonical_json(const nlohmann::json &value);

} // namespace kungfu::runtime::action

#endif // KUNGFU_RUNTIME_ACTION_ACTION_CANONICAL_JSON_H
