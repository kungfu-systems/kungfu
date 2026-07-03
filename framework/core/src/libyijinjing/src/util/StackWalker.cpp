// SPDX-License-Identifier: Apache-2.0

//
// Windows crash-report stack walker for yijinjing.
//
// Rewritten to converge on a single, correct, architecture-neutral
// implementation. The native stack is produced by the OS unwinder
// (RtlCaptureStackBackTrace for the current thread, StackWalk64 seeded from an
// exception CONTEXT) and symbolized with DbgHelp. The previously vendored
// StackWalker library (BSD, Jochen Kalmbach) and its hand-rolled frame walk,
// along with dead VC5/6 compatibility code, have been removed.
//
// Thread-safety: DbgHelp (DbgHelp.dll) is documented as single-threaded; all
// Sym*/StackWalk calls here are serialized by one process-wide mutex.
//
// Scope note: this runs from SEH filters / the unhandled-exception filter. The
// spdlog (KF_LOG) echo and per-frame std::ostringstream have been removed from
// the crash path (see print_native_stack) so the faulting thread can no longer
// deadlock on the spdlog lock. std::ostream formatting and DbgHelp's own heap use
// remain (W-A accepted residual, see stacktrace.cpp / docs/windows-crash-symbols.md);
// full out-of-process capture is future work. Symbol lookups are serialized by a
// process-wide mutex and warmed up once via prepare_stack_trace().
//

#include "StackWalker.h"

#if defined(_MSC_VER)

#include <kungfu/common.h>

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>

#include <dbghelp.h>
#include <psapi.h>
#include <versionhelpers.h>

#include <cstdint>
#include <cstring>
#include <iomanip>
#include <mutex>
#include <process.h>
#include <string>

#pragma comment(lib, "dbghelp.lib")
#pragma comment(lib, "psapi.lib")
#pragma comment(lib, "version.lib")
#pragma comment(lib, "advapi32.lib")

// GetFileVersionInfo / _dupenv_s deprecation noise from strict SDKs.
#pragma warning(disable : 4996)

