// SPDX-License-Identifier: Apache-2.0

//
// Created by Keren Dong on 2019-06-04.
//

#ifndef KUNGFU_YIJINJING_OS_H
#define KUNGFU_YIJINJING_OS_H

#include <memory>
#include <string>
#include <vector>

#ifdef _WINDOWS
#define GETPID _getpid
#else
#include <unistd.h>
#define GETPID getpid
#endif

namespace kungfu::yijinjing::os {
/**
 * load mmap buffer, return address of the file-mapped memory
 * whether to write has to be specified in "is_writing"
 * buffer memory is locked if not lazy
 * @return the address of mapped memory
 */
uintptr_t load_mmap_buffer(const std::string &path, size_t size, bool is_writing = false, bool lazy = true);

bool flush_mmap_buffer(uintptr_t address, size_t size, bool lazy);

bool release_mmap_buffer(uintptr_t address, size_t size, bool lazy);

void disable_os_signals_handler();

void handle_os_signals(void *hero);

void reset_hero_instance();

// --- Windows AppContainer guest launcher (ADR-0014) --------------------------
// The default-tier sandbox membrane on Windows: launch an untrusted guest inside
// an AppContainer (the process-level sandbox behind Store apps / Edge) so its
// only egress is the capability relay carried on its std handles. macOS/Linux
// wrap a command in `sandbox-exec`/`bwrap`; Windows has no such CLI, so the
// membrane is applied here by a custom CreateProcess. The guest's stdin/stdout
// are two named pipes the host owns (the relay); this opens them as the child's
// inheritable std handles. Non-Windows builds throw — the membrane is Win32-only.

struct app_container_options {
  std::string command;
  std::vector<std::string> args;
  // named-pipe paths the launcher opens as the child's std handles: the child
  // READS stdin_pipe, WRITES stdout_pipe
  std::string stdin_pipe;
  std::string stdout_pipe;
  // AppContainer identity + membrane
  std::string moniker;
  std::string display_name;
  // capability SID friendly names to grant (e.g. "internetClient"); empty = none
  std::vector<std::string> capabilities;
  // permissive lets the guest write outside its AppContainer folder
  bool allow_broad_write = false;
  // permissive adds the loopback network-isolation exemption so relay-local
  // sockets work (AppContainer blocks loopback by default)
  bool allow_loopback = false;
  // child environment as "KEY=VALUE" entries
  std::vector<std::string> env;
};

// A launched AppContainer child. Owns the OS process handle; wait() blocks until
// exit and returns the exit code, kill() terminates it. Language bindings wrap
// this so JS/Python never see a raw handle.
class app_container_process {
public:
  app_container_process(void *process_handle, unsigned long pid);
  ~app_container_process();
  app_container_process(const app_container_process &) = delete;
  app_container_process &operator=(const app_container_process &) = delete;

  unsigned long pid() const { return pid_; }
  int wait();
  void kill();

private:
  void *handle_; // Windows HANDLE, kept as void* so windows.h stays out of os.h
  unsigned long pid_;
};

// Create the AppContainer profile + capability SIDs, open the two named pipes as
// the child's inheritable std handles, and CreateProcess the guest into the
// AppContainer. Throws std::runtime_error on any Win32 failure, and on every
// non-Windows platform (the membrane is Win32-only).
std::shared_ptr<app_container_process> spawn_app_container(const app_container_options &options);
} // namespace kungfu::yijinjing::os

#endif // KUNGFU_YIJINJING_OS_H
