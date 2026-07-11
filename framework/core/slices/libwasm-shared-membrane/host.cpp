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

constexpr int32_t MSG_BATCH = 21101;
constexpr int32_t MSG_ONE_MIB = 21102;
constexpr uint32_t BATCH_FRAMES = 16;
constexpr uint32_t WARMUP_BATCHES = 10;
constexpr uint32_t MEASURED_BATCHES = 1000;
constexpr uint64_t COPY_BENCH_REPEATS = 8;
constexpr uint32_t FIXTURE_FRAMES = BATCH_FRAMES * (WARMUP_BATCHES + MEASURED_BATCHES);

bool seed(const std::string &root) {
  auto locator = std::make_shared<data::locator>(root);
  auto location =
      data::location::make_shared(enums::mode::LIVE, enums::location_role::SYSTEM, "libwasm_spike", "fixture", locator);
  auto writer = std::make_shared<journal::writer>(location, data::location::PUBLIC, true,
                                                  std::make_shared<journal::noop_publisher>(), false,
                                                  std::make_shared<journal::bus>(false));
  std::vector<uint8_t> payload(256);
  for (uint32_t index = 0; index < FIXTURE_FRAMES; ++index) {
    std::fill(payload.begin(), payload.end(), static_cast<uint8_t>(index & 0xffU));
    writer->write_bytes(time::now_in_nano(), MSG_BATCH, payload, static_cast<uint32_t>(payload.size()));
  }
  payload.assign(1024U * 1024U, 0x5a);
  writer->write_bytes(time::now_in_nano(), MSG_ONE_MIB, payload, static_cast<uint32_t>(payload.size()));
  return true;
}

class dynamic_library {
public:
  explicit dynamic_library(const char *path) {
#if defined(_WIN32)
    handle_ = LoadLibraryA(path);
#else
    handle_ = dlopen(path, RTLD_NOW | RTLD_LOCAL);
#endif
  }
  ~dynamic_library() {
    if (handle_ != nullptr) {
#if defined(_WIN32)
      FreeLibrary(static_cast<HMODULE>(handle_));
#else
      dlclose(handle_);
#endif
    }
  }
  [[nodiscard]] bool loaded() const { return handle_ != nullptr; }
  template <typename T> [[nodiscard]] T symbol(const char *name) const {
#if defined(_WIN32)
    return reinterpret_cast<T>(GetProcAddress(static_cast<HMODULE>(handle_), name));
#else
    return reinterpret_cast<T>(dlsym(handle_, name));
#endif
  }

private:
  void *handle_ = nullptr;
};

const char *engine_name(uint32_t engine) { return engine == KF_LIBWASM_ENGINE_WASMTIME ? "wasmtime" : "wasmer"; }

