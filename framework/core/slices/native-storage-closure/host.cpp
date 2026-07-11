// SPDX-License-Identifier: Apache-2.0

#include <kungfu/native_storage.h>

#include <cstdint>
#include <cstdio>
#include <string>

namespace {

constexpr uint64_t EPISODE_ID = UINT64_C(42490049);
constexpr uint64_t EXPECTED_CAPABILITIES = KF_NATIVE_STORAGE_CAP_EPISODE_LIFECYCLE |
                                           KF_NATIVE_STORAGE_CAP_HEAD_AND_HISTORICAL_QUERY |
                                           KF_NATIVE_STORAGE_CAP_FSCK | KF_NATIVE_STORAGE_CAP_EXPORT;
// This external-style C consumer intentionally pins the built-in declaration
// roots. Contract-world drift must fail closed until the consumer updates.
constexpr const char *CONTRACT_WORLD_ROOT = "sha256:99e55c748b2e2b12c994b5e691f6781e66f9d460402e4e6871a48d3628314e9e";
constexpr const char *EPISODE_FACT_SURFACE_ROOT =
    "sha256:bfdb3eb73ba4ab88e5da42d3eec7a964260ba8da4a0151213a7ed121252ddc85";

bool contains(const std::string &value, const std::string &needle) { return value.find(needle) != std::string::npos; }

std::string last_error(const kf_native_storage_api_v1 &api, const kf_native_storage_context *context) {
  const char *data = nullptr;
  size_t size = 0;
  if (api.context_last_error(context, &data, &size) != KF_NATIVE_STORAGE_OK || data == nullptr) {
    return {};
  }
  return {data, size};
}

bool call(const kf_native_storage_api_v1 &api, kf_native_storage_context *context, const char *operation,
          const std::string &request, std::string &response) {
  kf_native_storage_result_v1 result{};
  result.struct_size = sizeof(result);
  const auto status = api.execute(context, operation, request.data(), request.size(), &result);
  if (status != KF_NATIVE_STORAGE_OK) {
    std::fprintf(stderr, "%s failed: status=%d error=%s\n", operation, status, last_error(api, context).c_str());
    return false;
  }
  if (result.json_data == nullptr || result.json_size == 0 || result.token == 0) {
    std::fprintf(stderr, "%s returned an invalid result view\n", operation);
    return false;
  }
  response.assign(result.json_data, result.json_size);
  if (api.context_close(context) != KF_NATIVE_STORAGE_BUSY ||
      api.release_result(context, result.token + 1) != KF_NATIVE_STORAGE_INVALID_ARGUMENT ||
      api.release_result(context, result.token) != KF_NATIVE_STORAGE_OK) {
    std::fprintf(stderr, "%s result ownership checks failed\n", operation);
    return false;
  }
  return true;
}

std::string resolved_cut(const std::string &head) {
  const std::string prefix = "\"resolved\":{\"kind\":\"manifest_frame_uid\",\"manifest_frame_uid\":\"";
  const auto begin = head.find(prefix);
  if (begin == std::string::npos) {
    return {};
  }
  const auto value_begin = begin + prefix.size();
  const auto end = head.find('"', value_begin);
  return end == std::string::npos ? std::string{} : head.substr(value_begin, end - value_begin);
}

std::string fact_query_request(const std::string &cut) {
  const auto selected_cut = cut.empty() ? std::string{"{\"kind\":\"head\"}"}
                                        : "{\"kind\":\"manifest_frame_uid\",\"manifest_frame_uid\":\"" + cut + "\"}";
  return "{\"definition\":{\"basis\":{\"contract_world\":{\"id\":\"kungfu.runtime\",\"version\":\"1\",\"root\":\"" +
         std::string{CONTRACT_WORLD_ROOT} +
         "\"},\"fact_surfaces\":[{\"id\":\"kungfu.runtime.episode-manifest\",\"version\":\"1\",\"root\":\"" +
         std::string{EPISODE_FACT_SURFACE_ROOT} + "\"}],\"episode_id\":" + std::to_string(EPISODE_ID) +
         ",\"cut\":" + selected_cut + "}}}";
}

bool open_context(const kf_native_storage_api_v1 &api, const char *runtime_dir,
                  kf_native_storage_context **out_context) {
  kf_native_storage_context_config_v1 config{};
  config.struct_size = sizeof(config);
  config.runtime_dir = runtime_dir;
  return api.context_open(&config, out_context) == KF_NATIVE_STORAGE_OK;
}

} // namespace

