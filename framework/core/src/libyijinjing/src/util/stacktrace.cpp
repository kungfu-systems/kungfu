// SPDX-License-Identifier: Apache-2.0

//
// Created by dkr on 8/30/2019.
//

#include <kungfu/common.h>
#include <kungfu/yijinjing/log.h>
#include <time.h>

#ifdef _WINDOWS

#include <kungfu/yijinjing/util/stacktrace.h>

#pragma comment(lib, "psapi.lib")
#pragma comment(lib, "dbghelp.lib")

#include "StackWalker.h"
#include <fstream>
#include <iostream>

#pragma warning(disable : 4996)

#else

#include <execinfo.h>
#include <fcntl.h>
#include <unistd.h>

#endif // _WINDOWS

namespace kungfu::yijinjing::util {

std::string get_default_error_log_dir() {
  char *kf_home = std::getenv("KF_HOME");
  if (kf_home != NULL) {
    std::string kf_path = kf_home;
    return (std::filesystem::path(kf_path) / "logview").string();
  }
  return ".";
}
static std::string error_log_dir = get_default_error_log_dir();

void set_error_log_dir(const std::string &path) { error_log_dir = path; }

#ifdef _WINDOWS

DWORD SehFiler(DWORD code) {
  switch (code) {
  case EXCEPTION_ACCESS_VIOLATION:
    KF_LOG_CRITICAL("Access violation,error code: {:#x}", code);
    break;
  case EXCEPTION_BREAKPOINT:
    KF_LOG_CRITICAL("Breakpoint,error code: {:#x}", code);
    break;
  case EXCEPTION_DATATYPE_MISALIGNMENT:
    KF_LOG_CRITICAL("Misaligned data,error code: {:#x}", code);
    break;
  case EXCEPTION_SINGLE_STEP:
    KF_LOG_CRITICAL("Single instruction,error code: {:#x}", code);
    break;
  case EXCEPTION_ARRAY_BOUNDS_EXCEEDED:
    KF_LOG_CRITICAL("Out of array bounds,error code: {:#x}", code);
    break;
  case EXCEPTION_FLT_DENORMAL_OPERAND:
    KF_LOG_CRITICAL("Denormalized floating-point value,error code: {:#x}", code);
    break;
  case EXCEPTION_FLT_DIVIDE_BY_ZERO:
    KF_LOG_CRITICAL("Floating point divide-by-zero,error code: {:#x}", code);
    break;
  case EXCEPTION_FLT_INEXACT_RESULT:
    KF_LOG_CRITICAL("Inexact floating point value,error code: {:#x}", code);
    break;
  case EXCEPTION_FLT_INVALID_OPERATION:
    KF_LOG_CRITICAL("Invalid floating point operation,error code: {:#x}", code);
    break;
  case EXCEPTION_FLT_OVERFLOW:
    KF_LOG_CRITICAL("Floating point overflow,error code: {:#x}", code);
    break;
  case EXCEPTION_FLT_STACK_CHECK:
    KF_LOG_CRITICAL("Floating point stack overflow,error code: {:#x}", code);
    break;
  case EXCEPTION_FLT_UNDERFLOW:
    KF_LOG_CRITICAL("Floating point underflow,error code: {:#x}", code);
    break;
  case EXCEPTION_INT_DIVIDE_BY_ZERO:
    KF_LOG_CRITICAL("Integer divide by zero,error code: {:#x}", code);
    break;
  case EXCEPTION_INT_OVERFLOW:
    KF_LOG_CRITICAL("Integer overflow,error code: {:#x}", code);
    break;
  case EXCEPTION_IN_PAGE_ERROR:
    KF_LOG_CRITICAL("Invalid page access,error code: {:#x}", code);
    break;
  case EXCEPTION_ILLEGAL_INSTRUCTION:
    KF_LOG_CRITICAL("Invalid instruction,error code: {:#x}", code);
    break;
  case EXCEPTION_STACK_OVERFLOW:
    KF_LOG_CRITICAL("Stack overflow,error code: {:#x}", code);
    break;
  case EXCEPTION_INVALID_HANDLE:
    KF_LOG_CRITICAL("Invalid handle,error code: {:#x}", code);
    break;
  default:
    if (code & (1 << 29)) {
      KF_LOG_CRITICAL("Custom exception,error code: {:#x}", code);
    } else {
      KF_LOG_CRITICAL("Unknown exception,error code: {:#x}", code);
    }
    break;
  }
  return EXCEPTION_EXECUTE_HANDLER;
}

// 如果是栈溢出类型的异常，会破坏SEH框架，导致SEH失效
DWORD print_stack_trace(EXCEPTION_POINTERS *ep) {
  KF_LOG_CRITICAL("Uncaught exception");
  // KF_LOG_CRITICAL("{}", home->locator->layout_file());

  // std::cout << "path--------->, " << home->locator->layout_file(home,kungfu::longfist::enums::layout::LOG,"123") <<"
  // \n";

  // ep->ExceptionRecord->ExceptionCode
  if (ep != nullptr) {
    SehFiler(ep->ExceptionRecord->ExceptionCode);
  }

  StackWalker sw;
  struct tm *cur_time = nullptr;
  time_t nowtime = time(nullptr);
  cur_time = std::localtime(&nowtime);
  char buf[128];
  strftime(buf, sizeof(buf), "hs_err_%Y_%m_%d_%H_%M_%S", cur_time);

  std::string path = error_log_dir + "/" + buf;

  std::ofstream log_file;
  log_file.open(path, std::ios::in | std::ios::out | std::ios::trunc);
  if (!log_file.is_open()) {
    KF_LOG_CRITICAL("# Can not save log file, dump to screen...");
  }
  if (ep != nullptr) {
    sw.show_callstack(log_file, ep->ContextRecord);
  } else {
    sw.show_callstack(log_file, nullptr);
  }

  if (log_file.is_open()) {
    KF_LOG_CRITICAL("# An error report file with more information is saved as:  {}", path);
  }

  log_file.close();

  return EXCEPTION_EXECUTE_HANDLER;
}

#else

namespace {
// Async-signal-safe primitives: no malloc, no stdio, no locale. These are the
// only building blocks used from inside the crash handler.

constexpr unsigned KF_MAX_FRAMES = 512;
// Preallocated in BSS so the handler never touches the allocator.
void *kf_crash_addrlist[KF_MAX_FRAMES];
char kf_crash_pathbuf[1024];

// Append a NUL-terminated string, bounded by cap; returns the new length.
size_t as_put_str(char *buf, size_t cap, size_t pos, const char *s) {
  while (*s != '\0' && pos < cap - 1) {
    buf[pos++] = *s++;
  }
  buf[pos] = '\0';
  return pos;
}

// Append an unsigned decimal; snprintf is not async-signal-safe, so hand-roll it.
size_t as_put_uint(char *buf, size_t cap, size_t pos, unsigned long v) {
  char tmp[24];
  int i = 0;
  if (v == 0) {
    tmp[i++] = '0';
  }
  while (v > 0 && i < static_cast<int>(sizeof(tmp))) {
    tmp[i++] = static_cast<char>('0' + (v % 10));
    v /= 10;
  }
  while (i > 0 && pos < cap - 1) {
    buf[pos++] = tmp[--i];
  }
  buf[pos] = '\0';
  return pos;
}

// write(2) is async-signal-safe; use it for every literal we emit.
void as_write(int fd, const char *s) {
  if (fd < 0) {
    return;
  }
  size_t n = 0;
  while (s[n] != '\0') {
    n++;
  }
  ssize_t rc = write(fd, s, n);
  static_cast<void>(rc);
}
} // namespace

// Async-signal-safe crash stack dump.
//
// Writes "module(mangled_symbol+offset) [address]" for each frame to a
// preallocated log file and to the console fd, using only async-signal-safe
// calls. Symbol names stay mangled on purpose: abi::__cxa_demangle() calls
// malloc and is not async-signal-safe, so demangle offline with c++filt. This
// keeps the dump reliable even after heap corruption, which is exactly the case
// where the previous malloc/stdio/localtime path deadlocked or double-faulted.
void print_stack_trace(FILE *out, int signum) {
  int console_fd = (out != nullptr) ? fileno(out) : STDERR_FILENO;

  // Build "<dir>/hs_err_pid<pid>_<epoch>.log" with async-signal-safe calls only.
  // error_log_dir is resolved at startup; c_str() does not allocate.
  size_t pos = 0;
  pos = as_put_str(kf_crash_pathbuf, sizeof(kf_crash_pathbuf), pos, error_log_dir.c_str());
  pos = as_put_str(kf_crash_pathbuf, sizeof(kf_crash_pathbuf), pos, "/hs_err_pid");
  pos = as_put_uint(kf_crash_pathbuf, sizeof(kf_crash_pathbuf), pos, static_cast<unsigned long>(getpid()));
  pos = as_put_str(kf_crash_pathbuf, sizeof(kf_crash_pathbuf), pos, "_");
  pos = as_put_uint(kf_crash_pathbuf, sizeof(kf_crash_pathbuf), pos, static_cast<unsigned long>(time(nullptr)));
  as_put_str(kf_crash_pathbuf, sizeof(kf_crash_pathbuf), pos, ".log");

  int log_fd = open(kf_crash_pathbuf, O_CREAT | O_WRONLY | O_APPEND, 0644);

  // signum == 0 means this was called from a normal catch-block, not a signal.
  char head[64];
  size_t hp = as_put_str(head, sizeof(head), 0, "\n----- kungfu native stack");
  if (signum != 0) {
    hp = as_put_str(head, sizeof(head), hp, " (signal ");
    hp = as_put_uint(head, sizeof(head), hp, static_cast<unsigned long>(signum));
    hp = as_put_str(head, sizeof(head), hp, ")");
  }
  as_put_str(head, sizeof(head), hp, " -----\n");
  as_write(console_fd, head);
  as_write(log_fd, head);

  int addrlen = backtrace(kf_crash_addrlist, KF_MAX_FRAMES);
  // Skip the first two frames: this function and the signal trampoline.
  int skip = addrlen > 2 ? 2 : 0;
  // backtrace_symbols_fd() writes directly to the fd and does NOT allocate.
  backtrace_symbols_fd(kf_crash_addrlist + skip, addrlen - skip, console_fd);
  if (log_fd >= 0) {
    backtrace_symbols_fd(kf_crash_addrlist + skip, addrlen - skip, log_fd);
    as_write(log_fd, "----- end (demangle names with c++filt) -----\n");
    as_write(console_fd, "# crash report saved: ");
    as_write(console_fd, kf_crash_pathbuf);
    as_write(console_fd, "\n");
    close(log_fd);
  } else {
    as_write(console_fd, "# could not open crash report file; dumped to console only\n");
  }
}

// See header: forces the lazy dynamic-linker resolution behind backtrace() so
// the in-handler call never hits dlopen/malloc.
void prepare_stack_trace() {
  void *probe[4];
  int n = backtrace(probe, 4);
  int devnull = open("/dev/null", O_WRONLY);
  if (devnull >= 0) {
    backtrace_symbols_fd(probe, n, devnull);
    close(devnull);
  }
}
#endif // _WINDOWS
} // namespace kungfu::yijinjing::util
