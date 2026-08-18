// SPDX-License-Identifier: Apache-2.0

#include "stream_cancellation.h"
#include <kungfu/api.h>
#include <kungfu/runtime/action/action_canonical_json.h>
#include <kungfu/view/action_envelope.h>
#include <kungfu/yijinjing/storage/content_hash.h>

#include <array>
#include <chrono>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <iterator>
#include <nlohmann/json.hpp>
#include <string>
#include <thread>

namespace {

bool require(bool condition, const char *message) {
  if (!condition) {
    std::cerr << "api contract: " << message << "\n";
  }
  return condition;
}

std::string root(char digit) { return "sha256:" + std::string(64, digit); }

bool contains(const kf_owned_message_v1 &result, const char *needle) {
  const std::string text(reinterpret_cast<const char *>(result.message.bytes),
                         static_cast<size_t>(result.message.byte_size));
  return text.find(needle) != std::string::npos;
}

nlohmann::json parse_owned(const kf_owned_message_v1 &result) {
  return nlohmann::json::parse(reinterpret_cast<const char *>(result.message.bytes),
                               reinterpret_cast<const char *>(result.message.bytes) + result.message.byte_size);
}

std::string content_root(std::string_view bytes) {
  return kungfu::yijinjing::storage::format_content_hash(
      kungfu::yijinjing::storage::compute_content_hash(bytes.data(), bytes.size()));
}

std::string protocol_root(std::string_view protocol, const nlohmann::json &value) {
  std::string preimage(protocol);
  preimage.push_back('\0');
  preimage += kungfu::runtime::action::action_canonical_json(value);
  return content_root(preimage);
}

std::string work_record_root(const std::vector<uint8_t> &bytes) {
  std::string preimage("kungfu.work.record-root/v1");
  preimage.push_back('\0');
  const auto size = static_cast<uint64_t>(bytes.size());
  for (int shift = 56; shift >= 0; shift -= 8)
    preimage.push_back(static_cast<char>((size >> shift) & UINT64_C(0xff)));
  preimage.append(reinterpret_cast<const char *>(bytes.data()), bytes.size());
  return content_root(preimage);
}

std::string hex_encode(const std::vector<uint8_t> &bytes) {
  static constexpr char DIGITS[] = "0123456789abcdef";
  std::string result;
  result.reserve(bytes.size() * 2);
  for (const auto byte : bytes) {
    result.push_back(DIGITS[byte >> 4U]);
    result.push_back(DIGITS[byte & 0x0fU]);
  }
  return result;
}

class temporary_root {
public:
  explicit temporary_root(const char *name)
      : path_(std::filesystem::temp_directory_path() /
              (std::string("kungfu-api-contract-") + name + "-" +
               std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()))) {
    std::filesystem::create_directories(path_);
  }
  ~temporary_root() {
    std::error_code ignored;
    std::filesystem::remove_all(path_, ignored);
  }
  const std::filesystem::path &path() const { return path_; }

private:
  std::filesystem::path path_;
};

} // namespace

