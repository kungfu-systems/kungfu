// SPDX-License-Identifier: Apache-2.0

#ifndef KUNGFU_RUNTIME_KFX_NATIVE_REGISTRY_H
#define KUNGFU_RUNTIME_KFX_NATIVE_REGISTRY_H

#include <string>

#include <nlohmann/json.hpp>

namespace kungfu::runtime::kfx {

// Build one immutable, read-only registry snapshot from explicit roots. Every
// call re-derives its result from content; no process-local cache is authority.
[[nodiscard]] nlohmann::json query_native_kfx_registry(const std::string &action, const nlohmann::json &request);

} // namespace kungfu::runtime::kfx

#endif // KUNGFU_RUNTIME_KFX_NATIVE_REGISTRY_H
