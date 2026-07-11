// SPDX-License-Identifier: Apache-2.0

#ifndef KUNGFU_RUNTIME_TRUST_ASSESSMENT_RUNTIME_H
#define KUNGFU_RUNTIME_TRUST_ASSESSMENT_RUNTIME_H

#include <cstdint>
#include <string>

#include <nlohmann/json.hpp>

namespace kungfu::runtime::trust {

inline constexpr const char *ASSESSMENT_CONTRACT_V1 = "kungfu.trust.assessment/v1";
inline constexpr const char *ASSESSMENT_EVENT_SCHEMA_V1 = "kungfu.trust.assessment-event/v1";

[[nodiscard]] nlohmann::json assessment_contract_json();

[[nodiscard]] nlohmann::json request_assessment(const std::string &runtime_dir, const nlohmann::json &request,
                                                int64_t system_time = 0);

[[nodiscard]] nlohmann::json execute_assessment(const std::string &runtime_dir, const std::string &assessment_key,
                                                const std::string &executor_profile, int64_t system_time = 0);

[[nodiscard]] nlohmann::json query_assessment(const std::string &runtime_dir, const std::string &assessment_key);

[[nodiscard]] nlohmann::json list_assessments(const std::string &runtime_dir);

[[nodiscard]] nlohmann::json invalidate_assessment(const std::string &runtime_dir, const std::string &assessment_key,
                                                   const std::string &changed_root, const std::string &reason,
                                                   int64_t system_time = 0);

[[nodiscard]] nlohmann::json require_trust(const std::string &runtime_dir, const std::string &assessment_key,
                                           const std::string &purpose);

} // namespace kungfu::runtime::trust

#endif // KUNGFU_RUNTIME_TRUST_ASSESSMENT_RUNTIME_H
