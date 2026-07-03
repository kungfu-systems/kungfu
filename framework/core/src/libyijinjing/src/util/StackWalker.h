// SPDX-License-Identifier: Apache-2.0

//
// Windows crash-report stack walker for yijinjing.
//
// This is a lean, architecture-neutral replacement for the previously vendored
// StackWalker library (BSD, Jochen Kalmbach). Only the single entry point used
// by the rest of the codebase -- show_callstack() -- is exposed; symbol lookup
// and stack unwinding are delegated to the modern DbgHelp / RtlCaptureStackBackTrace
// APIs rather than a hand-rolled frame walk.
//

#ifndef KUNGFU_UTIL_STACKWALKER_H
#define KUNGFU_UTIL_STACKWALKER_H

#if defined(_MSC_VER)

#include <ostream>

namespace kungfu::yijinjing::util {

class StackWalker {
public:
  StackWalker() = default;

  // Write a crash report (OS version, CPU, environment, loaded modules, stack
  // bounds and a symbolized native stack) to `os`.
  //
  // `context` is an optional pointer to a CONTEXT record, passed as void* to
  // keep this header free of <windows.h>:
  //   - nullptr : capture and walk the current thread stack.
  //   - non-null: unwind from the given (e.g. exception) context.
  void show_callstack(std::ostream &os, const void *context = nullptr);

private:
  void print_windows_version(std::ostream &st);
  void print_cpu_info(std::ostream &st);
  void print_environment_variables(std::ostream &st);
  void print_loaded_modules(std::ostream &st);
  void print_stack_bound(std::ostream &st);
  void print_native_stack(std::ostream &st, const void *context);
};

} // namespace kungfu::yijinjing::util

#endif // defined(_MSC_VER)

#endif // KUNGFU_UTIL_STACKWALKER_H
