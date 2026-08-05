// SPDX-License-Identifier: Apache-2.0
#pragma once

#include <cstdio>
#include <filesystem>
#include <memory>
#include <string_view>

namespace kungfu::yijinjing::io::durability {

enum class directory_sync_status { synchronized, unsupported };

// Internal cross-platform mechanics for a file whose caller owns the durability
// contract. Domain policy, fault classification, and acknowledgement remain at
// the call site.
class durable_file {
public:
  durable_file(const std::filesystem::path &path, bool truncate);
  durable_file(const durable_file &) = delete;
  durable_file &operator=(const durable_file &) = delete;
  durable_file(durable_file &&) = delete;
  durable_file &operator=(durable_file &&) = delete;
  ~durable_file();

  void write(std::string_view bytes);
  void sync();

private:
  struct impl;
  std::unique_ptr<impl> impl_;
};

// Strict primitives throw std::system_error when the requested operation
// cannot be completed. Windows reports directory synchronization as
// unsupported after validating the directory because FlushFileBuffers cannot
// provide the POSIX directory-fsync guarantee.
void sync_file(std::FILE *file);
void sync_file(const std::filesystem::path &path);
directory_sync_status sync_directory(const std::filesystem::path &directory);
void replace_file(const std::filesystem::path &temporary, const std::filesystem::path &final);

// Explicit weaker adapters for contracts that already advertise best-effort
// publication. They never strengthen the caller's public durability claim.
[[nodiscard]] bool try_sync_file(std::FILE *file) noexcept;
void best_effort_sync_directory(const std::filesystem::path &directory) noexcept;

} // namespace kungfu::yijinjing::io::durability
