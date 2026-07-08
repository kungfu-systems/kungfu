// SPDX-License-Identifier: Apache-2.0

#ifndef KUNGFU_YIJINJING_PLATFORM_MMAP_H
#define KUNGFU_YIJINJING_PLATFORM_MMAP_H

#include <string>

namespace kungfu::yijinjing::platform {
/**
 * load mmap buffer, return address of the file-mapped memory
 * whether to write has to be specified in "is_writing"
 * buffer memory is locked if not lazy
 * @return the address of mapped memory
 */
uintptr_t load_mmap_buffer(const std::string &path, size_t size, bool is_writing = false, bool lazy = true);

bool flush_mmap_buffer(uintptr_t address, size_t size, bool lazy);

bool release_mmap_buffer(uintptr_t address, size_t size, bool lazy);
} // namespace kungfu::yijinjing::platform

#endif // KUNGFU_YIJINJING_PLATFORM_MMAP_H
