// SPDX-License-Identifier: Apache-2.0

#include "io/durability.h"

#include <algorithm>
#include <cerrno>
#include <limits>
#include <stdexcept>
#include <system_error>

#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <io.h>
#include <windows.h>
#else
#include <fcntl.h>
#include <unistd.h>
#endif

namespace kungfu::yijinjing::io::durability {

namespace fs = std::filesystem;

struct durable_file::impl {
  impl(const fs::path &path, bool truncate) {
#ifdef _WIN32
    handle = CreateFileW(path.wstring().c_str(), GENERIC_READ | GENERIC_WRITE, FILE_SHARE_READ, nullptr,
                         truncate ? CREATE_ALWAYS : OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (handle == INVALID_HANDLE_VALUE) {
      throw std::system_error(static_cast<int>(GetLastError()), std::system_category(), "open durable file");
    }
    LARGE_INTEGER target{};
    if (!truncate && SetFilePointerEx(handle, target, nullptr, FILE_END) == 0) {
      const auto error = static_cast<int>(GetLastError());
      CloseHandle(handle);
      handle = INVALID_HANDLE_VALUE;
      throw std::system_error(error, std::system_category(), "seek durable file");
    }
#else
    descriptor = ::open(path.c_str(), O_CREAT | O_RDWR | (truncate ? O_TRUNC : O_APPEND) | O_CLOEXEC, 0644);
    if (descriptor < 0) {
      throw std::system_error(errno, std::generic_category(), "open durable file");
    }
#endif
  }

  ~impl() {
#ifdef _WIN32
    if (handle != INVALID_HANDLE_VALUE) {
      CloseHandle(handle);
    }
#else
    if (descriptor >= 0) {
      ::close(descriptor);
    }
#endif
  }

  void write(std::string_view bytes) {
    size_t offset = 0;
    while (offset < bytes.size()) {
#ifdef _WIN32
      const auto remaining = std::min<size_t>(bytes.size() - offset, std::numeric_limits<DWORD>::max());
      DWORD written = 0;
      if (WriteFile(handle, bytes.data() + offset, static_cast<DWORD>(remaining), &written, nullptr) == 0 ||
          written == 0) {
        throw std::system_error(static_cast<int>(GetLastError()), std::system_category(), "write durable file");
      }
      offset += written;
#else
      const auto written = ::write(descriptor, bytes.data() + offset, bytes.size() - offset);
      if (written <= 0) {
        throw std::system_error(errno, std::generic_category(), "write durable file");
      }
      offset += static_cast<size_t>(written);
#endif
    }
  }

  void sync() {
#ifdef _WIN32
    if (FlushFileBuffers(handle) == 0) {
      throw std::system_error(static_cast<int>(GetLastError()), std::system_category(), "sync durable file");
    }
#else
    if (::fsync(descriptor) != 0) {
      throw std::system_error(errno, std::generic_category(), "sync durable file");
    }
#endif
  }

#ifdef _WIN32
  HANDLE handle = INVALID_HANDLE_VALUE;
#else
  int descriptor = -1;
#endif
};

durable_file::durable_file(const fs::path &path, bool truncate) : impl_(std::make_unique<impl>(path, truncate)) {}

durable_file::~durable_file() = default;

void durable_file::write(std::string_view bytes) { impl_->write(bytes); }

void durable_file::sync() { impl_->sync(); }

void sync_file(std::FILE *file) {
  if (file == nullptr) {
    throw std::invalid_argument("sync file requires an open stream");
  }
#ifdef _WIN32
  if (_commit(_fileno(file)) != 0) {
    throw std::system_error(errno, std::generic_category(), "sync file");
  }
#else
  if (::fsync(fileno(file)) != 0) {
    throw std::system_error(errno, std::generic_category(), "sync file");
  }
#endif
}

void sync_file(const fs::path &path) {
#ifdef _WIN32
  const auto handle =
      CreateFileW(path.wstring().c_str(), GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                  nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
  if (handle == INVALID_HANDLE_VALUE) {
    throw std::system_error(static_cast<int>(GetLastError()), std::system_category(), "open file for sync");
  }
  const auto result = FlushFileBuffers(handle);
  const auto error = static_cast<int>(GetLastError());
  CloseHandle(handle);
  if (result == 0) {
    throw std::system_error(error, std::system_category(), "sync file");
  }
#else
  const auto descriptor = ::open(path.c_str(), O_RDONLY | O_CLOEXEC);
  if (descriptor < 0) {
    throw std::system_error(errno, std::generic_category(), "open file for sync");
  }
  const auto result = ::fsync(descriptor);
  const auto error = errno;
  ::close(descriptor);
  if (result != 0) {
    throw std::system_error(error, std::generic_category(), "sync file");
  }
#endif
}

directory_sync_status sync_directory(const fs::path &directory) {
#ifdef _WIN32
  std::error_code error;
  if (!fs::is_directory(directory, error) || error) {
    throw std::system_error(error ? error : std::make_error_code(std::errc::not_a_directory),
                            "validate directory for sync");
  }
  return directory_sync_status::unsupported;
#else
  const auto descriptor = ::open(directory.c_str(), O_RDONLY | O_DIRECTORY | O_CLOEXEC);
  if (descriptor < 0) {
    throw std::system_error(errno, std::generic_category(), "open directory for sync");
  }
  const auto result = ::fsync(descriptor);
  const auto error = errno;
  ::close(descriptor);
  if (result != 0) {
    throw std::system_error(error, std::generic_category(), "sync directory");
  }
  return directory_sync_status::synchronized;
#endif
}

void replace_file(const fs::path &temporary, const fs::path &final) {
#ifdef _WIN32
  if (MoveFileExW(temporary.wstring().c_str(), final.wstring().c_str(),
                  MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH) == 0) {
    throw std::system_error(static_cast<int>(GetLastError()), std::system_category(), "replace file");
  }
#else
  if (::rename(temporary.c_str(), final.c_str()) != 0) {
    throw std::system_error(errno, std::generic_category(), "replace file");
  }
#endif
}

bool try_sync_file(std::FILE *file) noexcept {
  try {
    sync_file(file);
    return true;
  } catch (...) {
    return false;
  }
}

void best_effort_sync_directory(const fs::path &directory) noexcept {
  try {
    (void)sync_directory(directory);
  } catch (...) {
  }
}

} // namespace kungfu::yijinjing::io::durability
