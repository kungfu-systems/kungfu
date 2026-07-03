// SPDX-License-Identifier: Apache-2.0

//
// Created by dkr on 8/30/2019.
//

#include <kungfu/common.h>
#include <time.h>

#ifdef _WINDOWS

#include <kungfu/yijinjing/util/stacktrace.h>

#pragma comment(lib, "psapi.lib")
#pragma comment(lib, "dbghelp.lib")

#include "StackWalker.h"
#include <DbgHelp.h>
#include <cstring>
#include <ostream>
#include <streambuf>

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

namespace {
// Crash-path helpers. On Windows the crash arrives via an SEH __except filter
// (hero.cpp) or the top-level unhandled-exception filter (signal.cpp), not POSIX
// signals, but the same hazard applies: the faulting thread may already hold the
// spdlog, CRT stdio, or C locale lock. So the crash path must avoid KF_LOG_*
// (spdlog), std::ofstream / stdio, std::localtime and heap-heavy std::string
// building; it uses Win32 primitives (CreateFileA / WriteFile / GetLocalTime)
// and preallocated buffers instead.
//
// Accepted residual risk: DbgHelp (Sym*) uses the heap and StackWalker's
// std::ostream formatting touches locale facets, so this is hardening, not a
// strict async-signal-safe guarantee. W-B (below) additionally writes a minidump
// so most heap-corruption crashes still yield a symbolizable artifact offline,
// but both the text walk and the in-process minidump can still be defeated by
// extreme heap corruption or a stack overflow. The out-of-process dumper (W-C)
// that would remove that residual was evaluated and declined for its permanent
// maintenance cost; the residual tiers are documented in
// docs/windows-crash-symbols.md.

// Preallocated crash-report path buffers; never built with std::string in-handler.
char kf_crash_pathbuf[1024];     // text hs_err_*.log (W-A)
char kf_dump_pathbuf[1024];      // minidump hs_err_*.dmp (W-B), same pid/timestamp
char kf_dumppart_pathbuf[1024];  // ".part" sibling the dump is written to first

// Minimal WriteFile-backed streambuf so StackWalker can keep writing to a
// std::ostream while bypassing the CRT stdio file lock the faulting thread might
// hold. INVALID_HANDLE_VALUE turns it into a null sink (used for warm-up).
class handle_streambuf : public std::streambuf {
public:
  explicit handle_streambuf(HANDLE h) : h_(h) {}

protected:
  std::streamsize xsputn(const char *s, std::streamsize n) override {
    if (h_ != INVALID_HANDLE_VALUE && n > 0) {
      DWORD wrote = 0;
      WriteFile(h_, s, static_cast<DWORD>(n), &wrote, nullptr);
    }
    return n;
  }
  int overflow(int c) override {
    if (c != EOF && h_ != INVALID_HANDLE_VALUE) {
      char ch = static_cast<char>(c);
      DWORD wrote = 0;
      WriteFile(h_, &ch, 1, &wrote, nullptr);
    }
    return c;
  }

private:
  HANDLE h_;
};

// Append a NUL-terminated string to a fixed buffer; no allocation.
size_t as_put_str(char *buf, size_t cap, size_t pos, const char *s) {
  while (*s != '\0' && pos < cap - 1) {
    buf[pos++] = *s++;
  }
  buf[pos] = '\0';
  return pos;
}

// Append an unsigned decimal; snprintf is not crash-path-safe, so hand-roll it.
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

// Append a zero-padded 2-digit value (date/time components).
size_t as_put_uint2(char *buf, size_t cap, size_t pos, unsigned v) {
  if (pos + 2 < cap) {
    buf[pos++] = static_cast<char>('0' + (v / 10) % 10);
    buf[pos++] = static_cast<char>('0' + v % 10);
  }
  buf[pos] = '\0';
  return pos;
}

// Statically-allocated human-readable description of an SEH exception code.
// Returns a string literal, so it is safe to use from the crash path.
const char *seh_exception_text(DWORD code) {
  switch (code) {
  case EXCEPTION_ACCESS_VIOLATION:
    return "Access violation";
  case EXCEPTION_BREAKPOINT:
    return "Breakpoint";
  case EXCEPTION_DATATYPE_MISALIGNMENT:
    return "Misaligned data";
  case EXCEPTION_SINGLE_STEP:
    return "Single step";
  case EXCEPTION_ARRAY_BOUNDS_EXCEEDED:
    return "Array bounds exceeded";
  case EXCEPTION_FLT_DENORMAL_OPERAND:
    return "Float denormal operand";
  case EXCEPTION_FLT_DIVIDE_BY_ZERO:
    return "Float divide by zero";
  case EXCEPTION_FLT_INEXACT_RESULT:
    return "Float inexact result";
  case EXCEPTION_FLT_INVALID_OPERATION:
    return "Float invalid operation";
  case EXCEPTION_FLT_OVERFLOW:
    return "Float overflow";
  case EXCEPTION_FLT_STACK_CHECK:
    return "Float stack check";
  case EXCEPTION_FLT_UNDERFLOW:
    return "Float underflow";
  case EXCEPTION_INT_DIVIDE_BY_ZERO:
    return "Integer divide by zero";
  case EXCEPTION_INT_OVERFLOW:
    return "Integer overflow";
  case EXCEPTION_IN_PAGE_ERROR:
    return "In-page error";
  case EXCEPTION_ILLEGAL_INSTRUCTION:
    return "Illegal instruction";
  case EXCEPTION_STACK_OVERFLOW:
    return "Stack overflow";
  case EXCEPTION_INVALID_HANDLE:
    return "Invalid handle";
  default:
    return (code & (1u << 29)) ? "Custom exception" : "Unknown exception";
  }
}

// Write "Exception: <text> (code 0x<hex>)" using only the fixed buffer + WriteFile
// (plus OutputDebugStringA, which does not take app locks).
void write_exception_line(HANDLE h, DWORD code) {
  char line[96];
  size_t p = as_put_str(line, sizeof(line), 0, "Exception: ");
  p = as_put_str(line, sizeof(line), p, seh_exception_text(code));
  p = as_put_str(line, sizeof(line), p, " (code 0x");
  char hx[16];
  int hi = 0;
  DWORD v = code;
  const char *digits = "0123456789abcdef";
  if (v == 0) {
    hx[hi++] = '0';
  }
  while (v > 0 && hi < static_cast<int>(sizeof(hx))) {
    hx[hi++] = digits[v & 0xF];
    v >>= 4;
  }
  while (hi > 0 && p < sizeof(line) - 1) {
    line[p++] = hx[--hi];
  }
  p = as_put_str(line, sizeof(line), p, ")\n");
  if (h != INVALID_HANDLE_VALUE) {
    DWORD w = 0;
    WriteFile(h, line, static_cast<DWORD>(p), &w, nullptr);
  }
  OutputDebugStringA(line);
}

// Write a MiniDumpNormal next to the text report, sharing its pid + timestamp so
// the two artifacts pair up (only the extension differs). MiniDumpNormal keeps
// the footprint small (thread stacks + module list + handles, not the full
// working set) so the privacy surface stays bounded, and defers symbolization to
// offline analysis with the matching .pdb -- it needs no DbgHelp Sym* heap
// allocation, so it is a more robust artifact under heap corruption than the
// text stack walk.
//
// This runs before the fragile DbgHelp stack walk (which can truncate or fault
// under extreme heap corruption) but after the cheap header + exception line, so
// the essential "what/where" is already on disk and the robust dump gets its shot
// before the risky symbol walk (validated: with the dump written after the walk,
// heap-corruption crashes that truncated the text to a stub produced no dump at
// all). Still in-process, so extreme heap corruption or a stack overflow can
// defeat MiniDumpWriteDump too -- accepted limitation, see
// docs/windows-crash-symbols.md; the out-of-process dumper (W-C) that would
// remove it was evaluated and declined for its permanent maintenance cost.
void write_crash_minidump(EXCEPTION_POINTERS *ep, const SYSTEMTIME &st) {
  // A stack overflow leaves too little stack to run MiniDumpWriteDump (a heavy
  // call); attempting it just faults inside the handler. Skip it -- the text path
  // already recorded the exception, and stack overflow is an accepted limitation.
  if (ep->ExceptionRecord->ExceptionCode == EXCEPTION_STACK_OVERFLOW) {
    return;
  }

  // Final "<dir>/hs_err_pid<pid>_<YYYYMMDD_HHMMSS>.dmp" path (paired with .log).
  size_t dp = as_put_str(kf_dump_pathbuf, sizeof(kf_dump_pathbuf), 0, error_log_dir.c_str());
  dp = as_put_str(kf_dump_pathbuf, sizeof(kf_dump_pathbuf), dp, "/hs_err_pid");
  dp = as_put_uint(kf_dump_pathbuf, sizeof(kf_dump_pathbuf), dp, static_cast<unsigned long>(GetCurrentProcessId()));
  dp = as_put_str(kf_dump_pathbuf, sizeof(kf_dump_pathbuf), dp, "_");
  dp = as_put_uint(kf_dump_pathbuf, sizeof(kf_dump_pathbuf), dp, st.wYear);
  dp = as_put_uint2(kf_dump_pathbuf, sizeof(kf_dump_pathbuf), dp, st.wMonth);
  dp = as_put_uint2(kf_dump_pathbuf, sizeof(kf_dump_pathbuf), dp, st.wDay);
  dp = as_put_str(kf_dump_pathbuf, sizeof(kf_dump_pathbuf), dp, "_");
  dp = as_put_uint2(kf_dump_pathbuf, sizeof(kf_dump_pathbuf), dp, st.wHour);
  dp = as_put_uint2(kf_dump_pathbuf, sizeof(kf_dump_pathbuf), dp, st.wMinute);
  dp = as_put_uint2(kf_dump_pathbuf, sizeof(kf_dump_pathbuf), dp, st.wSecond);
  as_put_str(kf_dump_pathbuf, sizeof(kf_dump_pathbuf), dp, ".dmp");

  // Write to a ".part" sibling and rename only on success, so a .dmp file always
  // means a complete minidump. If MiniDumpWriteDump faults mid-write under extreme
  // corruption, the leftover is a clearly-incomplete ".part", not a 0-byte ".dmp"
  // that looks like real evidence.
  size_t pn = as_put_str(kf_dumppart_pathbuf, sizeof(kf_dumppart_pathbuf), 0, kf_dump_pathbuf);
  as_put_str(kf_dumppart_pathbuf, sizeof(kf_dumppart_pathbuf), pn, ".part");

  HANDLE hd = CreateFileA(kf_dumppart_pathbuf, GENERIC_WRITE, FILE_SHARE_READ, nullptr, CREATE_ALWAYS,
                          FILE_ATTRIBUTE_NORMAL, nullptr);
  if (hd == INVALID_HANDLE_VALUE) {
    return;
  }
  MINIDUMP_EXCEPTION_INFORMATION mei;
  mei.ThreadId = GetCurrentThreadId();
  mei.ExceptionPointers = ep;
  mei.ClientPointers = FALSE;
  BOOL ok = MiniDumpWriteDump(GetCurrentProcess(), GetCurrentProcessId(), hd, MiniDumpNormal, &mei, nullptr, nullptr);
  CloseHandle(hd);
  if (!ok) {
    DeleteFileA(kf_dumppart_pathbuf);
    OutputDebugStringA("# kungfu minidump write failed; removed partial file\n");
    return;
  }
  MoveFileExA(kf_dumppart_pathbuf, kf_dump_pathbuf, MOVEFILE_REPLACE_EXISTING);
  OutputDebugStringA("# kungfu minidump saved: ");
  OutputDebugStringA(kf_dump_pathbuf);
  OutputDebugStringA("\n");
}
} // namespace

