// SPDX-License-Identifier: Apache-2.0

#ifndef KUNGFU_INITIATIVE_ASSIGNMENT_API_H
#define KUNGFU_INITIATIVE_ASSIGNMENT_API_H

#include <kungfu/api.h>

#ifdef __cplusplus
extern "C" {
#endif

#define KF_INTERFACE_INITIATIVE_ASSIGNMENT UINT32_C(6)
#define KF_INITIATIVE_ASSIGNMENT_ABI_V1 UINT32_C(1)
#define KF_CAP_INITIATIVE_ASSIGNMENT (UINT64_C(1) << 7)

#define KF_PROTOCOL_INITIATIVE_ASSIGNMENT_NATIVE "kungfu.initiative-assignment.native-service"
#define KF_SCHEMA_INITIATIVE_ASSIGNMENT_REQUEST_V1 "kungfu.initiative-assignment.native-service.request/v1"
#define KF_SCHEMA_INITIATIVE_ASSIGNMENT_RESULT_V1 "kungfu.initiative-assignment.native-service.result/v1"

typedef enum kf_initiative_assignment_operation {
  KF_INITIATIVE_ASSIGNMENT_CONTRACT = 1,
  KF_INITIATIVE_ASSIGNMENT_COMPUTE_ROOT = 2,
  KF_INITIATIVE_ASSIGNMENT_ADMIT = 3,
  KF_INITIATIVE_ASSIGNMENT_REPLAY = 4
} kf_initiative_assignment_operation;

typedef int32_t(KF_CALL *kf_initiative_assignment_execute_v1_fn)(kf_context *context, uint32_t operation,
                                                                 const kf_semantic_message_v1 *request,
                                                                 kf_owned_message_v1 *out_result);

typedef struct kf_initiative_assignment_api_v1 {
  uint32_t abi_version;
  uint32_t struct_size;
  uint64_t capabilities;
  kf_initiative_assignment_execute_v1_fn execute;
  kf_result_release_v1_fn result_release;
} kf_initiative_assignment_api_v1;

#ifdef __cplusplus
}
#endif

#endif // KUNGFU_INITIATIVE_ASSIGNMENT_API_H
