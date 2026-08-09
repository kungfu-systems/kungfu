// SPDX-License-Identifier: Apache-2.0

#ifndef KUNGFU_RUNTIME_PROFILE_PROFILE_LIFECYCLE_H
#define KUNGFU_RUNTIME_PROFILE_PROFILE_LIFECYCLE_H

#include <cstdint>
#include <string>

#include <nlohmann/json.hpp>

namespace kungfu::runtime::profile {

inline constexpr const char *PROFILE_LIFECYCLE_CONTRACT_V1 = "kungfu.profile-lifecycle/v1";
inline constexpr const char *PROFILE_LIFECYCLE_EVENT_V1 = "kungfu.profile-lifecycle-event/v1";
inline constexpr const char *PROFILE_INSPECTION_V1 = "kungfu.profile-inspection/v1";
inline constexpr const char *PROFILE_PLAN_V1 = "kungfu.profile-lifecycle-plan/v1";
inline constexpr const char *PROFILE_RECEIPT_V1 = "kungfu.profile-lifecycle-receipt/v1";

[[nodiscard]] nlohmann::json profile_lifecycle_contract();
[[nodiscard]] nlohmann::json inspect_profile(const std::string &profile_path,
                                             const nlohmann::json &member_roots = nlohmann::json::object());
[[nodiscard]] nlohmann::json plan_profile_lifecycle(const std::string &runtime_dir, const nlohmann::json &request);
[[nodiscard]] nlohmann::json apply_profile_lifecycle(const std::string &runtime_dir, const nlohmann::json &plan,
                                                     const std::string &authorization_id = {}, int64_t system_time = 0);
[[nodiscard]] nlohmann::json get_profile(const std::string &runtime_dir, const std::string &profile_id,
                                         bool include_removed = false, int64_t cut_system_time = 0);
[[nodiscard]] nlohmann::json list_profiles(const std::string &runtime_dir, bool include_removed = false,
                                           int64_t cut_system_time = 0);
[[nodiscard]] nlohmann::json profile_history(const std::string &runtime_dir, const std::string &profile_id);

} // namespace kungfu::runtime::profile

#endif // KUNGFU_RUNTIME_PROFILE_PROFILE_LIFECYCLE_H
