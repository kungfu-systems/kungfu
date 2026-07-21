// SPDX-License-Identifier: Apache-2.0

#ifndef KUNGFU_API_H
#define KUNGFU_API_H

#include <stdint.h>

#if defined(_WIN32)
#define KF_CALL __cdecl
#if defined(KF_API_BUILD_SHARED)
#define KF_API_EXPORT __declspec(dllexport)
#elif defined(KF_API_USE_SHARED)
#define KF_API_EXPORT __declspec(dllimport)
#else
#define KF_API_EXPORT
#endif
#elif defined(__GNUC__) || defined(__clang__)
#define KF_CALL
#define KF_API_EXPORT __attribute__((visibility("default")))
#else
#define KF_CALL
#define KF_API_EXPORT
#endif

#ifdef __cplusplus
extern "C" {
#endif

#define KF_ABI_V1 UINT32_C(1)

#define KF_INTERFACE_DISCOVERY UINT32_C(1)
#define KF_INTERFACE_STREAM UINT32_C(2)
#define KF_INTERFACE_LEDGER_ACTION UINT32_C(3)
#define KF_INTERFACE_MAINTENANCE UINT32_C(4)

#define KF_DISCOVERY_ABI_V1 UINT32_C(1)
#define KF_STREAM_ABI_V1 UINT32_C(1)
#define KF_LEDGER_ACTION_ABI_V1 UINT32_C(1)
#define KF_MAINTENANCE_ABI_V1 UINT32_C(1)

#define KF_ENCODING_JSON "application/json"
#define KF_PROTOCOL_STORAGE_SERVICE "kungfu.runtime.storage-service"
#define KF_PROTOCOL_ACTION_BINDING "kungfu.action-binding"
#define KF_PROTOCOL_INTERFACE_REGISTRY "kungfu.interface-registry"
#define KF_SCHEMA_LEDGER_ACTION_REQUEST_V1 "kungfu.ledger-action.request/v1"
#define KF_SCHEMA_MAINTENANCE_REQUEST_V1 "kungfu.maintenance.request/v1"

typedef struct kf_context kf_context;
typedef struct kf_stream_reader kf_stream_reader;
typedef struct kf_action_binding kf_action_binding;

typedef enum kf_status {
  KF_OK = 0,
  KF_INVALID_ARGUMENT = 1,
  KF_UNSUPPORTED_VERSION = 2,
  KF_UNSUPPORTED_INTERFACE = 3,
  KF_UNSUPPORTED_PROTOCOL = 4,
  KF_UNSUPPORTED_SCHEMA = 5,
  KF_UNSUPPORTED_ENCODING = 6,
  KF_UNSUPPORTED_OPERATION = 7,
  KF_BUSY = 8,
  KF_CORE_ERROR = 9,
  KF_CANCELLED = 10,
  KF_TIMEOUT = 11,
  KF_STALE_HANDLE = 12,
  KF_CONFLICT = 13,
  KF_DENIED = 14,
  KF_NOT_FOUND = 15,
  KF_BUFFER_TOO_SMALL = 16,
  KF_WRONG_THREAD = 17
} kf_status;

#define KF_CAP_DISCOVERY (UINT64_C(1) << 0)
#define KF_CAP_STREAM (UINT64_C(1) << 1)
#define KF_CAP_LEDGER_ACTION (UINT64_C(1) << 2)
#define KF_CAP_MAINTENANCE (UINT64_C(1) << 3)
#define KF_CAP_CANCELLATION (UINT64_C(1) << 4)
#define KF_CAP_EXPLICIT_PROTOCOL_CURRENCY (UINT64_C(1) << 5)

/* Storage-service capabilities exposed by the ledger-action and maintenance
 * responsibility tables. Capability bits are scoped to the selected table. */
#define KF_STORAGE_CAP_EPISODE_LIFECYCLE (UINT64_C(1) << 0)
#define KF_STORAGE_CAP_HEAD_AND_HISTORICAL_QUERY (UINT64_C(1) << 1)
#define KF_STORAGE_CAP_FSCK (UINT64_C(1) << 2)
#define KF_STORAGE_CAP_EXPORT (UINT64_C(1) << 3)
#define KF_STORAGE_CAP_DOMAIN_FACT_ADMISSION (UINT64_C(1) << 4)
#define KF_STORAGE_CAP_TRUST_ASSESSMENT (UINT64_C(1) << 5)
#define KF_STORAGE_CAP_FACT_CUT_KERNEL (UINT64_C(1) << 6)
#define KF_STORAGE_CAP_EPISODE_RECOVERY (UINT64_C(1) << 7)
#define KF_STORAGE_CAP_IMPORT_AND_REBUILD (UINT64_C(1) << 8)
#define KF_STORAGE_CAP_BACKEND_LIFECYCLE (UINT64_C(1) << 9)
#define KF_STORAGE_CAP_FACT_LIBRARY (UINT64_C(1) << 10)

typedef struct kf_context_config_v1 {
  uint32_t struct_size;
  uint32_t flags;
  const char *runtime_dir;
  const char *stream_root;
  const char *host_namespace;
  const char *host_name;
  uint8_t mode;
  uint8_t reserved0[7];
  uint64_t default_timeout_ms;
  uint64_t reserved1[3];
} kf_context_config_v1;

/*
 * Protocol/schema/encoding strings are UTF-8 and NUL-terminated. `bytes` may
 * contain arbitrary data. The ABI never derives semantic identity from C
 * padding or a pointer value; the named protocol owns canonical Root bytes.
 */
typedef struct kf_semantic_message_v1 {
  uint32_t struct_size;
  uint32_t flags;
  const char *protocol_id;
  uint32_t protocol_version;
  uint32_t reserved0;
  const char *schema_ref;
  const char *encoding;
  const uint8_t *bytes;
  uint64_t byte_size;
} kf_semantic_message_v1;

/*
 * Result pointers are owned by the context and remain valid until the exact
 * token is returned to the producing interface's result_release function.
 * A context permits one outstanding result across discovery, ledger-action
 * and maintenance.
 */
typedef struct kf_owned_message_v1 {
  uint32_t struct_size;
  uint32_t flags;
  kf_semantic_message_v1 message;
  uint64_t token;
} kf_owned_message_v1;

typedef struct kf_runtime_info_v1 {
  uint32_t struct_size;
  uint32_t abi_version;
  uint64_t capabilities;
  const char *runtime_name;
  const char *runtime_version;
  const char *abi_contract;
  uint32_t interface_count;
  uint32_t reserved;
} kf_runtime_info_v1;

typedef struct kf_interface_info_v1 {
  uint32_t struct_size;
  uint32_t interface_id;
  uint32_t min_version;
  uint32_t max_version;
  uint64_t capabilities;
  const char *name;
} kf_interface_info_v1;

typedef struct kf_error_info_v1 {
  uint32_t struct_size;
  int32_t status;
  uint32_t retryable;
  const char *name;
  const char *meaning;
} kf_error_info_v1;

typedef int32_t(KF_CALL *kf_discovery_runtime_info_v1_fn)(kf_context *context, kf_runtime_info_v1 *out_info);
typedef int32_t(KF_CALL *kf_discovery_interface_info_v1_fn)(kf_context *context, uint32_t index,
                                                            kf_interface_info_v1 *out_info);
typedef int32_t(KF_CALL *kf_discovery_error_info_v1_fn)(kf_context *context, int32_t status,
                                                        kf_error_info_v1 *out_info);
typedef int32_t(KF_CALL *kf_discovery_contract_get_v1_fn)(kf_context *context, const kf_semantic_message_v1 *request,
                                                          kf_owned_message_v1 *out_result);
typedef int32_t(KF_CALL *kf_result_release_v1_fn)(kf_context *context, uint64_t token);

typedef struct kf_discovery_api_v1 {
  uint32_t abi_version;
  uint32_t struct_size;
  uint64_t capabilities;
  kf_discovery_runtime_info_v1_fn runtime_info;
  kf_discovery_interface_info_v1_fn interface_info;
  kf_discovery_error_info_v1_fn error_info;
  kf_discovery_contract_get_v1_fn contract_get;
  kf_result_release_v1_fn result_release;
} kf_discovery_api_v1;

typedef struct kf_stream_location_v1 {
  uint32_t struct_size;
  uint32_t dest_id;
  int64_t from_time;
  const char *namespace_name;
  const char *name;
  uint8_t mode;
  uint8_t role;
  uint8_t reserved[6];
} kf_stream_location_v1;

typedef struct kf_stream_frame_v1 {
  int64_t gen_time;
  int64_t trigger_time;
  uint64_t frame_uid;
  uint64_t trigger_frame_uid;
  uint64_t stream_id;
  uint32_t source;
  uint32_t initial_source;
  uint32_t dest;
  int32_t carrier_type;
  const uint8_t *data;
  uint32_t data_size;
  int8_t data_type;
  uint8_t reserved[3];
} kf_stream_frame_v1;

typedef struct kf_stream_batch_v1 {
  uint32_t struct_size;
  uint32_t frame_count;
  const kf_stream_frame_v1 *frames;
  uint64_t payload_bytes;
  uint64_t payload_bytes_copied;
  uint64_t token;
} kf_stream_batch_v1;

typedef int32_t(KF_CALL *kf_stream_reader_open_v1_fn)(kf_context *context, const kf_stream_location_v1 *location,
                                                      kf_stream_reader **out_reader);
typedef int32_t(KF_CALL *kf_stream_reader_read_v1_fn)(kf_stream_reader *reader, uint32_t max_frames,
                                                      kf_stream_batch_v1 *out_batch);
typedef int32_t(KF_CALL *kf_stream_reader_release_v1_fn)(kf_stream_reader *reader, uint64_t token);
typedef int32_t(KF_CALL *kf_stream_reader_close_v1_fn)(kf_stream_reader *reader);

typedef struct kf_stream_api_v1 {
  uint32_t abi_version;
  uint32_t struct_size;
  uint64_t capabilities;
  kf_stream_reader_open_v1_fn reader_open;
  kf_stream_reader_read_v1_fn reader_read;
  kf_stream_reader_release_v1_fn reader_release;
  kf_stream_reader_close_v1_fn reader_close;
} kf_stream_api_v1;

/*
 * ActionBinding is a derived immutable decision receipt, not an authority or a
 * fifth state primitive. Every root is required and must be a canonical
 * sha256:<64-lowercase-hex> value. A changed input requires a new binding.
 */
typedef struct kf_action_binding_config_v1 {
  uint32_t struct_size;
  uint32_t flags;
  const char *fact_cut_root;
  const char *pursuit_root;
  const char *atlas_root;
  const char *warrant_root;
  const char *candidate_action_root;
  const char *preconditions_root;
  const char *resources_root;
} kf_action_binding_config_v1;

typedef struct kf_action_binding_info_v1 {
  uint32_t struct_size;
  uint32_t flags;
  const char *binding_root;
  const char *fact_cut_root;
  const char *pursuit_root;
  const char *atlas_root;
  const char *warrant_root;
  const char *candidate_action_root;
  const char *preconditions_root;
  const char *resources_root;
} kf_action_binding_info_v1;

typedef enum kf_ledger_action_operation {
  KF_LEDGER_ACTION_FACT_KERNEL = 1,
  KF_LEDGER_ACTION_FACT_QUERY = 2,
  KF_LEDGER_ACTION_FACT_CONTRACT = 3,
  KF_LEDGER_ACTION_FACT_DECLARE_WORLD = 4,
  KF_LEDGER_ACTION_FACT_DECLARE_SURFACE = 5,
  KF_LEDGER_ACTION_FACT_OBSERVE = 6,
  KF_LEDGER_ACTION_FACT_STATE = 7,
  KF_LEDGER_ACTION_FACT_LIBRARY_CONTRACT = 8,
  KF_LEDGER_ACTION_FACT_TYPE_CREATE = 9,
  KF_LEDGER_ACTION_FACT_TYPE_LIST = 10,
  KF_LEDGER_ACTION_FACT_MATERIAL_PUT = 11,
  KF_LEDGER_ACTION_FACT_MATERIAL_LIST = 12,
  KF_LEDGER_ACTION_FACT_LIBRARY_EXPORT = 13,
  KF_LEDGER_ACTION_FACT_LIBRARY_IMPORT = 14,
  KF_LEDGER_ACTION_EPISODE_BEGIN = 16,
  KF_LEDGER_ACTION_EPISODE_HEARTBEAT = 17,
  KF_LEDGER_ACTION_EPISODE_END = 18,
  KF_LEDGER_ACTION_EPISODE_ABORT = 19,
  KF_LEDGER_ACTION_EPISODE_ATTACH_FRAME = 20,
  KF_LEDGER_ACTION_EPISODE_ATTACH_REF = 21,
  KF_LEDGER_ACTION_EPISODE_LIST = 22,
  KF_LEDGER_ACTION_EPISODE_INSPECT = 23,
  KF_LEDGER_ACTION_EPISODE_RECOVER = 24,
  KF_LEDGER_ACTION_EPISODE_RECOVERY_PLAN = 25,
  KF_LEDGER_ACTION_EPISODE_RECOVERY_EXECUTE = 26,
  KF_LEDGER_ACTION_AUTHORITY_EXPORT = 32,
  KF_LEDGER_ACTION_AUTHORITY_IMPORT = 33,
  KF_LEDGER_ACTION_ASSESSMENT_CONTRACT = 40,
  KF_LEDGER_ACTION_ASSESSMENT_REQUEST = 41,
  KF_LEDGER_ACTION_ASSESSMENT_EXECUTE = 42,
  KF_LEDGER_ACTION_ASSESSMENT_STATUS = 43,
  KF_LEDGER_ACTION_TRUST_REQUIRE = 44,
  KF_LEDGER_ACTION_ASSESSMENT_LIST = 45,
  KF_LEDGER_ACTION_ASSESSMENT_INVALIDATE = 46
} kf_ledger_action_operation;

typedef int32_t(KF_CALL *kf_action_binding_open_v1_fn)(kf_context *context, const kf_action_binding_config_v1 *config,
                                                       kf_action_binding **out_binding);
typedef int32_t(KF_CALL *kf_action_binding_info_v1_fn)(const kf_action_binding *binding,
                                                       kf_action_binding_info_v1 *out_info);
typedef int32_t(KF_CALL *kf_action_binding_close_v1_fn)(kf_action_binding *binding);
typedef int32_t(KF_CALL *kf_ledger_action_execute_v1_fn)(kf_context *context, const kf_action_binding *binding,
                                                         uint32_t operation, const kf_semantic_message_v1 *request,
                                                         kf_owned_message_v1 *out_result);

typedef struct kf_ledger_action_api_v1 {
  uint32_t abi_version;
  uint32_t struct_size;
  uint64_t capabilities;
  kf_action_binding_open_v1_fn binding_open;
  kf_action_binding_info_v1_fn binding_info;
  kf_action_binding_close_v1_fn binding_close;
  kf_ledger_action_execute_v1_fn execute;
  kf_result_release_v1_fn result_release;
} kf_ledger_action_api_v1;

typedef enum kf_maintenance_operation {
  KF_MAINTENANCE_STATUS = 1,
  KF_MAINTENANCE_FSCK = 2,
  KF_MAINTENANCE_REPAIR_PLAN = 3,
  KF_MAINTENANCE_REPAIR_APPLY = 4,
  KF_MAINTENANCE_GC_PLAN = 5,
  KF_MAINTENANCE_COMPACT_PLAN = 6,
  KF_MAINTENANCE_EXPORT = 7,
  KF_MAINTENANCE_IMPORT = 8,
  KF_MAINTENANCE_REBUILD_INDEX = 9,
  KF_MAINTENANCE_BACKEND_STATUS = 10,
  KF_MAINTENANCE_BACKEND_SWITCH = 11,
  KF_MAINTENANCE_BACKEND_ROLLBACK = 12,
  KF_MAINTENANCE_EPISODE_PROJECTION_REBUILD = 13
} kf_maintenance_operation;

typedef int32_t(KF_CALL *kf_maintenance_execute_v1_fn)(kf_context *context, uint32_t operation,
                                                       const kf_semantic_message_v1 *request,
                                                       kf_owned_message_v1 *out_result);

typedef struct kf_maintenance_api_v1 {
  uint32_t abi_version;
  uint32_t struct_size;
  uint64_t capabilities;
  kf_maintenance_execute_v1_fn execute;
  kf_result_release_v1_fn result_release;
} kf_maintenance_api_v1;

typedef int32_t(KF_CALL *kf_context_open_v1_fn)(const kf_context_config_v1 *config, kf_context **out_context);
typedef int32_t(KF_CALL *kf_context_capabilities_v1_fn)(const kf_context *context, uint64_t *out_capabilities);
typedef int32_t(KF_CALL *kf_context_last_error_v1_fn)(const kf_context *context, const char **out_data,
                                                      uint64_t *out_size);
typedef int32_t(KF_CALL *kf_context_request_cancel_v1_fn)(kf_context *context);
typedef int32_t(KF_CALL *kf_context_reset_cancel_v1_fn)(kf_context *context);
typedef int32_t(KF_CALL *kf_interface_get_v1_fn)(kf_context *context, uint32_t interface_id, uint32_t requested_version,
                                                 uint32_t caller_struct_size, void *out_interface);
typedef int32_t(KF_CALL *kf_context_close_v1_fn)(kf_context *context);

typedef struct kf_api_v1 {
  uint32_t abi_version;
  uint32_t struct_size;
  uint64_t capabilities;
  kf_context_open_v1_fn context_open;
  kf_context_capabilities_v1_fn context_capabilities;
  kf_context_last_error_v1_fn context_last_error;
  kf_context_request_cancel_v1_fn context_request_cancel;
  kf_context_reset_cancel_v1_fn context_reset_cancel;
  kf_interface_get_v1_fn interface_get;
  kf_context_close_v1_fn context_close;
} kf_api_v1;

/* The sole public libkungfu bootstrap. */
KF_API_EXPORT int32_t KF_CALL kungfu_get_api(uint32_t requested_version, uint32_t caller_struct_size, void *out_api);

#ifdef __cplusplus
}
#endif

#endif // KUNGFU_API_H
