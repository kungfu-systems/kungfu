// SPDX-License-Identifier: Apache-2.0

#pragma once

#include <cstdint>

extern "C" {

int32_t kungfu_get_api_internal(uint32_t requested_version, uint32_t caller_struct_size, void *out_api);
}
