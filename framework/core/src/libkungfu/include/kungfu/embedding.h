// SPDX-License-Identifier: Apache-2.0

#ifndef KUNGFU_EMBEDDING_H
#define KUNGFU_EMBEDDING_H

#include <stddef.h>
#include <stdint.h>

#if defined(_WIN32)
#define KF_EMBEDDING_CALL __cdecl
#if defined(KF_EMBEDDING_BUILD_SHARED)
#define KF_EMBEDDING_EXPORT __declspec(dllexport)
#elif defined(KF_EMBEDDING_USE_SHARED)
#define KF_EMBEDDING_EXPORT __declspec(dllimport)
#else
#define KF_EMBEDDING_EXPORT
#endif
#elif defined(__GNUC__) || defined(__clang__)
#define KF_EMBEDDING_CALL
#define KF_EMBEDDING_EXPORT __attribute__((visibility("default")))
#else
#define KF_EMBEDDING_CALL
#define KF_EMBEDDING_EXPORT
#endif

#ifdef __cplusplus
extern "C" {
#endif

#define KF_EMBEDDING_ABI_V1 UINT32_C(1)
#define KF_EMBEDDING_ABI_V2 UINT32_C(2)
#define KF_EMBEDDING_MAX_BATCH_FRAMES UINT32_C(4096)
#define KF_EMBEDDING_CONTEXT_LOW_LATENCY UINT32_C(1)

/* Handles are single-thread-affine in v1; callers must serialize access. */

typedef struct kf_embedding_context kf_embedding_context;
typedef struct kf_embedding_reader kf_embedding_reader;

typedef enum kf_embedding_status {
  KF_EMBEDDING_OK = 0,
  KF_EMBEDDING_INVALID_ARGUMENT = 1,
  KF_EMBEDDING_UNSUPPORTED_VERSION = 2,
  KF_EMBEDDING_BUSY = 3,
  KF_EMBEDDING_CORE_ERROR = 4
} kf_embedding_status;

#define KF_EMBEDDING_CAP_READ_JOURNAL_BATCH (UINT64_C(1) << 0)
#define KF_EMBEDDING_CAP_MMAP_PAYLOAD_VIEW (UINT64_C(1) << 1)
/* v2: read-only substrate diagnostics (fsck) reachable without booting CPython. */
#define KF_EMBEDDING_CAP_STORAGE_DIAGNOSTICS (UINT64_C(1) << 2)

typedef enum kf_embedding_mode {
  KF_EMBEDDING_MODE_LIVE = 0,
  KF_EMBEDDING_MODE_DATA = 1,
  KF_EMBEDDING_MODE_REPLAY = 2,
  KF_EMBEDDING_MODE_BACKTEST = 3
} kf_embedding_mode;

typedef enum kf_embedding_location_role {
  KF_EMBEDDING_ROLE_SOURCE = 0,
  KF_EMBEDDING_ROLE_SINK = 1,
  KF_EMBEDDING_ROLE_ACTOR = 2,
  KF_EMBEDDING_ROLE_SYSTEM = 3,
  KF_EMBEDDING_ROLE_SERVICE = 4
} kf_embedding_location_role;

typedef struct kf_embedding_context_config_v1 {
  uint32_t struct_size;
  uint32_t flags;
  const char *root;
  const char *host_namespace;
  const char *host_name;
  uint8_t mode;
  uint8_t reserved[7];
} kf_embedding_context_config_v1;

typedef struct kf_embedding_location_v1 {
  uint32_t struct_size;
  uint32_t dest_id;
  int64_t from_time;
  const char *namespace_name;
  const char *name;
  uint8_t mode;
  uint8_t role;
  uint8_t reserved[6];
} kf_embedding_location_v1;

typedef struct kf_embedding_frame_v1 {
  int64_t gen_time;
  int64_t trigger_time;
  uint64_t frame_uid;
  uint64_t trigger_frame_uid;
  uint64_t stream_id;
  uint32_t source;
  uint32_t initial_source;
  uint32_t dest;
  int32_t msg_type;
  const uint8_t *data;
  uint32_t data_size;
  int8_t data_type;
  uint8_t reserved[3];
} kf_embedding_frame_v1;

/*
 * Frame payload pointers borrow mmap-backed pages owned by the reader. They
 * remain valid only until release_batch(reader, token). No payload bytes are
 * copied by read_batch; metadata is copied into the frame-view array.
 */
typedef struct kf_embedding_batch_v1 {
  uint32_t struct_size;
  uint32_t frame_count;
  const kf_embedding_frame_v1 *frames;
  uint64_t payload_bytes;
  uint64_t payload_bytes_copied;
  uint64_t token;
} kf_embedding_batch_v1;

/*
 * v2 read-only substrate-diagnostic surface. `storage_fsck` bridges to the C++
 * `storage_service::fsck` (native, no CPython) and returns the report as a JSON
 * byte blob (`render_storage_fsck_result(...).dump()`), plus the `ok`/`degraded`
 * verdict as typed bytes so callers can decide an exit code without parsing JSON.
 * The blob and its backing store are owned by the call; the caller must return
 * them with `report_release`. This keeps the contract face narrow: growing the
 * diagnostic surface adds JSON fields, not C ABI structs.
 */
typedef enum kf_embedding_storage_fsck_scope {
  KF_EMBEDDING_FSCK_SCOPE_ALL = 0,
  KF_EMBEDDING_FSCK_SCOPE_SOURCE = 1,
  KF_EMBEDDING_FSCK_SCOPE_EPISODE = 2
} kf_embedding_storage_fsck_scope;

typedef struct kf_embedding_storage_fsck_request_v1 {
  uint32_t struct_size;
  uint32_t scope; /* kf_embedding_storage_fsck_scope */
  const char *runtime_dir;
  const char *provider;               /* nullable */
  const char *provider_config_source; /* nullable */
  const char *source_id;              /* nullable; used for Source/Episode scope */
  uint64_t episode_id;                /* used for Episode scope */
  uint32_t verify_frames;             /* bool 0/1 */
  uint32_t reserved;
} kf_embedding_storage_fsck_request_v1;

#define KF_EMBEDDING_REPORT_FORMAT_JSON UINT32_C(1)

typedef struct kf_embedding_report_v1 {
  uint32_t struct_size;
  uint32_t format; /* KF_EMBEDDING_REPORT_FORMAT_JSON */
  uint8_t ok;
  uint8_t degraded;
  uint8_t reserved0[2];
  const uint8_t *data; /* owned report bytes, valid until report_release */
  uint64_t data_size;
  void *owner; /* opaque; report_release frees this */
} kf_embedding_report_v1;

typedef int32_t(KF_EMBEDDING_CALL *kf_embedding_context_open_v1_fn)(const kf_embedding_context_config_v1 *config,
                                                                    kf_embedding_context **out_context);
typedef int32_t(KF_EMBEDDING_CALL *kf_embedding_context_capabilities_v1_fn)(const kf_embedding_context *context,
                                                                            uint64_t *out_capabilities);
typedef int32_t(KF_EMBEDDING_CALL *kf_embedding_context_close_v1_fn)(kf_embedding_context *context);
typedef int32_t(KF_EMBEDDING_CALL *kf_embedding_reader_open_v1_fn)(kf_embedding_context *context,
                                                                   const kf_embedding_location_v1 *location,
                                                                   kf_embedding_reader **out_reader);
typedef int32_t(KF_EMBEDDING_CALL *kf_embedding_reader_read_batch_v1_fn)(kf_embedding_reader *reader,
                                                                         uint32_t max_frames,
                                                                         kf_embedding_batch_v1 *out_batch);
typedef int32_t(KF_EMBEDDING_CALL *kf_embedding_reader_release_batch_v1_fn)(kf_embedding_reader *reader,
                                                                            uint64_t token);
typedef int32_t(KF_EMBEDDING_CALL *kf_embedding_reader_close_v1_fn)(kf_embedding_reader *reader);
typedef int32_t(KF_EMBEDDING_CALL *kf_embedding_storage_fsck_v1_fn)(kf_embedding_context *context,
                                                                    const kf_embedding_storage_fsck_request_v1 *request,
                                                                    kf_embedding_report_v1 *out_report);
typedef int32_t(KF_EMBEDDING_CALL *kf_embedding_report_release_v1_fn)(kf_embedding_report_v1 *report);

typedef struct kf_embedding_api_v1 {
  uint32_t abi_version;
  uint32_t struct_size;
  uint64_t capabilities;
  kf_embedding_context_open_v1_fn context_open;
  kf_embedding_context_capabilities_v1_fn context_capabilities;
  kf_embedding_context_close_v1_fn context_close;
  kf_embedding_reader_open_v1_fn reader_open;
  kf_embedding_reader_read_batch_v1_fn reader_read_batch;
  kf_embedding_reader_release_batch_v1_fn reader_release_batch;
  kf_embedding_reader_close_v1_fn reader_close;
} kf_embedding_api_v1;

/*
 * v2 appends the diagnostic pointers after a byte-identical v1 prefix, so a v2
 * table can be read as a v1 table. Growth is version-gated: the bootstrap fills
 * the table matching `requested_version`, and `caller_struct_size` guards the
 * copy. A v1-only caller keeps working unchanged against a v2 core.
 */
typedef struct kf_embedding_api_v2 {
  uint32_t abi_version;
  uint32_t struct_size;
  uint64_t capabilities;
  kf_embedding_context_open_v1_fn context_open;
  kf_embedding_context_capabilities_v1_fn context_capabilities;
  kf_embedding_context_close_v1_fn context_close;
  kf_embedding_reader_open_v1_fn reader_open;
  kf_embedding_reader_read_batch_v1_fn reader_read_batch;
  kf_embedding_reader_release_batch_v1_fn reader_release_batch;
  kf_embedding_reader_close_v1_fn reader_close;
  kf_embedding_storage_fsck_v1_fn storage_fsck;
  kf_embedding_report_release_v1_fn report_release;
} kf_embedding_api_v2;

/*
 * The only link-visible bootstrap. All versioned operations live in the table.
 * `out_api` points at a caller-owned `kf_embedding_api_v{requested_version}`;
 * `caller_struct_size` must be at least the size of that versioned table.
 */
KF_EMBEDDING_EXPORT int32_t KF_EMBEDDING_CALL kungfu_embedding_get_api(uint32_t requested_version,
                                                                       uint32_t caller_struct_size, void *out_api);

#ifdef __cplusplus
}
#endif

#endif // KUNGFU_EMBEDDING_H
