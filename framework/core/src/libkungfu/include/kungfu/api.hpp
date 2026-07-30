// SPDX-License-Identifier: Apache-2.0

#ifndef KUNGFU_API_HPP
#define KUNGFU_API_HPP

#include <kungfu/api.h>

#include <stdexcept>
#include <string>
#include <string_view>
#include <utility>

namespace kungfu::api {

class error final : public std::runtime_error {
public:
  error(kf_status status, std::string message) : std::runtime_error(std::move(message)), status_(status) {}

  [[nodiscard]] kf_status status() const noexcept { return status_; }

private:
  kf_status status_;
};

inline void check(int32_t status, const char *operation) {
  if (status != KF_OK) {
    throw error(static_cast<kf_status>(status),
                std::string(operation) + " failed with status " + std::to_string(status));
  }
}

class context final {
public:
  explicit context(const kf_context_config_v1 &config) {
    check(kungfu_get_api(KF_ABI_V1, sizeof(api_), &api_), "kungfu_get_api");
    check(api_.context_open(&config, &handle_), "context_open");
  }

  context(const context &) = delete;
  context &operator=(const context &) = delete;
  context(context &&) = delete;
  context &operator=(context &&) = delete;

  ~context() {
    if (handle_ != nullptr) {
      (void)api_.context_close(handle_);
    }
  }

  [[nodiscard]] const kf_api_v1 &bootstrap() const noexcept { return api_; }
  [[nodiscard]] kf_context *get() const noexcept { return handle_; }

  template <typename Interface> [[nodiscard]] Interface interface(uint32_t interface_id, uint32_t version) const {
    Interface result{};
    check(api_.interface_get(handle_, interface_id, version, sizeof(result), &result), "interface_get");
    return result;
  }

  void request_cancel() { check(api_.context_request_cancel(handle_), "context_request_cancel"); }
  void reset_cancel() { check(api_.context_reset_cancel(handle_), "context_reset_cancel"); }

  void close() {
    if (handle_ != nullptr) {
      check(api_.context_close(handle_), "context_close");
      handle_ = nullptr;
    }
  }

private:
  kf_api_v1 api_{};
  kf_context *handle_ = nullptr;
};

struct wire_response final {
  std::string protocol_id;
  uint32_t protocol_version = 0;
  std::string schema_ref;
  std::string encoding;
  std::string bytes;
};

[[nodiscard]] inline wire_response call_runtime_action_raw(const context &owner, std::string_view protocol_id,
                                                           uint32_t protocol_version, std::string_view schema_ref,
                                                           std::string_view encoding, std::string_view request_bytes) {
  auto *native_context = owner.get();
  const auto api = owner.interface<kf_runtime_action_api_v1>(KF_INTERFACE_RUNTIME_ACTION, KF_RUNTIME_ACTION_ABI_V1);
  if (api.execute == nullptr || api.result_release == nullptr) {
    throw error(KF_CORE_ERROR, "runtime-action interface omitted required functions");
  }
  const std::string protocol(protocol_id);
  const std::string schema(schema_ref);
  const std::string encoding_name(encoding);
  kf_semantic_message_v1 request{};
  request.struct_size = sizeof(request);
  request.protocol_id = protocol.c_str();
  request.protocol_version = protocol_version;
  request.schema_ref = schema.c_str();
  request.encoding = encoding_name.c_str();
  request.bytes = reinterpret_cast<const uint8_t *>(request_bytes.data());
  request.byte_size = request_bytes.size();

  kf_owned_message_v1 result{};
  result.struct_size = sizeof(result);
  check(api.execute(native_context, &request, &result), "runtime_action.execute");
  bool result_live = result.token != 0;
  try {
    if (result.message.protocol_id == nullptr || result.message.schema_ref == nullptr ||
        result.message.encoding == nullptr || result.message.bytes == nullptr || result.message.byte_size == 0 ||
        !result_live) {
      throw error(KF_CORE_ERROR, "runtime_action.execute returned an invalid result view");
    }
    wire_response response{
        result.message.protocol_id,
        result.message.protocol_version,
        result.message.schema_ref,
        result.message.encoding,
        std::string(reinterpret_cast<const char *>(result.message.bytes),
                    static_cast<size_t>(result.message.byte_size)),
    };
    result_live = false;
    const auto release_status = api.result_release(native_context, result.token);
    check(release_status, "runtime_action.result_release");
    return response;
  } catch (...) {
    if (result_live) {
      (void)api.result_release(native_context, result.token);
    }
    throw;
  }
}

[[nodiscard]] inline wire_response call_runtime_action_json(const context &owner, std::string_view request_json) {
  return call_runtime_action_raw(owner, KF_PROTOCOL_RUNTIME_ACTION, 1, KF_SCHEMA_RUNTIME_ACTION_REQUEST_V1,
                                 KF_ENCODING_JSON, request_json);
}

} // namespace kungfu::api

#endif // KUNGFU_API_HPP
