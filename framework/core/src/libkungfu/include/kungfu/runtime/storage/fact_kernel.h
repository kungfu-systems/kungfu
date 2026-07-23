// SPDX-License-Identifier: Apache-2.0

#ifndef KUNGFU_RUNTIME_STORAGE_FACT_KERNEL_H
#define KUNGFU_RUNTIME_STORAGE_FACT_KERNEL_H

#include <string>

#include <nlohmann/json.hpp>

namespace kungfu::runtime::storage_service_api {

inline constexpr const char *FACT_KERNEL_SCHEMA_V1 = "kungfu.fact-kernel.operation/v1";
inline constexpr const char *FACT_KERNEL_STATE_SCHEMA_V1 = "kungfu.fact-kernel.state/v1";

// One C++ authority for ADR-0112. Callers submit JSON only at the edge; this
// function validates and normalizes it before the Hana POD journal fold owns
// identity, relation, Cut, ref and receipt semantics.
[[nodiscard]] nlohmann::json run_fact_kernel_operation(const std::string &runtime_dir, const nlohmann::json &request);

[[nodiscard]] nlohmann::json fact_kernel_capabilities();

} // namespace kungfu::runtime::storage_service_api

#endif // KUNGFU_RUNTIME_STORAGE_FACT_KERNEL_H
