// SPDX-License-Identifier: Apache-2.0

#include <kungfu/native_storage.h>
#include <kungfu/runtime/storage/json_edge.h>

#include <array>
#include <cstring>
#include <memory>
#include <string>
#include <string_view>

#include <nlohmann/json.hpp>

namespace {

constexpr uint64_t CAPABILITIES = KF_NATIVE_STORAGE_CAP_EPISODE_LIFECYCLE |
                                  KF_NATIVE_STORAGE_CAP_HEAD_AND_HISTORICAL_QUERY | KF_NATIVE_STORAGE_CAP_FSCK |
                                  KF_NATIVE_STORAGE_CAP_EXPORT;
constexpr std::array<std::string_view, 5> SUPPORTED_OPERATIONS = {"episode_begin", "episode_end", "fact_query", "fsck",
                                                                  "export_bundle"};

bool supported_operation(const char *operation) {
  for (const auto candidate : SUPPORTED_OPERATIONS) {
    if (candidate == operation) {
      return true;
    }
  }
  return false;
}

} // namespace

struct kf_native_storage_context {
  std::string runtime_dir;
  std::string result;
  std::string last_error;
  uint64_t next_token = 1;
  uint64_t outstanding_token = 0;
};

namespace {

void set_error(kf_native_storage_context *context, const char *message) noexcept {
  if (context == nullptr) {
    return;
  }
  try {
    context->last_error = message == nullptr ? "unknown libkungfu error" : message;
  } catch (...) {
    context->last_error.clear();
  }
}

int32_t KF_NATIVE_STORAGE_CALL context_open(const kf_native_storage_context_config_v1 *config,
                                            kf_native_storage_context **out_context) noexcept {
  if (config == nullptr || out_context == nullptr || config->struct_size < sizeof(*config) || config->flags != 0 ||
      config->runtime_dir == nullptr || config->runtime_dir[0] == '\0') {
    return KF_NATIVE_STORAGE_INVALID_ARGUMENT;
  }
  *out_context = nullptr;
  try {
    auto result = std::make_unique<kf_native_storage_context>();
    result->runtime_dir = config->runtime_dir;
    *out_context = result.release();
    return KF_NATIVE_STORAGE_OK;
  } catch (...) {
    return KF_NATIVE_STORAGE_CORE_ERROR;
  }
}

int32_t KF_NATIVE_STORAGE_CALL context_capabilities(const kf_native_storage_context *context,
                                                    uint64_t *out_capabilities) noexcept {
  if (context == nullptr || out_capabilities == nullptr) {
    return KF_NATIVE_STORAGE_INVALID_ARGUMENT;
  }
  *out_capabilities = CAPABILITIES;
  return KF_NATIVE_STORAGE_OK;
}

int32_t KF_NATIVE_STORAGE_CALL context_last_error(const kf_native_storage_context *context, const char **out_data,
                                                  size_t *out_size) noexcept {
  if (context == nullptr || out_data == nullptr || out_size == nullptr) {
    return KF_NATIVE_STORAGE_INVALID_ARGUMENT;
  }
  *out_data = context->last_error.empty() ? nullptr : context->last_error.data();
  *out_size = context->last_error.size();
  return KF_NATIVE_STORAGE_OK;
}

int32_t KF_NATIVE_STORAGE_CALL context_close(kf_native_storage_context *context) noexcept {
  if (context == nullptr) {
    return KF_NATIVE_STORAGE_INVALID_ARGUMENT;
  }
  if (context->outstanding_token != 0) {
    return KF_NATIVE_STORAGE_BUSY;
  }
  delete context;
  return KF_NATIVE_STORAGE_OK;
}

int32_t KF_NATIVE_STORAGE_CALL execute(kf_native_storage_context *context, const char *operation,
                                       const char *request_json, size_t request_json_size,
                                       kf_native_storage_result_v1 *out_result) noexcept {
  if (context == nullptr || operation == nullptr || operation[0] == '\0' || out_result == nullptr ||
      out_result->struct_size < sizeof(*out_result) || (request_json == nullptr && request_json_size != 0)) {
    return KF_NATIVE_STORAGE_INVALID_ARGUMENT;
  }
  out_result->json_data = nullptr;
  out_result->json_size = 0;
  out_result->token = 0;
  out_result->reserved = 0;
  if (context->outstanding_token != 0) {
    return KF_NATIVE_STORAGE_BUSY;
  }

  context->last_error.clear();
  try {
    if (!supported_operation(operation)) {
      set_error(context, "unsupported storage operation");
      return KF_NATIVE_STORAGE_UNSUPPORTED_OPERATION;
    }
    nlohmann::json request = nlohmann::json::object();
    if (request_json_size != 0) {
      request = nlohmann::json::parse(request_json, request_json + request_json_size);
      if (!request.is_object()) {
        throw std::invalid_argument("native storage request JSON must be an object");
      }
    }
    context->result =
        kungfu::runtime::storage_service_api::run_storage_service_operation(operation, context->runtime_dir, request)
            .dump(-1, ' ', false);
    if (context->next_token == 0) {
      context->next_token = 1;
    }
    context->outstanding_token = context->next_token++;
    out_result->json_data = context->result.data();
    out_result->json_size = context->result.size();
    out_result->token = context->outstanding_token;
    return KF_NATIVE_STORAGE_OK;
  } catch (const nlohmann::json::parse_error &error) {
    set_error(context, error.what());
    return KF_NATIVE_STORAGE_INVALID_ARGUMENT;
  } catch (const std::invalid_argument &error) {
    set_error(context, error.what());
    return KF_NATIVE_STORAGE_INVALID_ARGUMENT;
  } catch (const std::exception &error) {
    set_error(context, error.what());
    return KF_NATIVE_STORAGE_CORE_ERROR;
  } catch (...) {
    set_error(context, "unknown libkungfu storage error");
    return KF_NATIVE_STORAGE_CORE_ERROR;
  }
}

int32_t KF_NATIVE_STORAGE_CALL release_result(kf_native_storage_context *context, uint64_t token) noexcept {
  if (context == nullptr || token == 0 || token != context->outstanding_token) {
    return KF_NATIVE_STORAGE_INVALID_ARGUMENT;
  }
  context->result.clear();
  context->outstanding_token = 0;
  return KF_NATIVE_STORAGE_OK;
}

const kf_native_storage_api_v1 API_V1 = {KF_NATIVE_STORAGE_ABI_V1,
                                         sizeof(kf_native_storage_api_v1),
                                         CAPABILITIES,
                                         context_open,
                                         context_capabilities,
                                         context_last_error,
                                         context_close,
                                         execute,
                                         release_result};

} // namespace

extern "C" KF_NATIVE_STORAGE_EXPORT int32_t KF_NATIVE_STORAGE_CALL kungfu_native_storage_get_api(
    uint32_t requested_version, uint32_t caller_struct_size, kf_native_storage_api_v1 *out_api) {
  if (requested_version != KF_NATIVE_STORAGE_ABI_V1) {
    return KF_NATIVE_STORAGE_UNSUPPORTED_VERSION;
  }
  if (out_api == nullptr || caller_struct_size < sizeof(kf_native_storage_api_v1)) {
    return KF_NATIVE_STORAGE_INVALID_ARGUMENT;
  }
  std::memcpy(out_api, &API_V1, sizeof(API_V1));
  return KF_NATIVE_STORAGE_OK;
}
