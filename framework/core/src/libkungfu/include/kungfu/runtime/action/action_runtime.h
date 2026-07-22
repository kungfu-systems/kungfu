// SPDX-License-Identifier: Apache-2.0

#ifndef KUNGFU_RUNTIME_ACTION_ACTION_RUNTIME_H
#define KUNGFU_RUNTIME_ACTION_ACTION_RUNTIME_H

#include <string>

#include <nlohmann/json.hpp>

namespace kungfu::runtime::action {

inline constexpr const char *ACTION_RUNTIME_EDGE_SCHEMA_V1 = "kungfu.action-runtime.operation/v1";

// Storage-edge discovery document (schema, owner, actions[]). Distinct from the
// KFD-7 Profile capabilities document returned by the "capabilities" sub-action.
[[nodiscard]] nlohmann::json action_runtime_capabilities();

// Single JSON edge for Action Geometry + Domain Profile + Profile orchestration.
// Request must be an object with string "action"; remaining fields are
// action-specific. Mirrors fact_kernel: domain_dispatch only forwards here.
[[nodiscard]] nlohmann::json run_action_runtime_operation(const std::string &runtime_dir,
                                                          const nlohmann::json &request);

} // namespace kungfu::runtime::action

#endif // KUNGFU_RUNTIME_ACTION_ACTION_RUNTIME_H