bool run_engine(const dynamic_library &libwasm, const char *library_path, const kf_embedding_api_v1 &api,
                const char *root, uint32_t engine) {
  if (!libwasm.loaded()) {
    std::fprintf(stderr, "%s libwasm module load failed: %s\n", engine_name(engine), library_path);
    return false;
  }
  std::fprintf(stderr, "%s phase: module-loaded\n", engine_name(engine));
  const auto run = libwasm.symbol<kf_libwasm_run_v1_fn>("kf_libwasm_run_v1");
  const auto panic_probe = libwasm.symbol<kf_libwasm_panic_probe_v1_fn>("kf_libwasm_panic_probe_v1");
  if (run == nullptr || panic_probe == nullptr || panic_probe() != KF_LIBWASM_PANIC_CONTAINED) {
    std::fprintf(stderr, "%s C ABI or panic containment probe failed\n", engine_name(engine));
    return false;
  }
  std::fprintf(stderr, "%s phase: panic-contained\n", engine_name(engine));
  kf_libwasm_config_v1 size_config{};
  size_config.struct_size = sizeof(size_config);
  size_config.engine = engine;
  size_config.root = root;
  size_config.source_namespace = "libwasm_spike";
  size_config.source_name = "fixture";
  size_config.batch_frames = BATCH_FRAMES;
  size_config.measured_batches = 1;
  kf_libwasm_report_v1 too_small{};
  too_small.struct_size = sizeof(too_small) - 1;
  if (run(&api, &size_config, &too_small) != 1 || run(nullptr, &size_config, &too_small) != 1) {
    std::fprintf(stderr, "%s C ABI size/null negotiation failed\n", engine_name(engine));
    return false;
  }
  std::fprintf(stderr, "%s phase: abi-negotiated\n", engine_name(engine));
  kf_libwasm_config_v1 config{};
  config.struct_size = sizeof(config);
  config.engine = engine;
  config.root = root;
  config.source_namespace = "libwasm_spike";
  config.source_name = "fixture";
  config.batch_frames = BATCH_FRAMES;
  config.warmup_batches = WARMUP_BATCHES;
  config.measured_batches = MEASURED_BATCHES;

  kf_libwasm_report_v1 report{};
  report.struct_size = sizeof(report);
  std::fprintf(stderr, "%s phase: engine-run\n", engine_name(engine));
  const auto status = run(&api, &config, &report);
  const uint64_t expected_frames = static_cast<uint64_t>(BATCH_FRAMES) * MEASURED_BATCHES;
  const uint64_t expected_payload = expected_frames * 256U;
  const uint64_t expected_copied = expected_payload + 1024U * 1024U * COPY_BENCH_REPEATS;
  if (status != 0 || report.abi_version != KF_LIBWASM_ABI_V1 || report.engine != engine || report.trap_contained != 1 ||
      report.batch_calls != MEASURED_BATCHES || report.frame_count != expected_frames ||
      report.payload_bytes != expected_payload || report.host_to_guest_bytes_copied != expected_copied ||
      report.guest_to_host_bytes_copied != 0 || report.one_mib_copy_bytes_per_second == 0) {
    std::fprintf(stderr, "%s report invariant failed (status=%d)\n", engine_name(engine), status);
    return false;
  }

  std::printf(
      "{\"consumer\":\"libwasm\",\"engine\":\"%s\",\"abi_version\":%u,"
      "\"batch_calls\":%llu,\"frames\":%llu,\"payload_bytes\":%llu,"
      "\"host_to_guest_bytes_copied\":%llu,\"guest_to_host_bytes_copied\":%llu,"
      "\"control_p50_ns\":%llu,\"control_p99_ns\":%llu,"
      "\"batch_4k_p50_ns\":%llu,\"batch_4k_p99_ns\":%llu,"
      "\"cold_compile_ns\":%llu,\"cold_instantiate_ns\":%llu,"
      "\"one_mib_copy_ns\":%llu,\"one_mib_copy_bytes_per_second\":%llu,"
      "\"instance_idle_delta_bytes\":%llu,\"trap_contained\":true}\n",
      engine_name(engine), report.abi_version, static_cast<unsigned long long>(report.batch_calls),
      static_cast<unsigned long long>(report.frame_count), static_cast<unsigned long long>(report.payload_bytes),
      static_cast<unsigned long long>(report.host_to_guest_bytes_copied),
      static_cast<unsigned long long>(report.guest_to_host_bytes_copied),
      static_cast<unsigned long long>(report.control_p50_ns), static_cast<unsigned long long>(report.control_p99_ns),
      static_cast<unsigned long long>(report.batch_4k_p50_ns), static_cast<unsigned long long>(report.batch_4k_p99_ns),
      static_cast<unsigned long long>(report.cold_compile_ns),
      static_cast<unsigned long long>(report.cold_instantiate_ns),
      static_cast<unsigned long long>(report.one_mib_copy_ns),
      static_cast<unsigned long long>(report.one_mib_copy_bytes_per_second),
      static_cast<unsigned long long>(report.instance_idle_delta_bytes));
  return true;
}

} // namespace

int main(int argc, char **argv) {
  if (argc != 4) {
    std::fprintf(stderr, "usage: libwasm_shared_membrane_host JOURNAL_ROOT WASMTIME_MODULE WASMER_MODULE\n");
    return 2;
  }
  if (!seed(argv[1])) {
    return 3;
  }

  kf_embedding_api_v1 api{};
  if (kungfu_embedding_get_api(KF_EMBEDDING_ABI_V1, sizeof(api), &api) != KF_EMBEDDING_OK) {
    return 4;
  }
  // Engine adapters are process-resident. In particular, do not unload one
  // Rust runtime before exercising another runtime's panic/unwind boundary.
  const dynamic_library wasmtime(argv[2]);
  const dynamic_library wasmer(argv[3]);
  if (!run_engine(wasmtime, argv[2], api, argv[1], KF_LIBWASM_ENGINE_WASMTIME) ||
      !run_engine(wasmer, argv[3], api, argv[1], KF_LIBWASM_ENGINE_WASMER)) {
    return 8;
  }
  return 0;
}
