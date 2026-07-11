// SPDX-License-Identifier: Apache-2.0

#ifndef KUNGFU_RUNTIME_UTIL_STACKTRACE_H
#define KUNGFU_RUNTIME_UTIL_STACKTRACE_H

#include <kungfu/common.h>

#ifdef _WIN32
#include <Psapi.h>
#include <Windows.h>
#include <cstdio>
#endif // _WIN32

namespace kungfu::runtime::util {
void set_error_log_dir(const std::string &path);

// One-time, non-signal-context warm-up for the crash dump path. Call once when
// signal / SEH handlers are installed, never from inside a handler.
void prepare_stack_trace();

#ifdef _WIN32

DWORD print_stack_trace(EXCEPTION_POINTERS *ep = nullptr);

#else

void print_stack_trace(FILE *out = stderr, int signum = 0);

#endif // _WIN32
} // namespace kungfu::runtime::util

#endif // KUNGFU_RUNTIME_UTIL_STACKTRACE_H
