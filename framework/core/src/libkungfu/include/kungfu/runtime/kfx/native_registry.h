// SPDX-License-Identifier: Apache-2.0

#ifndef KUNGFU_RUNTIME_KFX_NATIVE_REGISTRY_H
#define KUNGFU_RUNTIME_KFX_NATIVE_REGISTRY_H

#include <string>

#include <nlohmann/json.hpp>

namespace kungfu::runtime::kfx {

// Return the embedded KFX Domain Profile and its deterministic root.
[[nodiscard]] nlohmann::json native_kfx_domain_profile();

// Return the minimal Core-embedded ceiling that lets the first-party Control
// Suite manage its own next version without granting itself trust or power.
[[nodiscard]] nlohmann::json native_kfx_control_bootstrap_policy();

// Read-only calls project a pinned named Fact Cut when runtime_dir is present.
// Explicit roots are bounded discovery observations used for planning or
// bootstrap; they never become lifecycle authority without Work settlement and
// an exact expected-old/revision Fact ref CAS.
[[nodiscard]] nlohmann::json query_native_kfx_registry(const std::string &action, const nlohmann::json &request,
                                                       const std::string &runtime_dir = {});

} // namespace kungfu::runtime::kfx

#endif // KUNGFU_RUNTIME_KFX_NATIVE_REGISTRY_H
