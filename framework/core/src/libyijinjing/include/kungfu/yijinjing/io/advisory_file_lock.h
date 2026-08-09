// SPDX-License-Identifier: Apache-2.0
#pragma once

#include <cstdint>
#include <filesystem>
#include <system_error>

namespace kungfu::yijinjing::io {

enum class advisory_lock_mode { shared, exclusive };
enum class advisory_lock_wait { blocking, non_blocking };
enum class advisory_lock_open { existing, open_or_create };
enum class advisory_lock_operation { open, acquire };

struct advisory_lock_region {
  uint64_t offset = 0;
  uint64_t length = UINT64_MAX;

  static constexpr advisory_lock_region whole_file() noexcept { return {}; }
  static constexpr advisory_lock_region byte(uint64_t offset) noexcept { return {offset, 1}; }
};

struct advisory_file_lock_options {
  advisory_lock_mode mode = advisory_lock_mode::exclusive;
  advisory_lock_wait wait = advisory_lock_wait::non_blocking;
  advisory_lock_open open = advisory_lock_open::open_or_create;
  advisory_lock_region region = advisory_lock_region::whole_file();
  uint32_t posix_permissions = 0644;
};

class advisory_file_lock_error : public std::system_error {
public:
  advisory_file_lock_error(advisory_lock_operation operation, std::error_code error);
  [[nodiscard]] advisory_lock_operation operation() const noexcept { return operation_; }

private:
  advisory_lock_operation operation_;
};

[[nodiscard]] bool is_advisory_lock_contention(const std::error_code &error) noexcept;

// Cross-platform OS mechanics only. Callers retain lock-path selection,
// domain-specific errors, critical-section lifetime, and recovery semantics.
class advisory_file_lock {
public:
  explicit advisory_file_lock(const std::filesystem::path &path,
                              advisory_file_lock_options options = advisory_file_lock_options{});
  advisory_file_lock(const advisory_file_lock &) = delete;
  advisory_file_lock &operator=(const advisory_file_lock &) = delete;
  advisory_file_lock(advisory_file_lock &&other) noexcept;
  advisory_file_lock &operator=(advisory_file_lock &&other) noexcept;
  ~advisory_file_lock();

  void release() noexcept;

#ifdef _WIN32
  [[nodiscard]] void *native_handle() const noexcept { return handle_; }
#else
  [[nodiscard]] int native_handle() const noexcept { return fd_; }
#endif

private:
  advisory_lock_region region_{};
#ifdef _WIN32
  void *handle_ = reinterpret_cast<void *>(static_cast<intptr_t>(-1));
#else
  int fd_ = -1;
#endif
};

} // namespace kungfu::yijinjing::io
