// SPDX-License-Identifier: Apache-2.0

#include "probe.h"

#include <kungfu/yijinjing/journal/journal.h>
#include <kungfu/yijinjing/time.h>

#include <algorithm>
#include <cstdio>
#include <memory>
#include <string>
#include <vector>

#if defined(_WIN32)
#include <windows.h>
#else
#include <dlfcn.h>
#endif

using namespace kungfu::yijinjing;

namespace {

constexpr int32_t MSG_BATCH = 21001;
constexpr int32_t MSG_ONE_MIB = 21002;
constexpr uint32_t BATCH_FIXTURE_FRAMES =
    KF_NATIVE_PROBE_BATCH_FRAMES * (KF_NATIVE_PROBE_WARMUP_BATCHES + KF_NATIVE_PROBE_MEASURED_BATCHES);
constexpr uint64_t MEASURED_PAYLOAD_BYTES =
    static_cast<uint64_t>(KF_NATIVE_PROBE_BATCH_FRAMES) * KF_NATIVE_PROBE_MEASURED_BATCHES * 256U;

bool check_error_paths(const kf_embedding_api_v1 &api, const char *root) {
  if (api.context_capabilities(nullptr, nullptr) != KF_EMBEDDING_INVALID_ARGUMENT ||
      api.reader_close(nullptr) != KF_EMBEDDING_INVALID_ARGUMENT) {
    return false;
  }

  struct extended_config {
    kf_embedding_context_config_v1 known;
    uint64_t future_field;
  } config{};
  config.known.struct_size = sizeof(config);
  config.known.root = root;
  config.known.host_namespace = "shared_membrane";
  config.known.host_name = "negative_paths";
  config.known.mode = KF_EMBEDDING_MODE_LIVE;
  config.future_field = UINT64_C(0xfeedface);

  kf_embedding_context *context = nullptr;
  if (api.context_open(&config.known, &context) != KF_EMBEDDING_OK) {
    return false;
  }

  struct extended_location {
    kf_embedding_location_v1 known;
    uint64_t future_field;
  } location{};
  location.known.struct_size = sizeof(location);
  location.known.namespace_name = "shared_membrane";
  location.known.name = "fixture";
  location.known.mode = KF_EMBEDDING_MODE_LIVE;
  location.known.role = KF_EMBEDDING_ROLE_SYSTEM;
  location.future_field = UINT64_C(0xcafebabe);

  kf_embedding_reader *reader = nullptr;
  if (api.reader_open(context, &location.known, &reader) != KF_EMBEDDING_OK ||
      api.context_close(context) != KF_EMBEDDING_BUSY) {
    return false;
  }
  kf_embedding_batch_v1 batch{};
  batch.struct_size = sizeof(batch);
  if (api.reader_read_batch(reader, 16, &batch) != KF_EMBEDDING_OK || batch.token == 0 ||
      api.reader_read_batch(reader, 16, &batch) != KF_EMBEDDING_BUSY || api.reader_close(reader) != KF_EMBEDDING_BUSY ||
      api.reader_release_batch(reader, batch.token + 1) != KF_EMBEDDING_INVALID_ARGUMENT ||
      api.reader_release_batch(reader, batch.token) != KF_EMBEDDING_OK || api.reader_close(reader) != KF_EMBEDDING_OK ||
      api.context_close(context) != KF_EMBEDDING_OK) {
    return false;
  }
  return true;
}

bool seed(const std::string &root) {
  auto locator = std::make_shared<data::locator>(root);
  auto location = data::location::make_shared(enums::mode::LIVE, enums::location_role::SYSTEM, "shared_membrane",
                                              "fixture", locator);
  auto writer =
      std::make_shared<journal::writer>(location, data::location::PUBLIC, std::make_shared<journal::noop_publisher>(),
                                        false, std::make_shared<journal::bus>(false));
  std::vector<uint8_t> payload(256);
  for (uint32_t index = 0; index < BATCH_FIXTURE_FRAMES; ++index) {
    std::fill(payload.begin(), payload.end(), static_cast<uint8_t>(index & 0xffU));
    writer->write_bytes(time::now_in_nano(), MSG_BATCH, payload, static_cast<uint32_t>(payload.size()));
  }
  payload.assign(1024U * 1024U, 0x5a);
  writer->write_bytes(time::now_in_nano(), MSG_ONE_MIB, payload, static_cast<uint32_t>(payload.size()));
  return true;
}

class dynamic_module {
public:
  explicit dynamic_module(const char *path) {
#if defined(_WIN32)
    handle_ = LoadLibraryA(path);
#else
    handle_ = dlopen(path, RTLD_NOW | RTLD_LOCAL);
#endif
  }
  ~dynamic_module() {
    if (handle_ != nullptr) {
#if defined(_WIN32)
      FreeLibrary(static_cast<HMODULE>(handle_));
#else
      dlclose(handle_);
#endif
    }
  }
  [[nodiscard]] bool loaded() const { return handle_ != nullptr; }
  [[nodiscard]] kf_native_probe_run_v1_fn entry() const {
#if defined(_WIN32)
    return reinterpret_cast<kf_native_probe_run_v1_fn>(
        GetProcAddress(static_cast<HMODULE>(handle_), "kf_native_probe_run_v1"));
#else
    return reinterpret_cast<kf_native_probe_run_v1_fn>(dlsym(handle_, "kf_native_probe_run_v1"));
#endif
  }

private:
#if defined(_WIN32)
  void *handle_ = nullptr;
#else
  void *handle_ = nullptr;
#endif
};

} // namespace

