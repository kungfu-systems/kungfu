// SPDX-License-Identifier: Apache-2.0

#ifndef KUNGFU_RUNTIME_KFX_NATIVE_AUTHORITY_H
#define KUNGFU_RUNTIME_KFX_NATIVE_AUTHORITY_H

#include <cstdint>
#include <functional>
#include <string>

#include <nlohmann/json.hpp>

namespace kungfu::runtime::kfx::authority {

using assessment_fn =
    std::function<nlohmann::json(const nlohmann::json &, const std::string &, const nlohmann::json &)>;

[[nodiscard]] nlohmann::json assess(const nlohmann::json &package, const std::string &registry_root,
                                    const nlohmann::json &request);

[[nodiscard]] nlohmann::json plan(const nlohmann::json &packages, const std::string &registry_root,
                                  const std::string &graph_root, const nlohmann::json &prior_cut, uint64_t revision,
                                  const nlohmann::json &request, const nlohmann::json &load_plan,
                                  const assessment_fn &assess);

} // namespace kungfu::runtime::kfx::authority

#endif // KUNGFU_RUNTIME_KFX_NATIVE_AUTHORITY_H
