// SPDX-License-Identifier: Apache-2.0

//
// Created by Keren Dong on 2019-06-04.
//

#ifndef KUNGFU_YIJINJING_OS_H
#define KUNGFU_YIJINJING_OS_H

#include <string>

#ifdef _WINDOWS
#define GETPID _getpid
#else
#include <unistd.h>
#define GETPID getpid
#endif

namespace kungfu::yijinjing::os {
/**
 * load mmap buffer, return address of the file-mapped memory
 * whether to write has to be specified in "is_writing"
 * buffer memory is locked if not lazy
 * @return the address of mapped memory
 */
uintptr_t load_mmap_buffer(const std::string &path, size_t size, bool is_writing = false, bool lazy = true);

bool flush_mmap_buffer(uintptr_t address, size_t size, bool lazy);

bool release_mmap_buffer(uintptr_t address, size_t size, bool lazy);

void disable_os_signals_handler();

void handle_os_signals(void *hero);

void reset_hero_instance();
} // namespace kungfu::yijinjing::os

#endif // KUNGFU_YIJINJING_OS_H