namespace kungfu::yijinjing::util {

namespace {

constexpr int kMaxFrames = 256;

// DbgHelp is single-threaded; serialize the whole symbol engine so concurrent
// crash handlers cannot corrupt it.
std::mutex &dbghelp_mutex() {
  static std::mutex m;
  return m;
}

// One-time SymInitialize with fInvadeProcess=TRUE so that module symbols are
// loaded eagerly (the previous code used FALSE and relied on a manual module
// load that never registered unwind tables, which broke x64 walking). Must be
// called while holding dbghelp_mutex().
bool ensure_sym_initialized() {
  static bool initialized = false;
  if (!initialized) {
    SymSetOptions(SYMOPT_LOAD_LINES | SYMOPT_UNDNAME | SYMOPT_DEFERRED_LOADS | SYMOPT_FAIL_CRITICAL_ERRORS);
    initialized = SymInitialize(GetCurrentProcess(), nullptr, TRUE) != FALSE;
  }
  return initialized;
}

// Collect up to kMaxFrames return addresses into `frames`.
//   context == nullptr -> current thread stack via RtlCaptureStackBackTrace
//                         (architecture-neutral, no register handling).
//   context != nullptr -> unwind from the given CONTEXT via StackWalk64.
// Returns the number of frames captured.
int collect_frames(const CONTEXT *context, void **frames) {
  if (context == nullptr) {
    return static_cast<int>(RtlCaptureStackBackTrace(0, kMaxFrames, frames, nullptr));
  }

  CONTEXT ctx = *context; // StackWalk64 mutates the context; walk a copy.
  STACKFRAME64 frame;
  std::memset(&frame, 0, sizeof(frame));

  DWORD machine;
#if defined(_M_X64)
  machine = IMAGE_FILE_MACHINE_AMD64;
  frame.AddrPC.Offset = ctx.Rip;
  frame.AddrFrame.Offset = ctx.Rbp;
  frame.AddrStack.Offset = ctx.Rsp;
#elif defined(_M_ARM64)
  machine = IMAGE_FILE_MACHINE_ARM64;
  frame.AddrPC.Offset = ctx.Pc;
  frame.AddrFrame.Offset = ctx.Fp;
  frame.AddrStack.Offset = ctx.Sp;
#else
  return 0; // unsupported architecture; current Windows targets are x64/arm64.
#endif
  frame.AddrPC.Mode = AddrModeFlat;
  frame.AddrFrame.Mode = AddrModeFlat;
  frame.AddrStack.Mode = AddrModeFlat;

  HANDLE proc = GetCurrentProcess();
  HANDLE thread = GetCurrentThread();
  int count = 0;
  while (count < kMaxFrames) {
    if (!StackWalk64(machine, proc, thread, &frame, &ctx, nullptr, SymFunctionTableAccess64, SymGetModuleBase64,
                     nullptr)) {
      break;
    }
    if (frame.AddrPC.Offset == 0) {
      break;
    }
    frames[count++] = reinterpret_cast<void *>(frame.AddrPC.Offset);
  }
  return count;
}

// Base file name of the module owning `addr`, e.g. "kungfu_node.node".
std::string module_base_name(DWORD64 addr) {
  HMODULE mod = nullptr;
  if (!GetModuleHandleExA(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
                          reinterpret_cast<LPCSTR>(addr), &mod) ||
      mod == nullptr) {
    return {};
  }
  char path[MAX_PATH] = {0};
  if (GetModuleFileNameA(mod, path, MAX_PATH) == 0) {
    return {};
  }
  const char *base = std::strrchr(path, '\\');
  return base != nullptr ? std::string(base + 1) : std::string(path);
}

// Format one frame as "[module+0xrva]  symbol+0xoff  (file:line)".
// Must be called while holding dbghelp_mutex().
void format_frame(std::ostream &st, DWORD64 addr) {
  HANDLE proc = GetCurrentProcess();

  const std::string mod = module_base_name(addr);
  const DWORD64 mod_base = SymGetModuleBase64(proc, addr);
  if (!mod.empty()) {
    st << "[" << mod;
    if (mod_base != 0) {
      st << "+0x" << std::hex << (addr - mod_base) << std::dec;
    }
    st << "]";
  } else {
    st << "0x" << std::hex << std::setw(16) << std::setfill('0') << addr << std::dec << std::setfill(' ');
  }

  alignas(SYMBOL_INFO) char sym_storage[sizeof(SYMBOL_INFO) + MAX_SYM_NAME] = {0};
  auto *sym = reinterpret_cast<SYMBOL_INFO *>(sym_storage);
  sym->SizeOfStruct = sizeof(SYMBOL_INFO);
  sym->MaxNameLen = MAX_SYM_NAME;
  DWORD64 sym_disp = 0;
  if (SymFromAddr(proc, addr, &sym_disp, sym)) {
    st << "  " << sym->Name << "+0x" << std::hex << sym_disp << std::dec;
  }

  IMAGEHLP_LINE64 line;
  std::memset(&line, 0, sizeof(line));
  line.SizeOfStruct = sizeof(line);
  DWORD line_disp = 0;
  if (SymGetLineFromAddr64(proc, addr, &line_disp, &line) && line.FileName != nullptr) {
    const char *file = std::strrchr(line.FileName, '\\');
    st << "  (" << (file != nullptr ? file + 1 : line.FileName) << ":" << line.LineNumber << ")";
  }
}

} // namespace

void StackWalker::print_native_stack(std::ostream &st, const void *context) {
  st << std::endl;
  st << "-------------------------Native Stack--------------------------" << std::endl;

  void *frames[kMaxFrames];
  std::lock_guard<std::mutex> guard(dbghelp_mutex());
  ensure_sym_initialized();

  const int n = collect_frames(static_cast<const CONTEXT *>(context), frames);
  if (n == 0) {
    st << "  <no frames captured>" << std::endl;
    return;
  }

  for (int i = 0; i < n; ++i) {
    // Format straight into the crash-report stream. The previous code built a
    // std::ostringstream per frame and echoed it through KF_LOG_CRITICAL (spdlog);
    // both are removed from the crash path -- the per-frame heap allocation and,
    // more importantly, the spdlog lock the faulting thread may already hold.
    format_frame(st, reinterpret_cast<DWORD64>(frames[i]));
    st << std::endl;
  }
  st << std::endl;
}

void StackWalker::show_callstack(std::ostream &os, const void *context) {
  print_windows_version(os);
  print_cpu_info(os);
  print_environment_variables(os);
  print_loaded_modules(os);
  print_stack_bound(os);
  print_native_stack(os, context);
}

void StackWalker::print_windows_version(std::ostream &st) {
  st << std::endl;
  st << "--------------------------Windows version-----------------------------" << std::endl;

  const bool is_workstation = !IsWindowsServer();

  // Version comes from \Windows\System32\kernel32.dll's file version resource.
  TCHAR kernel32_path[MAX_PATH];
  UINT len = MAX_PATH - static_cast<UINT>(lstrlen(TEXT("\\kernel32.dll"))) - 1;
  UINT ret = GetSystemDirectory(kernel32_path, len);
  if (ret == 0 || ret > len) {
    st << "GetSystemDirectory failed" << std::endl;
    return;
  }
  lstrcat(kernel32_path, TEXT("\\kernel32.dll"));

  DWORD version_size = GetFileVersionInfoSize(kernel32_path, nullptr);
  if (version_size == 0) {
    st << "GetFileVersionInfoSize failed" << std::endl;
    return;
  }
  std::string version_info(version_size, '\0');
  if (!GetFileVersionInfo(kernel32_path, 0, version_size, version_info.data())) {
    st << "GetFileVersionInfo failed" << std::endl;
    return;
  }
  VS_FIXEDFILEINFO *file_info = nullptr;
  UINT file_info_len = 0;
  if (!VerQueryValue(version_info.data(), TEXT("\\"), reinterpret_cast<LPVOID *>(&file_info), &file_info_len)) {
    st << "VerQueryValue failed" << std::endl;
    return;
  }

  const int major_version = HIWORD(file_info->dwProductVersionMS);
  const int minor_version = LOWORD(file_info->dwProductVersionMS);
  const int build_number = HIWORD(file_info->dwProductVersionLS);
  const int build_minor = LOWORD(file_info->dwProductVersionLS);
  const int os_vers = major_version * 1000 + minor_version;

  st << " Windows ";
  switch (os_vers) {
  case 6000:
    st << (is_workstation ? "Vista" : "Server 2008");
    break;
  case 6001:
    st << (is_workstation ? "7" : "Server 2008 R2");
    break;
  case 6002:
    st << (is_workstation ? "8" : "Server 2012");
    break;
  case 6003:
    st << (is_workstation ? "8.1" : "Server 2012 R2");
    break;
  case 10000:
    if (is_workstation) {
      st << (build_number >= 22000 ? "11" : "10");
    } else if (build_number > 20347) {
      st << "Server 2022";
    } else if (build_number > 17762) {
      st << "Server 2019";
    } else {
      st << "Server 2016";
    }
    break;
  default:
    st << major_version << "." << minor_version;
    break;
  }

  SYSTEM_INFO si;
  ZeroMemory(&si, sizeof(si));
  GetNativeSystemInfo(&si);
  if (si.wProcessorArchitecture == PROCESSOR_ARCHITECTURE_AMD64 ||
      si.wProcessorArchitecture == PROCESSOR_ARCHITECTURE_ARM64) {
    st << " , 64 bit";
  }
  st << " Build " << build_number;
  st << " (" << major_version << "." << minor_version << "." << build_number << "." << build_minor << ")";
  st << std::endl;
}

void StackWalker::print_cpu_info(std::ostream &st) {
  st << std::endl;
  st << "--------------------------CPU Info-------------------------------------" << std::endl;
  SYSTEM_INFO sys_info;
  GetSystemInfo(&sys_info);
  switch (sys_info.wProcessorArchitecture) {
  case PROCESSOR_ARCHITECTURE_AMD64:
    st << "System Architecture: X64 (AMD or Intel)" << std::endl;
    break;
  case PROCESSOR_ARCHITECTURE_ARM64:
    st << "System Architecture: ARM64" << std::endl;
    break;
  case PROCESSOR_ARCHITECTURE_ARM:
    st << "System Architecture: ARM" << std::endl;
    break;
  case PROCESSOR_ARCHITECTURE_INTEL:
    st << "System Architecture: X86" << std::endl;
    break;
  default:
    st << "System Architecture: Unknown" << std::endl;
    break;
  }
  st << "CPU level :  " << sys_info.wProcessorLevel << std::endl;
  st << "CPU revision :  " << std::hex << sys_info.wProcessorRevision << std::dec << std::endl;
  st << "page size :  " << sys_info.dwPageSize << std::endl;
  st << "number of logical processors :  " << sys_info.dwNumberOfProcessors << std::endl;
  st << "lowest application address :  " << sys_info.lpMinimumApplicationAddress << std::endl;
  st << "highest application address :  " << sys_info.lpMaximumApplicationAddress << std::endl;
  st << "allocation granularity :  " << sys_info.dwAllocationGranularity << std::endl;
}

void StackWalker::print_environment_variables(std::ostream &st) {
  st << std::endl;
  st << "-------------------------environment variables--------------------------" << std::endl;
  static const char *const env_list[] = {"PATH",  "USERNAME", "OS",   "PROCESSOR_IDENTIFIER",
                                         "SHELL", "TMP",      "TEMP", nullptr};
  for (int i = 0; env_list[i] != nullptr; ++i) {
    char *value = nullptr;
    size_t sz = 0;
    if (_dupenv_s(&value, &sz, env_list[i]) == 0 && value != nullptr) {
      st << env_list[i] << "=" << value << std::endl;
      free(value);
    }
  }
}

void StackWalker::print_loaded_modules(std::ostream &st) {
  st << std::endl;
  st << "--------------------------Dynamic libraries-----------------------------" << std::endl;
  HANDLE proc = GetCurrentProcess();
  HMODULE modules[256];
  DWORD needed = 0;
  if (!EnumProcessModules(proc, modules, sizeof(modules), &needed)) {
    st << "  <EnumProcessModules failed>" << std::endl;
    return;
  }
  int count = static_cast<int>(needed / sizeof(HMODULE));
  if (count > 256) {
    count = 256;
  }
  for (int i = 0; i < count; ++i) {
    MODULEINFO mi;
    char path[MAX_PATH] = {0};
    if (GetModuleInformation(proc, modules[i], &mi, sizeof(mi)) &&
        GetModuleFileNameExA(proc, modules[i], path, MAX_PATH) != 0) {
      const auto base = reinterpret_cast<DWORD64>(mi.lpBaseOfDll);
      st << "0x" << std::hex << base << " - 0x" << (base + mi.SizeOfImage) << std::dec << "  \t" << path << std::endl;
    }
  }
}

void StackWalker::print_stack_bound(std::ostream &st) {
  st << "\n\n"
     << "stack:   ";
  MEMORY_BASIC_INFORMATION minfo;
  VirtualQuery(&minfo, &minfo, sizeof(minfo));
  auto *const alloc_base = static_cast<uint8_t *>(minfo.AllocationBase);

  // Sum contiguous regions sharing the same AllocationBase to find the top.
  uint8_t *cursor = alloc_base;
  SIZE_T total = 0;
  while (VirtualQuery(cursor, &minfo, sizeof(minfo)) == sizeof(minfo) &&
         static_cast<uint8_t *>(minfo.AllocationBase) == alloc_base) {
    total += minfo.RegionSize;
    cursor += minfo.RegionSize;
  }
  uint8_t *const top = alloc_base + total;

  st << "0x" << std::hex << reinterpret_cast<uintptr_t>(alloc_base) << " - 0x" << reinterpret_cast<uintptr_t>(top)
     << std::dec << "\n"
     << std::endl;
}

} // namespace kungfu::yijinjing::util

#endif // defined(_MSC_VER)
