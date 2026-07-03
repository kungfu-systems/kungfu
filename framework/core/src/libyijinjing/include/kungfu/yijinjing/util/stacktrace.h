// SPDX-License-Identifier: Apache-2.0

//
// Created by dkr on 8/27/2019.
//

#ifndef KUNGFU_STACKTRACE_H
#define KUNGFU_STACKTRACE_H

#include <kungfu/common.h>

#ifdef _WINDOWS
#include <Psapi.h>
#include <Windows.h>
#include <cstdio>
#endif // _WINDOWS
namespace kungfu::yijinjing::util {

void set_error_log_dir(const std::string &path);

// One-time, non-signal-context warm-up for the crash dump path. Call once when
// signal / SEH handlers are installed, never from inside a handler. On POSIX it
// forces the lazy dynamic-linker resolution behind backtrace() so the in-handler
// call stays async-signal-safe; on Windows it pre-initializes dbghelp so the SEH
// filter only performs symbol lookups, not heap-heavy initialization.
void prepare_stack_trace();

#ifdef _WINDOWS

DWORD print_stack_trace(EXCEPTION_POINTERS *ep = nullptr);

#else

void print_stack_trace(FILE *out = stderr, int signum = 0);

#endif // _WINDOWS
} // namespace kungfu::yijinjing::util

#endif // KUNGFU_STACKTRACE_H
