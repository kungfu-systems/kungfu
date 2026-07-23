// SPDX-License-Identifier: Apache-2.0

#include "abi_internal.h"

#include <kungfu/api.h>

extern "C" KF_API_EXPORT int32_t KF_CALL kungfu_get_api(uint32_t requested_version, uint32_t caller_struct_size,
                                                        void *out_api) {
  return kungfu_get_api_internal(requested_version, caller_struct_size, out_api);
}
