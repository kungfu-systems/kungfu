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

#ifdef _WINDOWS

DWORD print_stack_trace(EXCEPTION_POINTERS *ep = nullptr);

// DWORD print_stack_trace(EXCEPTION_POINTERS *ep = nullptr);

#else

void print_stack_trace(FILE *out = stderr);

// void print_stack_trace(FILE *out = stderr);

#endif // _WINDOWS
} // namespace kungfu::yijinjing::util

#endif // KUNGFU_STACKTRACE_H
