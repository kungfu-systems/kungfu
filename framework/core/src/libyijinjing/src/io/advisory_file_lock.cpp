// SPDX-License-Identifier: Apache-2.0

#include <kungfu/yijinjing/io/advisory_file_lock.h>

#include <cerrno>
#include <utility>

#ifdef _WIN32
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#else
#include <fcntl.h>
#include <sys/file.h>
#include <unistd.h>
#endif

namespace kungfu::yijinjing::io {

namespace {

const char *operation_name(advisory_lock_operation operation) noexcept {
  return operation == advisory_lock_operation::open ? "open advisory lock file" : "acquire advisory file lock";
}

#ifdef _WIN32
HANDLE invalid_handle() noexcept { return INVALID_HANDLE_VALUE; }

OVERLAPPED lock_region(uint64_t offset) noexcept {
  OVERLAPPED result{};
  result.Offset = static_cast<DWORD>(offset & 0xffffffffULL);
  result.OffsetHigh = static_cast<DWORD>(offset >> 32U);
  return result;
}

DWORD low_part(uint64_t value) noexcept { return static_cast<DWORD>(value & 0xffffffffULL); }
DWORD high_part(uint64_t value) noexcept { return static_cast<DWORD>(value >> 32U); }
#endif

} // namespace

advisory_file_lock_error::advisory_file_lock_error(advisory_lock_operation operation, std::error_code error)
    : std::system_error(error, operation_name(operation)), operation_(operation) {}

bool is_advisory_lock_contention(const std::error_code &error) noexcept {
#ifdef _WIN32
  return error.category() == std::system_category() &&
         (error.value() == ERROR_LOCK_VIOLATION || error.value() == ERROR_IO_PENDING);
#else
  return error.category() == std::generic_category() && (error.value() == EWOULDBLOCK || error.value() == EAGAIN);
#endif
}

advisory_file_lock::advisory_file_lock(const std::filesystem::path &path, advisory_file_lock_options options)
    : region_(options.region) {
#ifdef _WIN32
  const auto disposition = options.open == advisory_lock_open::open_or_create ? OPEN_ALWAYS : OPEN_EXISTING;
  auto handle = CreateFileW(path.wstring().c_str(), GENERIC_READ | GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE,
                            nullptr, disposition, FILE_ATTRIBUTE_NORMAL, nullptr);
  if (handle == invalid_handle()) {
    throw advisory_file_lock_error(advisory_lock_operation::open,
                                   std::error_code(static_cast<int>(GetLastError()), std::system_category()));
  }
  auto region = lock_region(options.region.offset);
  DWORD flags = options.mode == advisory_lock_mode::exclusive ? LOCKFILE_EXCLUSIVE_LOCK : 0;
  if (options.wait == advisory_lock_wait::non_blocking) {
    flags |= LOCKFILE_FAIL_IMMEDIATELY;
  }
  if (LockFileEx(handle, flags, 0, low_part(options.region.length), high_part(options.region.length), &region) == 0) {
    const auto error = std::error_code(static_cast<int>(GetLastError()), std::system_category());
    CloseHandle(handle);
    throw advisory_file_lock_error(advisory_lock_operation::acquire, error);
  }
  handle_ = handle;
#else
  int flags = O_RDWR | O_CLOEXEC;
  if (options.open == advisory_lock_open::open_or_create) {
    flags |= O_CREAT;
  }
  fd_ = ::open(path.c_str(), flags, static_cast<mode_t>(options.posix_permissions));
  if (fd_ < 0) {
    throw advisory_file_lock_error(advisory_lock_operation::open, std::error_code(errno, std::generic_category()));
  }
  int operation = options.mode == advisory_lock_mode::exclusive ? LOCK_EX : LOCK_SH;
  if (options.wait == advisory_lock_wait::non_blocking) {
    operation |= LOCK_NB;
  }
  if (::flock(fd_, operation) != 0) {
    const auto error = std::error_code(errno, std::generic_category());
    ::close(fd_);
    fd_ = -1;
    throw advisory_file_lock_error(advisory_lock_operation::acquire, error);
  }
#endif
}

advisory_file_lock::advisory_file_lock(advisory_file_lock &&other) noexcept : region_(other.region_) {
#ifdef _WIN32
  handle_ = std::exchange(other.handle_, invalid_handle());
#else
  fd_ = std::exchange(other.fd_, -1);
#endif
}

advisory_file_lock &advisory_file_lock::operator=(advisory_file_lock &&other) noexcept {
  if (this != &other) {
    release();
    region_ = other.region_;
#ifdef _WIN32
    handle_ = std::exchange(other.handle_, invalid_handle());
#else
    fd_ = std::exchange(other.fd_, -1);
#endif
  }
  return *this;
}

advisory_file_lock::~advisory_file_lock() { release(); }

void advisory_file_lock::release() noexcept {
#ifdef _WIN32
  auto handle = static_cast<HANDLE>(handle_);
  if (handle != invalid_handle()) {
    auto region = lock_region(region_.offset);
    (void)UnlockFileEx(handle, 0, low_part(region_.length), high_part(region_.length), &region);
    (void)CloseHandle(handle);
    handle_ = invalid_handle();
  }
#else
  if (fd_ >= 0) {
    (void)::flock(fd_, LOCK_UN);
    (void)::close(fd_);
    fd_ = -1;
  }
#endif
}

} // namespace kungfu::yijinjing::io
