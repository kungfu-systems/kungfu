// SPDX-License-Identifier: Apache-2.0

#ifndef KUNGFU_RUNTIME_PROFILE_PROFILE_LIFECYCLE_H
#define KUNGFU_RUNTIME_PROFILE_PROFILE_LIFECYCLE_H

#include <cstdint>
#include <stdexcept>
#include <string>
#include <utility>

#include <nlohmann/json.hpp>

namespace kungfu::runtime::profile {

inline constexpr const char *PROFILE_LIFECYCLE_CONTRACT_V1 = "kungfu.profile-lifecycle/v1";
inline constexpr const char *PROFILE_LIFECYCLE_EVENT_V1 = "kungfu.profile-lifecycle-event/v1";
inline constexpr const char *PROFILE_INSPECTION_V1 = "kungfu.profile-inspection/v1";
inline constexpr const char *PROFILE_PLAN_V1 = "kungfu.profile-lifecycle-plan/v1";
inline constexpr const char *PROFILE_RECEIPT_V1 = "kungfu.profile-lifecycle-receipt/v1";
inline constexpr const char *INITIATIVE_ASSIGNMENT_ROOT_V1 = "kungfu.initiative-assignment.root/v1";
inline constexpr const char *INITIATIVE_SURFACE_V1 = "kungfu.initiative-assignment.initiative";
inline constexpr const char *ASSIGNMENT_SURFACE_V1 = "kungfu.initiative-assignment.assignment";

class initiative_assignment_root_error : public std::invalid_argument {
public:
  initiative_assignment_root_error(std::string code, const std::string &message)
      : std::invalid_argument(message), code_(std::move(code)) {}
  [[nodiscard]] const std::string &code() const noexcept { return code_; }

private:
  std::string code_;
};

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
[[nodiscard]] nlohmann::json compute_initiative_assignment_root(const nlohmann::json &input);
[[nodiscard]] nlohmann::json verify_initiative_assignment_root(const nlohmann::json &input,
                                                               const std::string &canonical_hex,
                                                               const std::string &preimage_hex,
                                                               const std::string &root);

} // namespace kungfu::runtime::profile

#endif // KUNGFU_RUNTIME_PROFILE_PROFILE_LIFECYCLE_H