int main(int argc, char **argv) {
  if (argc != 3) {
    std::fprintf(stderr, "usage: shared_embedding_host JOURNAL_ROOT NATIVE_KFX_MODULE\n");
    return 2;
  }
  if (!seed(argv[1])) {
    return 3;
  }

  kf_embedding_api_v1 api{};
  // A version above the highest supported table is UNSUPPORTED_VERSION; an
  // undersized buffer for a supported version is INVALID_ARGUMENT.
  if (kungfu_embedding_get_api(KF_EMBEDDING_ABI_V3 + 1, sizeof(api), &api) != KF_EMBEDDING_UNSUPPORTED_VERSION ||
      kungfu_embedding_get_api(KF_EMBEDDING_ABI_V1, sizeof(api) - 1, &api) != KF_EMBEDDING_INVALID_ARGUMENT) {
    std::fprintf(stderr, "ABI version/size negotiation failed\n");
    return 4;
  }
  const auto api_status = kungfu_embedding_get_api(KF_EMBEDDING_ABI_V1, sizeof(api), &api);
  if (api_status != KF_EMBEDDING_OK || api.abi_version != KF_EMBEDDING_ABI_V1) {
    std::fprintf(stderr, "get_api failed: %d\n", api_status);
    return 5;
  }
  // v2 (ADR-0071) negotiates the read-only diagnostic surface on top of the v1
  // prefix. Requesting v2 into a v1-sized buffer must be rejected on size; a
  // correctly sized v2 request must advertise the storage-diagnostics capability
  // and populate the diagnostic pointers.
  kf_embedding_api_v2 api_v2{};
  if (kungfu_embedding_get_api(KF_EMBEDDING_ABI_V2, sizeof(kf_embedding_api_v1), &api_v2) !=
      KF_EMBEDDING_INVALID_ARGUMENT) {
    std::fprintf(stderr, "ABI v2 size negotiation failed\n");
    return 4;
  }
  const auto v2_status = kungfu_embedding_get_api(KF_EMBEDDING_ABI_V2, sizeof(api_v2), &api_v2);
  if (v2_status != KF_EMBEDDING_OK || api_v2.abi_version != KF_EMBEDDING_ABI_V2 ||
      (api_v2.capabilities & KF_EMBEDDING_CAP_STORAGE_DIAGNOSTICS) == 0 || api_v2.storage_fsck == nullptr ||
      api_v2.report_release == nullptr) {
    std::fprintf(stderr, "ABI v2 negotiation failed: %d\n", v2_status);
    return 5;
  }
  // v3 (ADR-0078) negotiates the generic-codec surface on top of the v2 prefix: a
  // correctly sized v3 request must advertise the generic-codec capability and
  // populate the decode/checksum pointers.
  kf_embedding_api_v3 api_v3{};
  if (kungfu_embedding_get_api(KF_EMBEDDING_ABI_V3, sizeof(kf_embedding_api_v2), &api_v3) !=
      KF_EMBEDDING_INVALID_ARGUMENT) {
    std::fprintf(stderr, "ABI v3 size negotiation failed\n");
    return 4;
  }
  const auto v3_status = kungfu_embedding_get_api(KF_EMBEDDING_ABI_V3, sizeof(api_v3), &api_v3);
  if (v3_status != KF_EMBEDDING_OK || api_v3.abi_version != KF_EMBEDDING_ABI_V3 ||
      (api_v3.capabilities & KF_EMBEDDING_CAP_GENERIC_CODEC) == 0 || api_v3.decode_frame_json == nullptr ||
      api_v3.frame_checksum == nullptr) {
    std::fprintf(stderr, "ABI v3 negotiation failed: %d\n", v3_status);
    return 5;
  }
  if (!check_error_paths(api, argv[1])) {
    std::fprintf(stderr, "ABI negative lifecycle checks failed\n");
    return 6;
  }

  dynamic_module native_kfx(argv[2]);
  if (!native_kfx.loaded() || native_kfx.entry() == nullptr) {
    std::fprintf(stderr, "native KFX module load failed: %s\n", argv[2]);
    return 7;
  }

  kf_native_probe_report_v1 report{};
  report.struct_size = sizeof(report);
  const auto status = native_kfx.entry()(&api, argv[1], &report);
  if (status != 0) {
    std::fprintf(stderr, "native KFX probe failed: %d\n", status);
    return 8;
  }
  if (report.frame_count != KF_NATIVE_PROBE_BATCH_FRAMES * KF_NATIVE_PROBE_MEASURED_BATCHES ||
      report.payload_bytes != MEASURED_PAYLOAD_BYTES || report.payload_bytes_copied != 0 ||
      report.one_mib_payload_bytes != 1024U * 1024U || report.first_payload_address == 0 ||
      report.extension_owned_idle_bytes == 0) {
    std::fprintf(stderr, "native KFX report invariant failed\n");
    return 9;
  }

  std::printf(
      "{\"consumer\":\"native-kfx\",\"abi_version\":%u,\"batch_calls\":%u,"
      "\"frames\":%llu,\"payload_bytes\":%llu,\"payload_bytes_copied\":%llu,"
      "\"first_payload_address\":\"0x%llx\",\"control_p50_ns\":%llu,\"control_p99_ns\":%llu,"
      "\"batch_4k_p50_ns\":%llu,\"batch_4k_p99_ns\":%llu,\"one_mib_payload_bytes\":%llu,"
      "\"extension_owned_idle_bytes\":%llu}\n",
      api.abi_version, report.batch_calls, static_cast<unsigned long long>(report.frame_count),
      static_cast<unsigned long long>(report.payload_bytes),
      static_cast<unsigned long long>(report.payload_bytes_copied),
      static_cast<unsigned long long>(report.first_payload_address),
      static_cast<unsigned long long>(report.control_p50_ns), static_cast<unsigned long long>(report.control_p99_ns),
      static_cast<unsigned long long>(report.batch_4k_p50_ns), static_cast<unsigned long long>(report.batch_4k_p99_ns),
      static_cast<unsigned long long>(report.one_mib_payload_bytes),
      static_cast<unsigned long long>(report.extension_owned_idle_bytes));
  return 0;
}
