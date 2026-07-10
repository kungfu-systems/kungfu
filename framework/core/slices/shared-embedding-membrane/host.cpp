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

bool seed(const std::string &root) {
  auto locator = std::make_shared<data::locator>(root);
  auto location = data::location::make_shared(enums::mode::LIVE, enums::location_role::SYSTEM, "shared_membrane",
                                              "fixture", locator);
  auto writer = std::make_shared<journal::writer>(location, data::location::PUBLIC, true,
                                                  std::make_shared<journal::noop_publisher>(), false,
                                                  std::make_shared<journal::bus>(false));
  std::vector<uint8_t> payload(256);
  for (uint32_t index = 0; index < 1600; ++index) {
    std::fill(payload.begin(), payload.end(), static_cast<uint8_t>(index & 0xffU));
    writer->write_bytes(time::now_in_nano(), MSG_BATCH, payload, static_cast<uint32_t>(payload.size()));
  }
  payload.assign(1024U * 1024U, 0x5a);
  writer->write_bytes(time::now_in_nano(), MSG_ONE_MIB, payload, static_cast<uint32_t>(payload.size()));
  return true;
}

class module {
public:
  explicit module(const char *path) {
#if defined(_WIN32)
    handle_ = LoadLibraryA(path);
#else
    handle_ = dlopen(path, RTLD_NOW | RTLD_LOCAL);
#endif
  }
  ~module() {
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
  if (kungfu_embedding_get_api(KF_EMBEDDING_ABI_V1 + 1, sizeof(api), &api) != KF_EMBEDDING_UNSUPPORTED_VERSION ||
      kungfu_embedding_get_api(KF_EMBEDDING_ABI_V1, sizeof(api) - 1, &api) != KF_EMBEDDING_INVALID_ARGUMENT) {
    std::fprintf(stderr, "ABI version/size negotiation failed\n");
    return 4;
  }
  const auto api_status = kungfu_embedding_get_api(KF_EMBEDDING_ABI_V1, sizeof(api), &api);
  if (api_status != KF_EMBEDDING_OK || api.abi_version != KF_EMBEDDING_ABI_V1) {
    std::fprintf(stderr, "get_api failed: %d\n", api_status);
    return 5;
  }

  module native_kfx(argv[2]);
  if (!native_kfx.loaded() || native_kfx.entry() == nullptr) {
    std::fprintf(stderr, "native KFX module load failed: %s\n", argv[2]);
    return 6;
  }

  kf_native_probe_report_v1 report{};
  report.struct_size = sizeof(report);
  const auto status = native_kfx.entry()(&api, argv[1], &report);
  if (status != 0) {
    std::fprintf(stderr, "native KFX probe failed: %d\n", status);
    return 7;
  }
  if (report.frame_count != 1600 || report.payload_bytes != 409600 || report.payload_bytes_copied != 0 ||
      report.one_mib_payload_bytes != 1024U * 1024U || report.first_payload_address == 0) {
    std::fprintf(stderr, "native KFX report invariant failed\n");
    return 8;
  }

  std::printf(
      "{\"consumer\":\"native-kfx\",\"abi_version\":%u,\"batch_calls\":%u,"
      "\"frames\":%llu,\"payload_bytes\":%llu,\"payload_bytes_copied\":%llu,"
      "\"first_payload_address\":\"0x%llx\",\"control_p50_ns\":%llu,\"control_p99_ns\":%llu,"
      "\"batch_4k_p50_ns\":%llu,\"batch_4k_p99_ns\":%llu,\"one_mib_payload_bytes\":%llu}\n",
      api.abi_version, report.batch_calls, static_cast<unsigned long long>(report.frame_count),
      static_cast<unsigned long long>(report.payload_bytes),
      static_cast<unsigned long long>(report.payload_bytes_copied),
      static_cast<unsigned long long>(report.first_payload_address),
      static_cast<unsigned long long>(report.control_p50_ns), static_cast<unsigned long long>(report.control_p99_ns),
      static_cast<unsigned long long>(report.batch_4k_p50_ns), static_cast<unsigned long long>(report.batch_4k_p99_ns),
      static_cast<unsigned long long>(report.one_mib_payload_bytes));
  return 0;
}
