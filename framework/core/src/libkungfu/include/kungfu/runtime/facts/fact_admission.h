// SPDX-License-Identifier: Apache-2.0

#ifndef KUNGFU_RUNTIME_FACTS_FACT_ADMISSION_H
#define KUNGFU_RUNTIME_FACTS_FACT_ADMISSION_H

#include <cstdint>
#include <string>

#include <nlohmann/json.hpp>

namespace kungfu::runtime::facts {

inline constexpr const char *DOMAIN_FACT_CONTRACT_V1 = "kungfu.facts.domain-admission/v1";
inline constexpr const char *DOMAIN_FACT_EVENT_SCHEMA_V1 = "kungfu.facts.domain-fact-event/v1";

[[nodiscard]] nlohmann::json fact_contract_json();

[[nodiscard]] nlohmann::json declare_contract_world(const std::string &runtime_dir, const nlohmann::json &declaration,
                                                    int64_t system_time = 0);

[[nodiscard]] nlohmann::json declare_fact_surface(const std::string &runtime_dir, const nlohmann::json &declaration,
                                                  int64_t system_time = 0, const std::string &owned_schema_hash = {});

[[nodiscard]] nlohmann::json record_observation(const std::string &runtime_dir, const nlohmann::json &observation,
                                                int64_t system_time = 0, const std::string &owned_payload_hash = {});

[[nodiscard]] nlohmann::json query_fact_state(const std::string &runtime_dir, int64_t cut_system_time = 0,
                                              const std::string &subject_key = {});

} // namespace kungfu::runtime::facts

#endif // KUNGFU_RUNTIME_FACTS_FACT_ADMISSION_H