int main() {
  using kungfu::runtime::detail::stream_cancellation_checkpoint;
  using kungfu::runtime::detail::stream_cancellation_disposition;
  if (!require(stream_cancellation_checkpoint(false, 0) == stream_cancellation_disposition::continue_reading,
               "an idle batch checkpoint stopped without cancellation") ||
      !require(stream_cancellation_checkpoint(true, 0) == stream_cancellation_disposition::cancel_empty_batch,
               "first-checkpoint cancellation did not cancel an empty batch") ||
      !require(stream_cancellation_checkpoint(true, 31) == stream_cancellation_disposition::continue_reading,
               "batch cancellation was polled before the declared interval") ||
      !require(stream_cancellation_checkpoint(true, 32) == stream_cancellation_disposition::publish_partial_batch,
               "checkpoint cancellation did not publish a partial batch")) {
    return 1;
  }

  kf_api_v1 api{};
  if (!require(kungfu_get_api(KF_ABI_V1 + 1, sizeof(api), &api) == KF_UNSUPPORTED_VERSION,
               "unknown bootstrap version must fail closed") ||
      !require(kungfu_get_api(KF_ABI_V1, sizeof(api) - 1, &api) == KF_INVALID_ARGUMENT,
               "undersized bootstrap table must fail closed") ||
      !require(kungfu_get_api(KF_ABI_V1, sizeof(api), &api) == KF_OK, "v1 bootstrap failed") ||
      !require(api.abi_version == KF_ABI_V1 && api.struct_size == sizeof(api), "bootstrap identity mismatch")) {
    return 1;
  }

  temporary_root context_root("context");
  temporary_root compact_target("compact-target");
  const auto context_root_text = context_root.path().string();
  const auto compact_target_text = compact_target.path().string();
  const auto sentinel = compact_target.path() / "sentinel.txt";
  std::ofstream(sentinel) << "unchanged";

  kf_context_config_v1 config{};
  config.struct_size = sizeof(config);
  config.runtime_dir = context_root_text.c_str();
  config.stream_root = context_root_text.c_str();
  config.host_namespace = "abi-test";
  config.host_name = "consumer";
  kf_context *context = nullptr;
  if (!require(api.context_open(&config, &context) == KF_OK && context != nullptr, "context open failed")) {
    return 1;
  }

  kf_discovery_api_v1 discovery{};
  if (!require(api.interface_get(context, UINT32_C(99), 1, sizeof(discovery), &discovery) == KF_UNSUPPORTED_INTERFACE,
               "unknown interface must fail closed") ||
      !require(api.interface_get(context, KF_INTERFACE_DISCOVERY, KF_DISCOVERY_ABI_V1 + 1, sizeof(discovery),
                                 &discovery) == KF_UNSUPPORTED_VERSION,
               "unknown interface version must fail closed") ||
      !require(api.interface_get(context, KF_INTERFACE_DISCOVERY, KF_DISCOVERY_ABI_V1, sizeof(discovery) - 1,
                                 &discovery) == KF_INVALID_ARGUMENT,
               "undersized interface table must fail closed") ||
      !require(api.interface_get(context, KF_INTERFACE_DISCOVERY, KF_DISCOVERY_ABI_V1, sizeof(discovery), &discovery) ==
                   KF_OK,
               "discovery v1 failed")) {
    return 1;
  }

  kf_runtime_info_v1 runtime_info{};
  runtime_info.struct_size = sizeof(runtime_info);
  if (!require(discovery.runtime_info(context, &runtime_info) == KF_OK, "runtime discovery failed") ||
      !require(runtime_info.interface_count == 6, "responsibility interface count drifted")) {
    return 1;
  }
  int32_t wrong_thread_status = KF_OK;
  std::thread foreign_thread([&]() {
    uint64_t capabilities = 0;
    wrong_thread_status = api.context_capabilities(context, &capabilities);
  });
  foreign_thread.join();
  if (!require(wrong_thread_status == KF_WRONG_THREAD, "foreign thread used an owner-thread context")) {
    return 1;
  }
  for (uint32_t index = 0; index < runtime_info.interface_count; ++index) {
    kf_interface_info_v1 info{};
    info.struct_size = sizeof(info);
    if (!require(discovery.interface_info(context, index, &info) == KF_OK, "interface inventory failed") ||
        !require(info.min_version == 1 && info.max_version == 1, "interface version mismatch")) {
      return 1;
    }
  }

  kf_error_info_v1 error{};
  error.struct_size = sizeof(error);
  if (!require(discovery.error_info(context, KF_STALE_HANDLE, &error) == KF_OK,
               "stable error dictionary lookup failed") ||
      !require(std::strcmp(error.name, "stale_handle") == 0, "stable error name drifted")) {
    return 1;
  }
  error = {};
  error.struct_size = sizeof(error);
  if (!require(discovery.error_info(context, KF_TIMEOUT, &error) == KF_OK, "reserved timeout lookup failed") ||
      !require(error.retryable == 0 && std::strstr(error.meaning, "Reserved in ABI v1") != nullptr,
               "timeout is still advertised as an executable v1 outcome")) {
    return 1;
  }

  const std::string query = R"({"contract":"all"})";
  kf_semantic_message_v1 request{};
  request.struct_size = sizeof(request);
  request.protocol_id = KF_PROTOCOL_INTERFACE_REGISTRY;
  request.protocol_version = 1;
  request.schema_ref = "kungfu.discovery.contract-query/v1";
  request.encoding = KF_ENCODING_JSON;
  request.bytes = reinterpret_cast<const uint8_t *>(query.data());
  request.byte_size = query.size();
  kf_owned_message_v1 result{};
  result.struct_size = sizeof(result);
  if (!require(discovery.contract_get(context, &request, &result) == KF_OK, "contract discovery failed") ||
      !require(contains(result, "planned-does-not-imply-authorized"), "non-inference rules missing") ||
      !require(contains(result, "cancel-before-side-effect-v1"), "admission contract missing") ||
      !require(contains(result, "every-32-frames-v1"), "batch checkpoint contract missing") ||
      !require(contains(result, "reserved-in-abi-v1"), "timeout reservation missing") ||
      !require(contains(result, "worker-process"), "discardable worker unit missing") ||
      !require(discovery.contract_get(context, &request, &result) == KF_BUSY,
               "a second owned result bypassed the lifetime fence") ||
      !require(discovery.result_release(context, result.token + 1) == KF_STALE_HANDLE,
               "stale result token was accepted") ||
      !require(discovery.result_release(context, result.token) == KF_OK, "result release failed")) {
    return 1;
  }
  request.protocol_id = "kungfu.unsupported";
  result = {};
  result.struct_size = sizeof(result);
  if (!require(discovery.contract_get(context, &request, &result) == KF_UNSUPPORTED_PROTOCOL,
               "unknown discovery protocol did not fail closed")) {
    return 1;
  }
  request.protocol_id = KF_PROTOCOL_INTERFACE_REGISTRY;

  kf_ledger_action_api_v1 ledger{};
  if (!require(api.interface_get(context, KF_INTERFACE_LEDGER_ACTION, KF_LEDGER_ACTION_ABI_V1, sizeof(ledger),
                                 &ledger) == KF_OK,
               "ledger-action v1 failed")) {
    return 1;
  }
  const auto r1 = root('1');
  const auto r2 = root('2');
  const auto r3 = root('3');
  const auto r4 = root('4');
  const auto r5 = root('5');
  const auto r6 = root('6');
  const auto r7 = root('7');
  kf_action_binding_config_v1 binding_config{};
  binding_config.struct_size = sizeof(binding_config);
  binding_config.fact_cut_root = r1.c_str();
  binding_config.pursuit_root = r2.c_str();
  binding_config.atlas_root = r3.c_str();
  binding_config.warrant_root = r4.c_str();
  binding_config.candidate_action_root = r5.c_str();
  binding_config.preconditions_root = r6.c_str();
  binding_config.resources_root = r7.c_str();
  kf_action_binding *binding = nullptr;
  if (!require(ledger.binding_open(context, &binding_config, &binding) == KF_OK, "binding open failed") ||
      !require(api.context_close(context) == KF_BUSY, "context closed with a live binding")) {
    return 1;
  }

  kf_action_binding_info_v1 binding_info{};
  binding_info.struct_size = sizeof(binding_info);
  constexpr const char *EXPECTED_BINDING_ROOT =
      "sha256:c156cb56fc16603689f6b875985ed7b7d92bec5d5d5b76adc2f75c67fabb3739";
  if (!require(ledger.binding_info(binding, &binding_info) == KF_OK, "binding info failed") ||
      !require(std::strcmp(binding_info.binding_root, EXPECTED_BINDING_ROOT) == 0,
               "ActionBinding canonical vector drifted")) {
    return 1;
  }
  const auto first_binding_root = std::string(binding_info.binding_root);
  const auto r8 = root('8');
  binding_config.pursuit_root = r8.c_str();
  kf_action_binding *changed_binding = nullptr;
  if (!require(ledger.binding_open(context, &binding_config, &changed_binding) == KF_OK,
               "changed binding input was rejected")) {
    return 1;
  }
  kf_action_binding_info_v1 changed_binding_info{};
  changed_binding_info.struct_size = sizeof(changed_binding_info);
  if (!require(ledger.binding_info(changed_binding, &changed_binding_info) == KF_OK, "changed binding info failed") ||
      !require(first_binding_root != changed_binding_info.binding_root,
               "a changed Pursuit root reused the old ActionBinding root") ||
      !require(ledger.binding_close(changed_binding) == KF_OK, "changed binding close failed")) {
    return 1;
  }

  const std::string fact_request = R"({"action":"capabilities"})";
  request.protocol_id = KF_PROTOCOL_STORAGE_SERVICE;
  request.protocol_version = 1;
  request.schema_ref = KF_SCHEMA_LEDGER_ACTION_REQUEST_V1;
  request.encoding = KF_ENCODING_JSON;
  request.bytes = reinterpret_cast<const uint8_t *>(fact_request.data());
  request.byte_size = fact_request.size();
  result = {};
  result.struct_size = sizeof(result);
  request.protocol_id = "kungfu.unsupported";
  if (!require(ledger.execute(context, binding, KF_LEDGER_ACTION_FACT_KERNEL, &request, &result) ==
                   KF_UNSUPPORTED_PROTOCOL,
               "ledger-action accepted an unknown protocol")) {
    return 1;
  }
  request.protocol_id = KF_PROTOCOL_STORAGE_SERVICE;
  request.schema_ref = "kungfu.wrong-request/v1";
  if (!require(ledger.execute(context, binding, KF_LEDGER_ACTION_FACT_KERNEL, &request, &result) ==
                   KF_UNSUPPORTED_SCHEMA,
               "ledger-action accepted a mismatched schema")) {
    return 1;
  }
  request.schema_ref = KF_SCHEMA_LEDGER_ACTION_REQUEST_V1;
  request.encoding = "application/cbor";
  if (!require(ledger.execute(context, binding, KF_LEDGER_ACTION_FACT_KERNEL, &request, &result) ==
                   KF_UNSUPPORTED_ENCODING,
               "ledger-action accepted an unknown encoding")) {
    return 1;
  }
  request.encoding = KF_ENCODING_JSON;
  if (!require(ledger.execute(context, binding, KF_LEDGER_ACTION_FACT_KERNEL, &request, &result) == KF_OK,
               "Fact kernel capability request failed") ||
      !require(contains(result, binding_info.binding_root), "ledger result did not bind exact decision roots") ||
      !require(contains(result, "fact-operation-evaluated"), "ledger stage is missing") ||
      !require(ledger.result_release(context, result.token) == KF_OK, "ledger result release failed")) {
    return 1;
  }

  kf_runtime_action_api_v1 runtime_action{};
  if (!require(api.interface_get(context, KF_INTERFACE_RUNTIME_ACTION, KF_RUNTIME_ACTION_ABI_V1 + 1,
                                 sizeof(runtime_action), &runtime_action) == KF_UNSUPPORTED_VERSION,
               "runtime-action accepted an unknown interface version") ||
      !require(api.interface_get(context, KF_INTERFACE_RUNTIME_ACTION, KF_RUNTIME_ACTION_ABI_V1,
                                 sizeof(runtime_action) - 1, &runtime_action) == KF_INVALID_ARGUMENT,
               "runtime-action accepted an undersized table") ||
      !require(api.interface_get(context, KF_INTERFACE_RUNTIME_ACTION, KF_RUNTIME_ACTION_ABI_V1, sizeof(runtime_action),
                                 &runtime_action) == KF_OK,
               "runtime-action v1 failed")) {
    return 1;
  }
  const std::string runtime_request = R"({"action":"geometry_root"})";
  request.protocol_id = KF_PROTOCOL_RUNTIME_ACTION;
  request.protocol_version = 1;
  request.schema_ref = KF_SCHEMA_RUNTIME_ACTION_REQUEST_V1;
  request.encoding = KF_ENCODING_JSON;
  request.bytes = reinterpret_cast<const uint8_t *>(runtime_request.data());
  request.byte_size = runtime_request.size();
  result = {};
  result.struct_size = sizeof(result);
  if (!require(runtime_action.execute(context, &request, &result) == KF_OK, "runtime-action geometry root failed") ||
      !require(std::strcmp(result.message.protocol_id, KF_PROTOCOL_RUNTIME_ACTION) == 0,
               "runtime-action result protocol drifted") ||
      !require(std::strcmp(result.message.schema_ref, "kungfu.action-runtime.result/v1") == 0,
               "runtime-action result schema drifted") ||
      !require(contains(result, "geometryRoot"), "runtime-action result omitted the geometry root")) {
    return 1;
  }
  const std::string write_request = R"({"action":"apply_action","execute":true,"request":{}})";
  request.bytes = reinterpret_cast<const uint8_t *>(write_request.data());
  request.byte_size = write_request.size();
  kf_owned_message_v1 busy_result{};
  busy_result.struct_size = sizeof(busy_result);
  if (!require(runtime_action.execute(context, &request, &busy_result) == KF_BUSY,
               "runtime-action admitted a write-capable operation with an outstanding result") ||
      !require(busy_result.token == 0, "busy runtime-action call published a result") ||
      !require(runtime_action.result_release(context, result.token) == KF_OK, "runtime-action result release failed")) {
    return 1;
  }
  request.bytes = reinterpret_cast<const uint8_t *>(runtime_request.data());
  request.byte_size = runtime_request.size();
  request.protocol_id = KF_PROTOCOL_STORAGE_SERVICE;
  result = {};
  result.struct_size = sizeof(result);
  if (!require(runtime_action.execute(context, &request, &result) == KF_UNSUPPORTED_PROTOCOL,
               "runtime-action accepted the storage-service protocol")) {
    return 1;
  }

  kf_maintenance_api_v1 maintenance{};
  if (!require(api.interface_get(context, KF_INTERFACE_MAINTENANCE, KF_MAINTENANCE_ABI_V1, sizeof(maintenance),
                                 &maintenance) == KF_OK,
               "maintenance v1 failed")) {
    return 1;
  }
  const auto compact_request = nlohmann::json{{"runtime_dir", compact_target_text}, {"dry_run", true}}.dump();
  request.protocol_id = KF_PROTOCOL_STORAGE_SERVICE;
  request.protocol_version = 1;
  request.schema_ref = KF_SCHEMA_MAINTENANCE_REQUEST_V1;
  request.encoding = KF_ENCODING_JSON;
  request.bytes = reinterpret_cast<const uint8_t *>(compact_request.data());
  request.byte_size = compact_request.size();
  result = {};
  result.struct_size = sizeof(result);
  const auto compact_status = maintenance.execute(context, KF_MAINTENANCE_COMPACT_PLAN, &request, &result);
  std::ifstream sentinel_stream(sentinel);
  const std::string sentinel_contents((std::istreambuf_iterator<char>(sentinel_stream)),
                                      std::istreambuf_iterator<char>());
  if (!require(compact_status == KF_OK, "compact-plan maintenance request failed") ||
      !require(contains(result, "\"operation\":6"), "compact-plan operation id missing") ||
      !require(contains(result, "\"operation_name\":\"compact_plan\""), "compact-plan operation name missing") ||
      !require(contains(result, "\"mutating\":false"), "compact-plan was marked mutating") ||
      !require(maintenance.result_release(context, result.token) == KF_OK, "compact-plan result release failed") ||
      !require(std::filesystem::is_regular_file(sentinel), "compact-plan removed the target sentinel") ||
      !require(sentinel_contents == "unchanged", "compact-plan changed the target sentinel") ||
      !require(std::distance(std::filesystem::directory_iterator(compact_target.path()),
                             std::filesystem::directory_iterator{}) == 1,
               "compact-plan mutated the target directory")) {
    return 1;
  }

  auto *cancelled_binding = reinterpret_cast<kf_action_binding *>(UINTPTR_MAX);
  if (!require(api.context_request_cancel(context) == KF_OK, "cancel request failed") ||
      !require(discovery.runtime_info(context, &runtime_info) == KF_CANCELLED,
               "cancelled context admitted another operation") ||
      !require(ledger.binding_open(context, &binding_config, &cancelled_binding) == KF_CANCELLED,
               "cancelled context admitted a child-handle allocation") ||
      !require(cancelled_binding == reinterpret_cast<kf_action_binding *>(UINTPTR_MAX),
               "cancel-before-admission modified caller output") ||
      !require(ledger.binding_close(binding) == KF_OK, "cancelled context could not release a child handle") ||
      !require(api.context_reset_cancel(context) == KF_OK, "cancel reset failed") ||
      !require(api.context_close(context) == KF_OK, "context close failed")) {
    return 1;
  }

  return 0;
}
