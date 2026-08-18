// SPDX-License-Identifier: Apache-2.0

#ifndef KUNGFU_RUNTIME_PROFILE_INITIATIVE_ASSIGNMENT_SERVICE_H
#define KUNGFU_RUNTIME_PROFILE_INITIATIVE_ASSIGNMENT_SERVICE_H

#include <cstdint>
#include <string>

#include <nlohmann/json.hpp>

namespace kungfu::runtime::profile {

inline constexpr const char *INITIATIVE_ASSIGNMENT_NATIVE_CONTRACT_V1 =
    "kungfu.initiative-assignment.native-service-contract/v1";
inline constexpr const char *INITIATIVE_ASSIGNMENT_NATIVE_ADMISSION_V1 =
    "kungfu.initiative-assignment.native-admission/v1";
inline constexpr const char *INITIATIVE_ASSIGNMENT_NATIVE_EVENT_V1 =
    "kungfu.initiative-assignment.native-admission-event/v1";
inline constexpr const char *INITIATIVE_ASSIGNMENT_REPLAY_REQUEST_V1 =
    "kungfu.initiative-assignment.native-replay-request/v1";
inline constexpr const char *INITIATIVE_ASSIGNMENT_REPLAY_EVIDENCE_V1 =
    "kungfu.initiative-assignment.native-replay-evidence/v1";
inline constexpr const char *INITIATIVE_ASSIGNMENT_ADMISSION_RECEIPT_V1 =
    "kungfu.incubation-passport.admission-receipt/v1";

[[nodiscard]] nlohmann::json initiative_assignment_native_contract();
[[nodiscard]] nlohmann::json run_initiative_assignment_native_service(const std::string &runtime_dir,
                                                                      uint32_t operation,
                                                                      const nlohmann::json &request);

} // namespace kungfu::runtime::profile

#endif // KUNGFU_RUNTIME_PROFILE_INITIATIVE_ASSIGNMENT_SERVICE_H
