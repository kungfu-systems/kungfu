// SPDX-License-Identifier: Apache-2.0

#ifndef KUNGFU_SHARED_EMBEDDING_PROBE_H
#define KUNGFU_SHARED_EMBEDDING_PROBE_H

#include <kungfu/embedding.h>

#include <stdint.h>

#if defined(_WIN32)
#define KF_NATIVE_PROBE_EXPORT __declspec(dllexport)
#else
#define KF_NATIVE_PROBE_EXPORT __attribute__((visibility("default")))
#endif

#ifdef __cplusplus
extern "C" {
#endif

typedef struct kf_native_probe_report_v1 {
  uint32_t struct_size;
  uint32_t batch_calls;
  uint64_t frame_count;
  uint64_t payload_bytes;
  uint64_t payload_bytes_copied;
  uintptr_t first_payload_address;
  uint64_t control_p50_ns;
  uint64_t control_p99_ns;
  uint64_t batch_4k_p50_ns;
  uint64_t batch_4k_p99_ns;
  uint64_t one_mib_payload_bytes;
  uint64_t extension_owned_idle_bytes;
  uint64_t checksum;
} kf_native_probe_report_v1;

typedef int32_t(KF_EMBEDDING_CALL *kf_native_probe_run_v1_fn)(const kf_embedding_api_v1 *api, const char *root,
                                                              kf_native_probe_report_v1 *report);

KF_NATIVE_PROBE_EXPORT int32_t KF_EMBEDDING_CALL kf_native_probe_run_v1(const kf_embedding_api_v1 *api,
                                                                        const char *root,
                                                                        kf_native_probe_report_v1 *report);

#ifdef __cplusplus
}
#endif

#endif // KUNGFU_SHARED_EMBEDDING_PROBE_H
