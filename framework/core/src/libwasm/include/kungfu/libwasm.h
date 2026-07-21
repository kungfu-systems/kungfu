// SPDX-License-Identifier: Apache-2.0

#ifndef KUNGFU_LIBWASM_H
#define KUNGFU_LIBWASM_H

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
#define KF_LIBWASM_CAP_JOURNAL_READ_BATCH (UINT64_C(1) << 0)

#define KF_LIBWASM_OK INT32_C(0)
#define KF_LIBWASM_INVALID_ARGUMENT INT32_C(1)
#define KF_LIBWASM_UNSUPPORTED_ENGINE INT32_C(2)
#define KF_LIBWASM_EMBEDDING_ERROR INT32_C(3)
#define KF_LIBWASM_ENGINE_ERROR INT32_C(4)
#define KF_LIBWASM_GUEST_TRAP INT32_C(5)
#define KF_LIBWASM_PANIC_CONTAINED INT32_C(6)
#define KF_LIBWASM_INVARIANT_ERROR INT32_C(7)
#define KF_LIBWASM_HASH_MISMATCH INT32_C(8)
#define KF_LIBWASM_CONTRACT_REJECTED INT32_C(9)
#define KF_LIBWASM_LIMIT_EXCEEDED INT32_C(10)

typedef struct kf_libwasm_execute_config_v1 {
  uint32_t struct_size;
  uint32_t engine;
  const uint8_t *module_data;
  uint64_t module_size;
  const char *expected_sha256;
  const char *world;
  uint64_t granted_capabilities;
  uint64_t fuel;
  uint32_t max_memory_pages;
  uint32_t max_batch_frames;
  uint64_t max_module_bytes;
  uint32_t max_output_bytes;
  uint32_t reserved0;
  const char *root;
  const char *source_namespace;
  const char *source_name;
} kf_libwasm_execute_config_v1;

typedef struct kf_libwasm_execution_receipt_v1 {
  uint32_t struct_size;
  uint32_t abi_version;
  uint32_t engine;
  int32_t status;
  uint32_t admitted;
  uint32_t limit_exceeded;
  uint32_t trap_contained;
  uint32_t reserved0;
  uint64_t granted_capabilities;
  uint64_t fuel_limit;
  uint64_t fuel_consumed;
  uint64_t batch_calls;
  uint64_t frame_count;
  uint64_t payload_bytes;
  uint64_t host_to_guest_bytes_copied;
  uint64_t guest_result;
  char artifact_sha256[65];
  char reserved1[7];
} kf_libwasm_execution_receipt_v1;

typedef int32_t(KF_LIBWASM_CALL *kf_libwasm_execute_v1_fn)(const kf_api_v1 *api,
                                                           const kf_libwasm_execute_config_v1 *config,
                                                           kf_libwasm_execution_receipt_v1 *receipt);
typedef int32_t(KF_LIBWASM_CALL *kf_libwasm_self_test_v1_fn)(void);

#endif // KUNGFU_LIBWASM_H
