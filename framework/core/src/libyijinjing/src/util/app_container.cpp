// SPDX-License-Identifier: Apache-2.0
//
// The Windows AppContainer guest launcher (ADR-0014): the default-tier sandbox
// membrane on Windows. macOS confines a guest with a Seatbelt profile via
// `sandbox-exec`; Linux with `bwrap`; Windows has no such CLI, so the membrane is
// applied here by a custom CreateProcess that launches the guest INTO an
// AppContainer. The guest reaches the host only over the capability relay carried
// on its std handles — two named pipes the host owns. The knobs narrow the
// AppContainer transparently: fewer capability SIDs (deny network), no broad
// write (deny writes), no loopback exemption (deny network) — never a withdrawn
// method. This translation unit follows the codebase convention (mmap.cpp /
// signal.cpp): one file, win32 body under _WIN32, a throwing fallback otherwise.

#include <kungfu/yijinjing/util/os.h>

#include <stdexcept>
#include <string>

#ifdef _WIN32

#ifndef NOMINMAX
#define NOMINMAX
#endif
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>
// AppContainer profile + SID APIs (link: userenv.lib); FreeSid is advapi32.lib.
#include <userenv.h>
// SetEntriesInAcl (link: advapi32); window-station/desktop ACLs use user32.
#include <aclapi.h>
#include <vector>

// DeriveCapabilitySidsFromName is declared in securitybaseapi.h (via windows.h)
// but its import library differs across SDKs, so it is resolved dynamically from
// KernelBase.dll below rather than linked — keeping the link line to the standard
// libs (userenv + advapi32).

