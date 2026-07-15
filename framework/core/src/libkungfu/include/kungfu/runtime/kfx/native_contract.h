// SPDX-License-Identifier: Apache-2.0

#ifndef KUNGFU_RUNTIME_KFX_NATIVE_CONTRACT_H
#define KUNGFU_RUNTIME_KFX_NATIVE_CONTRACT_H

#include <string>

#include <nlohmann/json.hpp>

namespace kungfu::runtime::kfx {

inline constexpr const char *NATIVE_KFX_CONTRACT_V1 = "kungfu.kfx.native-contract/v1";
inline constexpr const char *NATIVE_KFX_CONTRACT_V2 = "kungfu.kfx.native-contract/v2";
inline constexpr const char *NATIVE_KFX_VALIDATION_V1 = "kungfu.kfx.native-validation/v1";
inline constexpr const char *NATIVE_KFX_VALIDATION_V2 = "kungfu.kfx.native-validation/v2";

[[nodiscard]] nlohmann::json native_kfx_contract();

[[nodiscard]] nlohmann::json normalize_native_kfx_manifest(const nlohmann::json &manifest);

[[nodiscard]] nlohmann::json validate_native_kfx_document(const std::string &kind, const nlohmann::json &document);

// This interface freezes the Core-owned lifecycle seam. Implementations may
// acquire journals, registries and mutation authority; bindings may only call
// through this interface and must not reproduce its policy.
class native_kfx_service {
public:
  virtual ~native_kfx_service() = default;

  [[nodiscard]] virtual nlohmann::json list(const nlohmann::json &request) = 0;
  [[nodiscard]] virtual nlohmann::json inspect(const nlohmann::json &request) = 0;
  [[nodiscard]] virtual nlohmann::json resolve(const nlohmann::json &request) = 0;
  [[nodiscard]] virtual nlohmann::json plan(const nlohmann::json &request) = 0;
  [[nodiscard]] virtual nlohmann::json apply(const nlohmann::json &request) = 0;
  [[nodiscard]] virtual nlohmann::json status(const nlohmann::json &request) = 0;
  [[nodiscard]] virtual nlohmann::json history(const nlohmann::json &request) = 0;
};

[[nodiscard]] nlohmann::json invoke_native_kfx_service(native_kfx_service &service, const nlohmann::json &request);

} // namespace kungfu::runtime::kfx

#endif // KUNGFU_RUNTIME_KFX_NATIVE_CONTRACT_H
