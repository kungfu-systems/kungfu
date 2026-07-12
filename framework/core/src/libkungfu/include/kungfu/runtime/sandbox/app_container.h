// SPDX-License-Identifier: Apache-2.0

#ifndef KUNGFU_RUNTIME_SANDBOX_APP_CONTAINER_H
#define KUNGFU_RUNTIME_SANDBOX_APP_CONTAINER_H

#include <memory>
#include <string>
#include <vector>

namespace kungfu::runtime::sandbox {
// Windows AppContainer guest launcher (ADR-0014): the default-tier sandbox
// membrane on Windows. macOS/Linux callers should use their platform launcher.
struct app_container_options {
  std::string command;
  std::vector<std::string> args;
  std::string stdin_pipe;
  std::string stdout_pipe;
  std::string moniker;
  std::string display_name;
  std::vector<std::string> capabilities;
  bool allow_broad_write = false;
  std::string write_scratch;
  bool allow_loopback = false;
  std::vector<std::string> read_paths;
  std::vector<std::string> env;
};

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
  void *handle_; // Windows HANDLE, kept as void* so windows.h stays out of the public header.
  unsigned long pid_;
};

std::shared_ptr<app_container_process> spawn_app_container(const app_container_options &options);
} // namespace kungfu::runtime::sandbox

#endif // KUNGFU_RUNTIME_SANDBOX_APP_CONTAINER_H
