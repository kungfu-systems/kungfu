// SPDX-License-Identifier: Apache-2.0

#ifndef KUNGFU_RUNTIME_OS_H
#define KUNGFU_RUNTIME_OS_H

#include <cstdint>

#ifdef _WIN32
#include <process.h>
#define GETPID _getpid
#else
#include <unistd.h>
#define GETPID getpid
#endif

namespace kungfu::runtime::os {
[[nodiscard]] bool is_process_alive(int32_t pid);

void disable_os_signals_handler();

void handle_os_signals(void *reactor);

void reset_reactor_instance();
} // namespace kungfu::runtime::os

#endif // KUNGFU_RUNTIME_OS_H
