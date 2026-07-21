// SPDX-License-Identifier: Apache-2.0

#ifndef KUNGFU_LIBWASM_SPIKE_PROBE_H
#define KUNGFU_LIBWASM_SPIKE_PROBE_H

#include <kungfu/api.h>

#include <stdint.h>

#if defined(_WIN32)
#define KF_LIBWASM_CALL __cdecl
#else
#define KF_LIBWASM_CALL
#endif

#define KF_LIBWASM_ABI_V1 UINT32_C(1)
#define KF_LIBWASM_ENGINE_WASMTIME UINT32_C(1)
#define KF_LIBWASM_ENGINE_WASMER UINT32_C(2)
#define KF_LIBWASM_PANIC_CONTAINED INT32_C(6)

typedef struct kf_libwasm_config_v1 {
  uint32_t struct_size;
  uint32_t engine;
  const char *root;
  const char *source_namespace;
  const char *source_name;
  uint32_t batch_frames;
  uint32_t warmup_batches;
  uint32_t measured_batches;
} kf_libwasm_config_v1;

typedef struct kf_libwasm_report_v1 {
  uint32_t struct_size;
  uint32_t abi_version;
  uint32_t engine;
  uint32_t trap_contained;
  uint64_t batch_calls;
  uint64_t frame_count;
  uint64_t payload_bytes;
  uint64_t host_to_guest_bytes_copied;
  uint64_t guest_to_host_bytes_copied;
  uint64_t control_p50_ns;
  uint64_t control_p99_ns;
  uint64_t batch_4k_p50_ns;
  uint64_t batch_4k_p99_ns;
  uint64_t cold_compile_ns;
  uint64_t cold_instantiate_ns;
  uint64_t one_mib_copy_ns;
  uint64_t one_mib_copy_bytes_per_second;
  uint64_t instance_idle_delta_bytes;
} kf_libwasm_report_v1;

typedef int32_t(KF_LIBWASM_CALL *kf_libwasm_run_v1_fn)(const kf_api_v1 *api, const kf_libwasm_config_v1 *config,
                                                       kf_libwasm_report_v1 *report);
typedef int32_t(KF_LIBWASM_CALL *kf_libwasm_panic_probe_v1_fn)(void);

#endif