// Crash dump for the Windows SEH / unhandled-exception path. Keeps returning
// EXCEPTION_EXECUTE_HANDLER so it can be used directly as an SEH __except filter
// expression (hero.cpp) and wrapped for SetUnhandledExceptionFilter (signal.cpp).
//
// Note: a stack-overflow exception can corrupt the SEH frame chain and defeat
// this path; that limitation is documented (W-A accepted, see header).
DWORD print_stack_trace(EXCEPTION_POINTERS *ep) {
  // Build "<dir>/hs_err_pid<pid>_<YYYYMMDD_HHMMSS>.log" without std::string / CRT.
  // error_log_dir is resolved at startup; c_str() does not allocate.
  SYSTEMTIME st;
  GetLocalTime(&st);
  size_t pos = as_put_str(kf_crash_pathbuf, sizeof(kf_crash_pathbuf), 0, error_log_dir.c_str());
  pos = as_put_str(kf_crash_pathbuf, sizeof(kf_crash_pathbuf), pos, "/hs_err_pid");
  pos = as_put_uint(kf_crash_pathbuf, sizeof(kf_crash_pathbuf), pos, static_cast<unsigned long>(GetCurrentProcessId()));
  pos = as_put_str(kf_crash_pathbuf, sizeof(kf_crash_pathbuf), pos, "_");
  pos = as_put_uint(kf_crash_pathbuf, sizeof(kf_crash_pathbuf), pos, st.wYear);
  pos = as_put_uint2(kf_crash_pathbuf, sizeof(kf_crash_pathbuf), pos, st.wMonth);
  pos = as_put_uint2(kf_crash_pathbuf, sizeof(kf_crash_pathbuf), pos, st.wDay);
  pos = as_put_str(kf_crash_pathbuf, sizeof(kf_crash_pathbuf), pos, "_");
  pos = as_put_uint2(kf_crash_pathbuf, sizeof(kf_crash_pathbuf), pos, st.wHour);
  pos = as_put_uint2(kf_crash_pathbuf, sizeof(kf_crash_pathbuf), pos, st.wMinute);
  pos = as_put_uint2(kf_crash_pathbuf, sizeof(kf_crash_pathbuf), pos, st.wSecond);
  as_put_str(kf_crash_pathbuf, sizeof(kf_crash_pathbuf), pos, ".log");

  HANDLE h = CreateFileA(kf_crash_pathbuf, GENERIC_WRITE, FILE_SHARE_READ, nullptr, CREATE_ALWAYS,
                         FILE_ATTRIBUTE_NORMAL, nullptr);

  const char *header = "\n----- kungfu native crash report (Windows) -----\n";
  if (h != INVALID_HANDLE_VALUE) {
    DWORD w = 0;
    WriteFile(h, header, static_cast<DWORD>(strlen(header)), &w, nullptr);
  } else {
    OutputDebugStringA("# kungfu: cannot open crash report file; writing to debugger only\n");
  }
  OutputDebugStringA(header);

  if (ep != nullptr) {
    write_exception_line(h, ep->ExceptionRecord->ExceptionCode);
  }

  // Capture the minidump after the cheap header + exception line above (so the
  // essential fault info is already flushed) but before the fragile DbgHelp stack
  // walk below (which can truncate/fault under extreme heap corruption). Only real
  // faults carry an EXCEPTION_POINTERS; the non-fatal print_stack_trace()
  // diagnostic path (ep == nullptr) stays text-only.
  if (ep != nullptr) {
    write_crash_minidump(ep, st);
  }

  // Symbolized stack goes straight to the file via the WriteFile-backed streambuf.
  // DbgHelp is warmed up by prepare_stack_trace() at handler-install time, so this
  // path performs symbol lookups rather than first-time initialization.
  {
    handle_streambuf sb(h);
    std::ostream os(&sb);
    StackWalker sw;
    sw.show_callstack(os, ep != nullptr ? ep->ContextRecord : nullptr);
  }

  if (h != INVALID_HANDLE_VALUE) {
    const char *tail = "----- end kungfu crash report -----\n";
    DWORD w = 0;
    WriteFile(h, tail, static_cast<DWORD>(strlen(tail)), &w, nullptr);
    CloseHandle(h);
    OutputDebugStringA("# kungfu crash report saved: ");
    OutputDebugStringA(kf_crash_pathbuf);
    OutputDebugStringA("\n");
  }

  return EXCEPTION_EXECUTE_HANDLER;
}

// Warm up the crash dumper once, outside any crash context, so the in-handler
// path never triggers first-time DbgHelp initialization (SymInitialize enumerates
// modules and allocates; doing it here keeps the crash path to symbol lookups).
// Sym state is process-global, so a throwaway walk to a null sink is enough.
void prepare_stack_trace() {
  handle_streambuf sb(INVALID_HANDLE_VALUE);
  std::ostream os(&sb);
  StackWalker sw;
  sw.show_callstack(os, nullptr);
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
