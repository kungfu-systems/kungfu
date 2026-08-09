// SPDX-License-Identifier: Apache-2.0

#ifndef KUNGFU_RUNTIME_ACTION_PROFILE_ACTION_H
#define KUNGFU_RUNTIME_ACTION_PROFILE_ACTION_H

#include <functional>
#include <string>

#include <nlohmann/json.hpp>

namespace kungfu::runtime::action {

inline constexpr const char *PROFILE_ACTION_SCHEMA_V1 = "kungfu.kfd7.profile-action/v1";
inline constexpr const char *PROFILE_ACTION_RECEIPT_V1 = "kungfu.kfd7.profile-action-receipt/v1";
inline constexpr const char *PROFILE_ROLE_BODY_SCHEMA_V1 = "kungfu.kfd7.profile-role/v1";
inline constexpr const char *PROFILE_CAPABILITIES_SCHEMA_V1 = "kungfu.kfd7.profile-capabilities/v1";
inline constexpr const char *PROFILE_INSPECTION_SCHEMA_V1 = "kungfu.kfd7.profile-inspection/v1";
inline constexpr const char *PROFILE_SESSION_SCHEMA_V1 = "kungfu.kfd7.session/v1";
inline constexpr const char *PROFILE_SESSION_EXPANSION_SCHEMA_V1 = "kungfu.kfd7.session-expansion/v1";
inline constexpr const char *PROFILE_SESSION_COMPRESSIBILITY_SCHEMA_V1 = "kungfu.kfd7.session-compressibility/v1";
inline constexpr const char *FACT_AUTHORITY_BUNDLE_SCHEMA_V2 = "kungfu.fact-authority-bundle/v2";

// Injectable Fact kernel edge: (runtime_dir, action, request) -> response.
// Empty function → default adapter over storage_service_api::run_fact_kernel_operation.
// Characterization tests inject a replay kernel that asserts byte-identical
// requests against golden kernel_io and returns the recorded responses.
using FactKernelFn = std::function<nlohmann::json(const std::string &runtime_dir, const std::string &action,
                                                  const nlohmann::json &request)>;

// Discovery document (no kernel). Byte-faithful to kungfu.agent.work_profile.capabilities.
[[nodiscard]] nlohmann::json profile_action_capabilities(const std::string &search_base = {});

// Validate / plan / optionally execute one KFD-7 Profile action. Kernel owns all
// persistence; this Profile only emits edge requests and assembles receipts.
[[nodiscard]] nlohmann::json apply_profile_action(const std::string &runtime_dir, const nlohmann::json &request,
                                                  bool execute = false, FactKernelFn kernel = {},
                                                  const std::string &search_base = {});

// Inspect a named ref through the Fact kernel catalog + Cut query.
[[nodiscard]] nlohmann::json inspect_profile_action(const std::string &runtime_dir, const std::string &ref_name,
                                                    FactKernelFn kernel = {}, const std::string &search_base = {});

[[nodiscard]] nlohmann::json session_compressibility(const nlohmann::json &session);
[[nodiscard]] nlohmann::json session_valid_actions(const nlohmann::json &session);
[[nodiscard]] nlohmann::json expand_session(const nlohmann::json &session);
[[nodiscard]] nlohmann::json project_session(const nlohmann::json &expansion, const std::string &search_base = {});

} // namespace kungfu::runtime::action

#endif // KUNGFU_RUNTIME_ACTION_PROFILE_ACTION_H
