// SPDX-License-Identifier: Apache-2.0

#ifndef KUNGFU_NATIVE_STORAGE_H
#define KUNGFU_NATIVE_STORAGE_H

#include <stddef.h>
#include <stdint.h>

#if defined(_WIN32)
#define KF_NATIVE_STORAGE_CALL __cdecl
#if defined(KF_NATIVE_STORAGE_BUILD_SHARED)
#define KF_NATIVE_STORAGE_EXPORT __declspec(dllexport)
#elif defined(KF_NATIVE_STORAGE_USE_SHARED)
#define KF_NATIVE_STORAGE_EXPORT __declspec(dllimport)
#else
#define KF_NATIVE_STORAGE_EXPORT
#endif
#elif defined(__GNUC__) || defined(__clang__)
#define KF_NATIVE_STORAGE_CALL
#define KF_NATIVE_STORAGE_EXPORT __attribute__((visibility("default")))
#else
#define KF_NATIVE_STORAGE_CALL
#define KF_NATIVE_STORAGE_EXPORT
#endif

#ifdef __cplusplus
extern "C" {
#endif

#define KF_NATIVE_STORAGE_ABI_V1 UINT32_C(1)

/* Contexts and their borrowed results are single-thread-affine in v1. */
typedef struct kf_native_storage_context kf_native_storage_context;

typedef enum kf_native_storage_status {
  KF_NATIVE_STORAGE_OK = 0,
  KF_NATIVE_STORAGE_INVALID_ARGUMENT = 1,
  KF_NATIVE_STORAGE_UNSUPPORTED_VERSION = 2,
  KF_NATIVE_STORAGE_BUSY = 3,
  KF_NATIVE_STORAGE_CORE_ERROR = 4,
  KF_NATIVE_STORAGE_UNSUPPORTED_OPERATION = 5
} kf_native_storage_status;

#define KF_NATIVE_STORAGE_CAP_EPISODE_LIFECYCLE (UINT64_C(1) << 0)
#define KF_NATIVE_STORAGE_CAP_HEAD_AND_HISTORICAL_QUERY (UINT64_C(1) << 1)
#define KF_NATIVE_STORAGE_CAP_FSCK (UINT64_C(1) << 2)
#define KF_NATIVE_STORAGE_CAP_EXPORT (UINT64_C(1) << 3)
#define KF_NATIVE_STORAGE_CAP_DOMAIN_FACT_ADMISSION (UINT64_C(1) << 4)
#define KF_NATIVE_STORAGE_CAP_TRUST_ASSESSMENT (UINT64_C(1) << 5)

typedef struct kf_native_storage_context_config_v1 {
  uint32_t struct_size;
  uint32_t flags;
  const char *runtime_dir;
  uint64_t reserved[4];
} kf_native_storage_context_config_v1;

/*
 * JSON bytes are owned by the context and remain valid until release_result.
 * Only one result may be outstanding per context. The response is the JSON
 * edge projection produced by the existing libkungfu storage service; the
 * journal remains authoritative.
 */
typedef struct kf_native_storage_result_v1 {
  uint32_t struct_size;
  uint32_t reserved;
  const char *json_data;
  size_t json_size;
  uint64_t token;
} kf_native_storage_result_v1;

/*
 * v1 execute operations: episode_begin, episode_end, fact_query, fsck,
 * export_bundle, and the fact_contract / fact_declare_world /
 * fact_declare_surface / fact_observe / fact_state family. Request fields and
 * response schemas are the corresponding kungfu.runtime.storage-service/v1
 * JSON contracts. Every other operation is explicitly unsupported by this ABI
 * version.
 */

typedef int32_t(KF_NATIVE_STORAGE_CALL *kf_native_storage_context_open_v1_fn)(
    const kf_native_storage_context_config_v1 *config, kf_native_storage_context **out_context);
typedef int32_t(KF_NATIVE_STORAGE_CALL *kf_native_storage_context_capabilities_v1_fn)(
    const kf_native_storage_context *context, uint64_t *out_capabilities);
typedef int32_t(KF_NATIVE_STORAGE_CALL *kf_native_storage_context_last_error_v1_fn)(
    const kf_native_storage_context *context, const char **out_data, size_t *out_size);
typedef int32_t(KF_NATIVE_STORAGE_CALL *kf_native_storage_context_close_v1_fn)(kf_native_storage_context *context);
typedef int32_t(KF_NATIVE_STORAGE_CALL *kf_native_storage_execute_v1_fn)(kf_native_storage_context *context,
                                                                         const char *operation,
                                                                         const char *request_json,
                                                                         size_t request_json_size,
                                                                         kf_native_storage_result_v1 *out_result);
typedef int32_t(KF_NATIVE_STORAGE_CALL *kf_native_storage_release_result_v1_fn)(kf_native_storage_context *context,
                                                                                uint64_t token);

typedef struct kf_native_storage_api_v1 {
  uint32_t abi_version;
  uint32_t struct_size;
  uint64_t capabilities;
  kf_native_storage_context_open_v1_fn context_open;
  kf_native_storage_context_capabilities_v1_fn context_capabilities;
  kf_native_storage_context_last_error_v1_fn context_last_error;
  kf_native_storage_context_close_v1_fn context_close;
  kf_native_storage_execute_v1_fn execute;
  kf_native_storage_release_result_v1_fn release_result;
} kf_native_storage_api_v1;

/* The only link-visible bootstrap. All versioned operations live in the table. */
KF_NATIVE_STORAGE_EXPORT int32_t KF_NATIVE_STORAGE_CALL kungfu_native_storage_get_api(
    uint32_t requested_version, uint32_t caller_struct_size, kf_native_storage_api_v1 *out_api);

#ifdef __cplusplus
}
#endif

#endif // KUNGFU_NATIVE_STORAGE_H