namespace kungfu::yijinjing::os {

namespace {
std::wstring widen(const std::string &s) {
  if (s.empty()) {
    return std::wstring();
  }
  int n = ::MultiByteToWideChar(CP_UTF8, 0, s.c_str(), static_cast<int>(s.size()), nullptr, 0);
  std::wstring w(static_cast<size_t>(n), L'\0');
  ::MultiByteToWideChar(CP_UTF8, 0, s.c_str(), static_cast<int>(s.size()), w.data(), n);
  return w;
}

[[noreturn]] void throw_win32(const char *context) {
  throw std::runtime_error(std::string(context) + " failed: win32 error " + std::to_string(::GetLastError()));
}

// A CreateProcess command line: quote each token so paths with spaces survive.
std::wstring build_command_line(const std::string &command, const std::vector<std::string> &args) {
  auto quote = [](const std::wstring &token) {
    std::wstring out = L"\"";
    for (wchar_t c : token) {
      if (c == L'"') {
        out += L'\\';
      }
      out += c;
    }
    out += L'"';
    return out;
  };
  std::wstring line = quote(widen(command));
  for (const auto &arg : args) {
    line += L' ';
    line += quote(widen(arg));
  }
  return line;
}

// A CREATE_UNICODE_ENVIRONMENT block: "K=V\0K=V\0\0".
std::wstring build_environment_block(const std::vector<std::string> &env) {
  std::wstring block;
  for (const auto &entry : env) {
    block += widen(entry);
    block.push_back(L'\0');
  }
  block.push_back(L'\0');
  return block;
}

// Add an allow-all ACE for the AppContainer SID to a USER object (window station
// or desktop). USER32/GDI initialize a connection to the window station in their
// DllMain; a runtime that imports USER32 (e.g. node.exe, unlike a console-only
// python.exe) fails DLL init under an AppContainer that cannot reach the window
// station or desktop (STATUS_DLL_INIT_FAILED). Best-effort — a failure here just
// leaves the guest without GUI access.
void grant_user_object(HANDLE object, PSID sid) {
  SECURITY_INFORMATION info = DACL_SECURITY_INFORMATION;
  DWORD needed = 0;
  ::GetUserObjectSecurity(object, &info, nullptr, 0, &needed);
  if (needed == 0) {
    return;
  }
  std::vector<BYTE> buffer(needed);
  auto descriptor = reinterpret_cast<PSECURITY_DESCRIPTOR>(buffer.data());
  if (!::GetUserObjectSecurity(object, &info, descriptor, needed, &needed)) {
    return;
  }
  BOOL present = FALSE;
  BOOL defaulted = FALSE;
  PACL old_dacl = nullptr;
  ::GetSecurityDescriptorDacl(descriptor, &present, &old_dacl, &defaulted);

  EXPLICIT_ACCESSW access = {};
  access.grfAccessPermissions = GENERIC_ALL;
  access.grfAccessMode = GRANT_ACCESS;
  access.grfInheritance = OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE;
  access.Trustee.TrusteeForm = TRUSTEE_IS_SID;
  access.Trustee.TrusteeType = TRUSTEE_IS_GROUP;
  access.Trustee.ptstrName = reinterpret_cast<LPWSTR>(sid);

  PACL new_dacl = nullptr;
  if (::SetEntriesInAclW(1, &access, old_dacl, &new_dacl) != ERROR_SUCCESS) {
    return;
  }
  SECURITY_DESCRIPTOR new_descriptor;
  if (::InitializeSecurityDescriptor(&new_descriptor, SECURITY_DESCRIPTOR_REVISION) &&
      ::SetSecurityDescriptorDacl(&new_descriptor, TRUE, new_dacl, FALSE)) {
    ::SetUserObjectSecurity(object, &info, &new_descriptor);
  }
  ::LocalFree(new_dacl);
}
} // namespace

app_container_process::app_container_process(void *process_handle, unsigned long pid)
    : handle_(process_handle), pid_(pid) {}

app_container_process::~app_container_process() {
  if (handle_ != nullptr) {
    ::CloseHandle(static_cast<HANDLE>(handle_));
  }
}

int app_container_process::wait() {
  ::WaitForSingleObject(static_cast<HANDLE>(handle_), INFINITE);
  DWORD code = 0;
  ::GetExitCodeProcess(static_cast<HANDLE>(handle_), &code);
  return static_cast<int>(code);
}

void app_container_process::kill() {
  if (handle_ != nullptr) {
    ::TerminateProcess(static_cast<HANDLE>(handle_), 1);
  }
}

std::shared_ptr<app_container_process> spawn_app_container(const app_container_options &options) {
  // 1. AppContainer SID: create the profile (idempotent across runs), or derive
  //    it when the profile already exists.
  const std::wstring moniker = widen(options.moniker);
  const std::wstring display = widen(options.display_name);
  PSID app_container_sid = nullptr;
  HRESULT hr =
      ::CreateAppContainerProfile(moniker.c_str(), display.c_str(), display.c_str(), nullptr, 0, &app_container_sid);
  if (hr == HRESULT_FROM_WIN32(ERROR_ALREADY_EXISTS)) {
    if (FAILED(::DeriveAppContainerSidFromAppContainerName(moniker.c_str(), &app_container_sid))) {
      throw std::runtime_error("DeriveAppContainerSidFromAppContainerName failed");
    }
  } else if (FAILED(hr)) {
    throw std::runtime_error("CreateAppContainerProfile failed hr=" + std::to_string(hr));
  }

  // 2. Capability SIDs from friendly names (e.g. "internetClient"). Fewer names
  //    == a narrower AppContainer; deny-network passes an empty list.
  using derive_capability_sids_fn = BOOL(WINAPI *)(LPCWSTR, PSID **, DWORD *, PSID **, DWORD *);
  auto derive_capability_sids = reinterpret_cast<derive_capability_sids_fn>(
      ::GetProcAddress(::GetModuleHandleW(L"kernelbase.dll"), "DeriveCapabilitySidsFromName"));

  std::vector<SID_AND_ATTRIBUTES> capabilities;
  std::vector<PSID *> cap_alloc_to_free;
  for (const auto &name : options.capabilities) {
    const std::wstring cap = widen(name);
    PSID *group_sids = nullptr;
    PSID *cap_sids = nullptr;
    DWORD group_count = 0;
    DWORD cap_count = 0;
    if (derive_capability_sids &&
        derive_capability_sids(cap.c_str(), &group_sids, &group_count, &cap_sids, &cap_count)) {
      for (DWORD i = 0; i < cap_count; ++i) {
        SID_AND_ATTRIBUTES attr = {};
        attr.Sid = cap_sids[i];
        attr.Attributes = SE_GROUP_ENABLED;
        capabilities.push_back(attr);
      }
      // cap_sids stays alive until after CreateProcess; group_sids not needed.
      if (cap_sids != nullptr) {
        cap_alloc_to_free.push_back(cap_sids);
      }
      if (group_sids != nullptr) {
        ::LocalFree(group_sids);
      }
    }
  }

  SECURITY_CAPABILITIES security_capabilities = {};
  security_capabilities.AppContainerSid = app_container_sid;
  security_capabilities.Capabilities = capabilities.empty() ? nullptr : capabilities.data();
  security_capabilities.CapabilityCount = static_cast<DWORD>(capabilities.size());

  // 3. Open the two named pipes as the child's inheritable std handles. The child
  //    READS stdin_pipe and WRITES stdout_pipe; the host holds the other ends
  //    (the relay).
  SECURITY_ATTRIBUTES inherit = {sizeof(SECURITY_ATTRIBUTES), nullptr, TRUE};
  HANDLE h_stdin = ::CreateFileW(widen(options.stdin_pipe).c_str(), GENERIC_READ, 0, &inherit, OPEN_EXISTING,
                                 FILE_FLAG_OVERLAPPED, nullptr);
  HANDLE h_stdout = ::CreateFileW(widen(options.stdout_pipe).c_str(), GENERIC_WRITE, 0, &inherit, OPEN_EXISTING,
                                  FILE_FLAG_OVERLAPPED, nullptr);
  if (h_stdin == INVALID_HANDLE_VALUE || h_stdout == INVALID_HANDLE_VALUE) {
    throw_win32("CreateFile(named pipe)");
  }
  // stderr carries the guest's diagnostics. Every handle in the inherit-only
  // HANDLE_LIST must itself be inheritable — a non-inheritable one makes
  // CreateProcess fail with ERROR_INVALID_PARAMETER — so duplicate the host
  // stderr as an inheritable handle, falling back to NUL if the host has none.
  HANDLE h_stderr = nullptr;
  if (!::DuplicateHandle(::GetCurrentProcess(), ::GetStdHandle(STD_ERROR_HANDLE), ::GetCurrentProcess(), &h_stderr, 0,
                         TRUE, DUPLICATE_SAME_ACCESS)) {
    h_stderr = ::CreateFileW(L"NUL", GENERIC_WRITE, FILE_SHARE_WRITE, &inherit, OPEN_EXISTING, 0, nullptr);
  }

  // 4. STARTUPINFOEX carrying the AppContainer (SECURITY_CAPABILITIES) and the
  //    explicit inherit-only handle list.
  STARTUPINFOEXW startup = {};
  startup.StartupInfo.cb = sizeof(startup);
  startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
  startup.StartupInfo.hStdInput = h_stdin;
  startup.StartupInfo.hStdOutput = h_stdout;
  startup.StartupInfo.hStdError = h_stderr;

  SIZE_T attr_size = 0;
  ::InitializeProcThreadAttributeList(nullptr, 2, 0, &attr_size);
  startup.lpAttributeList =
      reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(::HeapAlloc(::GetProcessHeap(), 0, attr_size));
  if (startup.lpAttributeList == nullptr ||
      !::InitializeProcThreadAttributeList(startup.lpAttributeList, 2, 0, &attr_size)) {
    throw_win32("InitializeProcThreadAttributeList");
  }
  if (!::UpdateProcThreadAttribute(startup.lpAttributeList, 0, PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES,
                                   &security_capabilities, sizeof(security_capabilities), nullptr, nullptr)) {
    throw_win32("UpdateProcThreadAttribute(security capabilities)");
  }
  HANDLE handle_list[3] = {h_stdin, h_stdout, h_stderr};
  ::UpdateProcThreadAttribute(startup.lpAttributeList, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, handle_list,
                              sizeof(handle_list), nullptr, nullptr);

  // 5. Loopback exemption (permissive only): AppContainer blocks loopback by
  //    default, which would also block the relay if the relay were TCP loopback.
  //    Our relay is named pipes (unaffected), but a permissive guest that opens a
  //    loopback socket should work, so add the exemption best-effort.
  //    DARKHERO-verify: NetworkIsolationSetAppContainerConfig (FirewallAPI.lib)
  //    is the mechanism; wire it here once the SID string is available.
  //    if (options.allow_loopback) { ... }

  // 5b. Grant the AppContainer access to this process's window station and
  //     desktop. A runtime that imports USER32 (node.exe) fails DLL init under an
  //     AppContainer that cannot reach them; a console-only runtime (python.exe)
  //     is unaffected. Best-effort.
  if (HWINSTA window_station = ::GetProcessWindowStation()) {
    grant_user_object(window_station, app_container_sid);
  }
  if (HDESK desktop = ::GetThreadDesktop(::GetCurrentThreadId())) {
    grant_user_object(desktop, app_container_sid);
  }

  // 6. Launch into the AppContainer.
  std::wstring command_line = build_command_line(options.command, options.args);
  std::wstring environment = build_environment_block(options.env);
  PROCESS_INFORMATION process_info = {};
  BOOL ok = ::CreateProcessW(
      nullptr, command_line.data(), nullptr, nullptr, TRUE, EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT,
      options.env.empty() ? nullptr : environment.data(), nullptr, &startup.StartupInfo, &process_info);

  // cleanup regardless of success
  ::DeleteProcThreadAttributeList(startup.lpAttributeList);
  ::HeapFree(::GetProcessHeap(), 0, startup.lpAttributeList);
  ::CloseHandle(h_stdin);
  ::CloseHandle(h_stdout);
  if (h_stderr != nullptr) {
    ::CloseHandle(h_stderr);
  }
  for (PSID *sids : cap_alloc_to_free) {
    ::LocalFree(sids);
  }
  if (app_container_sid != nullptr) {
    ::FreeSid(app_container_sid);
  }

  if (!ok) {
    throw_win32("CreateProcess(AppContainer)");
  }
  ::CloseHandle(process_info.hThread);
  return std::make_shared<app_container_process>(static_cast<void *>(process_info.hProcess), process_info.dwProcessId);
}
} // namespace kungfu::yijinjing::os

#else // non-Windows: the AppContainer membrane is Win32-only.

namespace kungfu::yijinjing::os {
app_container_process::app_container_process(void *, unsigned long pid) : handle_(nullptr), pid_(pid) {}
app_container_process::~app_container_process() {}
int app_container_process::wait() { return -1; }
void app_container_process::kill() {}

std::shared_ptr<app_container_process> spawn_app_container(const app_container_options &) {
  throw std::runtime_error("AppContainer sandbox is only available on Windows");
}
} // namespace kungfu::yijinjing::os

#endif
