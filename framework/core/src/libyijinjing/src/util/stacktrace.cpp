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

#include <cerrno>
#include <cxxabi.h>
#include <execinfo.h>
#include <sys/time.h>

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

void print_stack_trace(FILE *out) {
  unsigned int max_frames = 511;
  // storage array for stack trace address data
  void *addrlist[max_frames + 1];
  char buf[64];

  int console_count = 10;

  struct timeval time_val;
  struct tm *cur_time;
  gettimeofday(&time_val, NULL);
  cur_time = localtime(&(time_val.tv_sec));

  // char path[256] = "./";                        //C:\Users\KungfuDeveloper\AppData\Roaming\kungfu\home\logview
  // 输出格式为: 2022_07_28_20_38_37
  strftime(buf, sizeof(buf), "hs_err_%Y_%m_%d_%H_%M_%S.log", cur_time);

  std::string path = error_log_dir + "/" + buf;
  // strcat(path,buf);
  FILE *log_file = fopen(path.c_str(), "a+");

  if (log_file == NULL) {
    KF_LOG_CRITICAL("# Can not save log file, dump to screen... ");
  }

  fprintf(log_file, "-------------------------Native Stack--------------------------\n");
  // retrieve current stack addresses 返回addrlist的存在的条目数量（存放的是每一级函数被调用函数的返回地址）
  unsigned int addrlen = backtrace(addrlist, sizeof(addrlist) / sizeof(void *));

  if (addrlen == 0) {
    fprintf(out, "  \n");
    return;
  }
  // resolve addresses into strings containing "filename(function+address)",
  // Actually it will be ## program address function + offset
  // this array must be free()-ed 将每一个返回地址转换成”函数名+函数内偏移量+函数返回值”
  // symbollists是在backtrace_symbols申请的内存，所以最后必须free掉
  char **symbollist = backtrace_symbols(addrlist, addrlen);

  // iterate over the returned symbol lines. skip the first, it is the
  // address of this function.
  for (unsigned int i = 3; i < addrlen; i++) { // 前三项通常是捕获函数，包括信号捕获处理函数等
    char *begin_name = nullptr;
    char *begin_offset = nullptr;
    char *end_offset = nullptr;

    // find parentheses and +address offset surrounding the mangled name
#ifdef __APPLE__
    // OSX style stack trace
    for (char *p = symbollist[i]; *p; ++p) {
      if ((*p == '_') && (*(p - 1) == ' '))
        begin_name = p - 1;
      else if (*p == '+')
        begin_offset = p - 1;
    }
    if (begin_name && begin_offset && (begin_name < begin_offset)) {
      *begin_name++ = '\0';
      *begin_offset++ = '\0';

      // mangled name is now in [begin_name, begin_offset) and caller
      // offset in [begin_offset, end_offset). now apply
      // __cxa_demangle():
      int status;
      size_t funcnamesize = 8192;
      char funcname[8192];
      char *ret = abi::__cxa_demangle(begin_name, &funcname[0], &funcnamesize, &status);
      KF_LOG_CRITICAL(" {:<30} {:<40} {}", symbollist[i], status == 0 ? ret : begin_name, begin_offset);
      fprintf(log_file, "%s  %s  %s\n", symbollist[i], status == 0 ? ret : begin_name, begin_offset);
#else  // !__APPLE__ - but is posix
       // not OSX style
       // ./module(function+0x15c) [0x8048a6d] <-- format
    for (char *p = symbollist[i]; *p; ++p) {
      if (*p == '(')
        begin_name = p;
      else if (*p == '+')
        begin_offset = p;
      else if (*p == ')' && (begin_offset || begin_name))
        end_offset = p;
    }
    // printf("%c,%c,%c\n",*begin_name++,*begin_offset++,*end_offset++);
    // printf("%c,%c,%c\n",*begin_name,*begin_offset,*end_offset);
    // 可能会出现（+0x49） [0x7f4111]的格式
    char *ptr = begin_name;
    if (begin_name && end_offset && *(++ptr) != '+') {
      // if (begin_name && end_offset && (begin_name > end_offset)) {
      *begin_name++ = '\0';
      *end_offset++ = '\0';
      if (begin_offset)
        *begin_offset++ = '\0';
      // mangled name is now in [begin_name, begin_offset) and caller
      // offset in [begin_offset, end_offset). now apply
      // __cxa_demangle():
      int status = 0;
      size_t funcnamesize = 8192;
      auto funcname = reinterpret_cast<char *>(std::malloc(funcnamesize));
      char *ret = abi::__cxa_demangle(begin_name, funcname, &funcnamesize, &status);
      if (console_count >= 0) {
        KF_LOG_CRITICAL("{:<30} ({:<40}+{}) {}", symbollist[i], status == 0 ? ret : begin_name,
                        begin_offset ? begin_offset : "", end_offset);
        console_count--;
      }
      fprintf(log_file, "[%s] \t(%s+%s)  %s\n", symbollist[i], status == 0 ? ret : begin_name,
              begin_offset ? begin_offset : "", end_offset);
      fflush(log_file);
      std::free(ret);
#endif // !DARWIN - but is posix
    } else {
      // couldn't parse the line? print the whole line.
      if (console_count >= 0) {
        KF_LOG_CRITICAL("{}", symbollist[i]);
        console_count--;
      }
      fprintf(log_file, "%s\n", symbollist[i]);
      fflush(log_file);
    }
  }
  if (log_file != NULL) {
    KF_LOG_CRITICAL("# An error report file with more information is saved as:  {}", path);
  }
  fclose(log_file);
  free(symbollist);
}
#endif // _WINDOWS
} // namespace kungfu::yijinjing::util
