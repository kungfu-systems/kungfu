// SPDX-License-Identifier: Apache-2.0

//
// Created by Keren Dong on 2019-06-10.
//

#ifdef _WIN32
#include <fcntl.h>
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#else

#include <sys/fcntl.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>

#endif // _WIN32

#include <kungfu/common.h>
#include <kungfu/yijinjing/journal/common.h>
#include <kungfu/yijinjing/platform/mmap.h>

#include <limits>

using namespace kungfu::yijinjing::journal;

namespace kungfu::yijinjing::platform {

namespace {

struct native_mapping {
  uintptr_t address;
  bool locked;
};

void validate_policy(const mapping_policy policy, const std::string &path) {
  if (!policy.structurally_valid()) {
    throw journal_error("read-only mapping cannot create or grow page " + path);
  }
  if (policy.residency != mapping_residency::demand) {
    throw journal_error("mapping residency request is not qualified for page " + path);
  }
  if (policy.durability != mapping_durability::visibility) {
    throw journal_error("mapping durability request is not qualified for page " + path);
  }
}

#ifdef _WIN32
[[noreturn]] void throw_mapping_error(const std::string &operation, const std::string &path, int code) {
  throw journal_error(operation + " for page " + path + ", error: " + std::to_string(code));
}

class unique_handle {
public:
  explicit unique_handle(HANDLE value = INVALID_HANDLE_VALUE) noexcept : value_(value) {}
  ~unique_handle() noexcept { reset(); }
  unique_handle(const unique_handle &) = delete;
  unique_handle &operator=(const unique_handle &) = delete;
  unique_handle(unique_handle &&other) noexcept : value_(other.release()) {}
  unique_handle &operator=(unique_handle &&other) noexcept {
    if (this != &other) {
      reset();
      value_ = other.release();
    }
    return *this;
  }
  [[nodiscard]] HANDLE get() const noexcept { return value_; }
  [[nodiscard]] explicit operator bool() const noexcept { return value_ != nullptr && value_ != INVALID_HANDLE_VALUE; }
  [[nodiscard]] HANDLE release() noexcept {
    HANDLE value = value_;
    value_ = INVALID_HANDLE_VALUE;
    return value;
  }
  void reset() noexcept {
    if (*this) {
      CloseHandle(value_);
    }
    value_ = INVALID_HANDLE_VALUE;
  }

private:
  HANDLE value_;
};

native_mapping map_file(const std::string &path, size_t size, mapping_policy policy) {
  validate_policy(policy, path);
  if (size == 0) {
    throw journal_error("refusing to mmap zero bytes for page " + path);
  }
  if (size > static_cast<uint64_t>(std::numeric_limits<LONGLONG>::max())) {
    throw journal_error("requested mapping is too large for page " + path);
  }

  unique_handle file(CreateFileA(path.c_str(), policy.writable() ? (GENERIC_READ | GENERIC_WRITE) : GENERIC_READ,
                                 FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr,
                                 policy.creates_or_grows() ? OPEN_ALWAYS : OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL,
                                 nullptr));
  if (!file) {
    throw_mapping_error("failed to open file", path, static_cast<int>(GetLastError()));
  }

  LARGE_INTEGER file_size{};
  if (!GetFileSizeEx(file.get(), &file_size)) {
    throw_mapping_error("failed to inspect file size", path, static_cast<int>(GetLastError()));
  }
  if (file_size.QuadPart < 0 || static_cast<uint64_t>(file_size.QuadPart) < size) {
    if (!policy.creates_or_grows()) {
      throw journal_error("page file is smaller than requested mapping: " + path + ", required " +
                          std::to_string(size) + ", found " + std::to_string(file_size.QuadPart));
    }
    LARGE_INTEGER target{};
    target.QuadPart = static_cast<LONGLONG>(size);
    if (!SetFilePointerEx(file.get(), target, nullptr, FILE_BEGIN)) {
      throw_mapping_error("failed to seek before stretching file to " + std::to_string(size) + " bytes", path,
                          static_cast<int>(GetLastError()));
    }
    if (!SetEndOfFile(file.get())) {
      throw_mapping_error("failed to stretch file to " + std::to_string(size) + " bytes", path,
                          static_cast<int>(GetLastError()));
    }
  }

  const auto size64 = static_cast<uint64_t>(size);
  unique_handle mapping(CreateFileMappingA(file.get(), nullptr, policy.writable() ? PAGE_READWRITE : PAGE_READONLY,
                                           static_cast<DWORD>(size64 >> 32u), static_cast<DWORD>(size64), nullptr));
  if (!mapping) {
    throw_mapping_error("failed to create file mapping", path, static_cast<int>(GetLastError()));
  }

  void *buffer = MapViewOfFile(mapping.get(), policy.writable() ? FILE_MAP_ALL_ACCESS : FILE_MAP_READ, 0, 0, size);
  if (buffer == nullptr) {
    throw_mapping_error("failed to map view", path, static_cast<int>(GetLastError()));
  }
  return {reinterpret_cast<uintptr_t>(buffer), false};
}

#else

native_mapping map_file(const std::string &path, size_t size, mapping_policy policy) {
  validate_policy(policy, path);
  if (size == 0) {
    throw journal_error("refusing to mmap zero bytes for page " + path);
  }
  if (size > static_cast<uint64_t>(std::numeric_limits<off_t>::max())) {
    throw journal_error("requested mapping is too large for page " + path);
  }

  int flags = policy.writable() ? O_RDWR : O_RDONLY;
  if (policy.creates_or_grows()) {
    flags |= O_CREAT;
  }
  int fd = open(path.c_str(), flags, static_cast<mode_t>(0600));
  if (fd < 0) {
    throw journal_error("failed to open file for page " + path + ", errno: " + strerror(errno));
  }

  struct stat file_stat{};
  if (fstat(fd, &file_stat) != 0) {
    const int code = errno;
    close(fd);
    throw journal_error("failed to inspect file size for page " + path + ", errno: " + strerror(code));
  }
  if (file_stat.st_size < 0 || static_cast<uint64_t>(file_stat.st_size) < size) {
    if (!policy.creates_or_grows()) {
      const auto found = file_stat.st_size;
      close(fd);
      throw journal_error("page file is smaller than requested mapping: " + path + ", required " +
                          std::to_string(size) + ", found " + std::to_string(found));
    }
    if (ftruncate(fd, static_cast<off_t>(size)) != 0) {
      const int code = errno;
      close(fd);
      throw journal_error("failed to stretch file for page " + path + ", errno: " + strerror(code));
    }
  }

  void *buffer = mmap(nullptr, size, policy.writable() ? (PROT_READ | PROT_WRITE) : PROT_READ, MAP_SHARED, fd, 0);
  if (buffer == MAP_FAILED) {
    const int code = errno;
    close(fd);
    throw journal_error("failed to map file for page " + path + ", errno: " + strerror(code));
  }

  close(fd);
  return {reinterpret_cast<uintptr_t>(buffer), false};
}

#endif

} // namespace

mapped_region::~mapped_region() noexcept { (void)reset(); }

mapped_region::mapped_region(mapped_region &&other) noexcept
    : address_(other.address_), size_(other.size_), writable_(other.writable_), locked_(other.locked_),
      policy_(other.policy_) {
  other.address_ = 0;
  other.size_ = 0;
  other.writable_ = false;
  other.locked_ = false;
  other.policy_ = mapping_policy::read_existing();
}

mapped_region &mapped_region::operator=(mapped_region &&other) noexcept {
  if (this != &other) {
    (void)reset();
    address_ = other.address_;
    size_ = other.size_;
    writable_ = other.writable_;
    locked_ = other.locked_;
    policy_ = other.policy_;
    other.address_ = 0;
    other.size_ = 0;
    other.writable_ = false;
    other.locked_ = false;
    other.policy_ = mapping_policy::read_existing();
  }
  return *this;
}

mapped_region mapped_region::map(const std::string &path, size_t size, mapping_policy policy) {
  const auto native = map_file(path, size, policy);
  return mapped_region(native.address, size, policy, native.locked);
}

bool mapped_region::flush() const noexcept {
  if (address_ == 0 || !writable_) {
    return true;
  }
  void *buffer = reinterpret_cast<void *>(address_);
#ifdef _WIN32
  return FlushViewOfFile(buffer, size_) != 0;
#else
  return msync(buffer, size_, MS_SYNC) == 0;
#endif
}

bool mapped_region::reset() noexcept {
  if (address_ == 0) {
    return true;
  }
  void *buffer = reinterpret_cast<void *>(address_);
  bool ok = true;
#ifdef _WIN32
  if (writable_ && FlushViewOfFile(buffer, size_) == 0) {
    ok = false;
  }
  if (UnmapViewOfFile(buffer) == 0) {
    ok = false;
  }
#else
  if (locked_ && munlock(buffer, size_) != 0) {
    ok = false;
  }
  if (munmap(buffer, size_) != 0) {
    ok = false;
  }
#endif
  address_ = 0;
  size_ = 0;
  writable_ = false;
  locked_ = false;
  policy_ = mapping_policy::read_existing();
  return ok;
}

uintptr_t mapped_region::release() noexcept {
  const uintptr_t address = address_;
  address_ = 0;
  size_ = 0;
  writable_ = false;
  locked_ = false;
  policy_ = mapping_policy::read_existing();
  return address;
}

uintptr_t load_mmap_buffer(const std::string &path, size_t size, mapping_policy policy) {
  auto region = mapped_region::map(path, size, policy);
  return region.release();
}

bool flush_mmap_buffer(uintptr_t address, size_t size, mapping_durability durability) {
  if (durability != mapping_durability::visibility) {
    return false;
  }
  void *buffer = reinterpret_cast<void *>(address);
#ifdef _WIN32
  if (FlushViewOfFile(buffer, size) == 0) {
    return false;
  }
#else
  if (msync(buffer, size, MS_SYNC) != 0) {
    return false;
  }
#endif
  return true;
}

bool release_mmap_buffer(uintptr_t address, size_t size) {
  void *buffer = reinterpret_cast<void *>(address);
#ifdef _WIN32
  const bool flushed = FlushViewOfFile(buffer, size) != 0;
  const bool unmapped = UnmapViewOfFile(buffer) != 0;
  return flushed && unmapped;
#else
  return munmap(buffer, size) == 0;
#endif // _WIN32
}

} // namespace kungfu::yijinjing::platform