int main(int argc, char **argv) {
  if (argc != 2) {
    std::fprintf(stderr, "usage: native_storage_closure_host WORKSPACE.kungfu\n");
    return 2;
  }

  kf_native_storage_api_v1 api{};
  if (kungfu_native_storage_get_api(KF_NATIVE_STORAGE_ABI_V1 + 1, sizeof(api), &api) !=
          KF_NATIVE_STORAGE_UNSUPPORTED_VERSION ||
      kungfu_native_storage_get_api(KF_NATIVE_STORAGE_ABI_V1, sizeof(api) - 1, &api) !=
          KF_NATIVE_STORAGE_INVALID_ARGUMENT ||
      kungfu_native_storage_get_api(KF_NATIVE_STORAGE_ABI_V1, sizeof(api), &api) != KF_NATIVE_STORAGE_OK) {
    std::fprintf(stderr, "native storage ABI negotiation failed\n");
    return 3;
  }

  kf_native_storage_context *context = nullptr;
  if (!open_context(api, argv[1], &context)) {
    std::fprintf(stderr, "native storage context create failed\n");
    return 4;
  }
  uint64_t capabilities = 0;
  if (api.context_capabilities(context, &capabilities) != KF_NATIVE_STORAGE_OK ||
      (capabilities & EXPECTED_CAPABILITIES) != EXPECTED_CAPABILITIES) {
    std::fprintf(stderr, "native storage capabilities are incomplete\n");
    return 5;
  }
  kf_native_storage_result_v1 invalid_result{};
  invalid_result.struct_size = sizeof(invalid_result);
  if (api.execute(context, "not_a_storage_operation", "{}", 2, &invalid_result) !=
          KF_NATIVE_STORAGE_UNSUPPORTED_OPERATION ||
      last_error(api, context).empty()) {
    std::fprintf(stderr, "unsupported operation contract failed\n");
    return 6;
  }
  if (api.execute(context, "episode_begin", "{", 1, &invalid_result) != KF_NATIVE_STORAGE_INVALID_ARGUMENT ||
      invalid_result.json_data != nullptr || invalid_result.json_size != 0 || invalid_result.token != 0 ||
      last_error(api, context).empty()) {
    std::fprintf(stderr, "invalid request contract failed\n");
    return 6;
  }

  std::string response;
  const auto begin_request = "{\"episode_id\":" + std::to_string(EPISODE_ID) +
                             ",\"begin_time\":100,\"title\":\"native closure\","
                             "\"actor\":\"libkungfu\",\"source\":\"adr-0049\"}";
  if (!call(api, context, "episode_begin", begin_request, response) ||
      !contains(response, "\"episode_id\":" + std::to_string(EPISODE_ID))) {
    return 7;
  }
  if (!call(api, context, "fact_query", fact_query_request({}), response) || !contains(response, "\"closed\":false")) {
    return 8;
  }
  const auto open_cut = resolved_cut(response);
  if (open_cut.empty()) {
    std::fprintf(stderr, "head query did not expose a stable manifest cut\n");
    return 9;
  }
  const auto end_request = "{\"episode_id\":" + std::to_string(EPISODE_ID) +
                           ",\"end_time\":200,\"frame_count\":0,\"reason\":\"native closure complete\"}";
  if (!call(api, context, "episode_end", end_request, response) || !contains(response, "\"content_root\":")) {
    return 10;
  }
  if (api.context_close(context) != KF_NATIVE_STORAGE_OK) {
    return 11;
  }

  // Reopen the same .kungfu workspace to prove the lifecycle is not process-
  // local or language-host state.
  context = nullptr;
  if (!open_context(api, argv[1], &context)) {
    return 12;
  }
  if (!call(api, context, "fact_query", fact_query_request({}), response) || !contains(response, "\"closed\":true") ||
      !contains(response, "\"content_root_status\":\"verified\"")) {
    return 13;
  }
  if (!call(api, context, "fact_query", fact_query_request(open_cut), response) ||
      !contains(response, "\"closed\":false") || !contains(response, "\"inclusive\":true")) {
    return 14;
  }
  const auto scoped = "{\"scope\":\"episode\",\"episode_id\":" + std::to_string(EPISODE_ID) + "}";
  if (!call(api, context, "fsck", scoped, response) || !contains(response, "\"ok\":true")) {
    return 15;
  }
  if (!call(api, context, "export_bundle", scoped, response) ||
      !contains(response, "\"schema\":\"kungfu.storage.episode-bundle/v1\"") ||
      !contains(response, "\"record_count\":3")) {
    return 16;
  }
  if (api.context_close(context) != KF_NATIVE_STORAGE_OK) {
    return 17;
  }

  std::printf("{\"consumer\":\"native-storage\",\"abi_version\":%u,\"episode_id\":%llu,"
              "\"historical_cut\":\"%s\",\"language_hosts\":0,\"database_services\":0,\"ok\":true}\n",
              api.abi_version, static_cast<unsigned long long>(EPISODE_ID), open_cut.c_str());
  return 0;
}
