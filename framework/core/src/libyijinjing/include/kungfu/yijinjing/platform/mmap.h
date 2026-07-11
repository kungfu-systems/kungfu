// SPDX-License-Identifier: Apache-2.0

#ifndef KUNGFU_YIJINJING_PLATFORM_MMAP_H
#define KUNGFU_YIJINJING_PLATFORM_MMAP_H

#include <cstddef>
#include <cstdint>
#include <string>

namespace kungfu::yijinjing::platform {

/**
 * Move-only ownership for one file-backed mapping.
 *
 * The mapped address remains stable for the lifetime of this object. Moving
 * transfers ownership; destruction always attempts to release the mapping and
 * never throws. File creation is deliberately separated from existing-only
 * mapping so read paths cannot silently create or stretch journal pages.
 */
class mapped_region {
public:
  mapped_region() noexcept = default;
  ~mapped_region() noexcept;

  mapped_region(const mapped_region &) = delete;
  mapped_region &operator=(const mapped_region &) = delete;

  mapped_region(mapped_region &&other) noexcept;
  mapped_region &operator=(mapped_region &&other) noexcept;

  static mapped_region map_existing(const std::string &path, size_t size, bool writable = false, bool lazy = true);
  static mapped_region map_writable(const std::string &path, size_t size, bool lazy = true);

  [[nodiscard]] uintptr_t address() const noexcept { return address_; }
  [[nodiscard]] size_t size() const noexcept { return size_; }
  [[nodiscard]] bool writable() const noexcept { return writable_; }
  [[nodiscard]] bool locked() const noexcept { return locked_; }
  [[nodiscard]] explicit operator bool() const noexcept { return address_ != 0; }

  [[nodiscard]] bool flush() const noexcept;
  [[nodiscard]] bool reset() noexcept;

  /** Transfer the raw mapping to the legacy uintptr_t API. */
  [[nodiscard]] uintptr_t release() noexcept;

private:
  mapped_region(uintptr_t address, size_t size, bool writable, bool locked) noexcept
      : address_(address), size_(size), writable_(writable), locked_(locked) {}

  uintptr_t address_ = 0;
  size_t size_ = 0;
  bool writable_ = false;
  bool locked_ = false;
};

/**
 * load mmap buffer, return address of the file-mapped memory
 * whether to write has to be specified in "is_writing"
 * buffer memory is locked if not lazy
 * @return the address of mapped memory
 */
uintptr_t load_mmap_buffer(const std::string &path, size_t size, bool is_writing = false, bool lazy = true);

bool flush_mmap_buffer(uintptr_t address, size_t size, bool lazy);

bool release_mmap_buffer(uintptr_t address, size_t size, bool lazy);
} // namespace kungfu::yijinjing::platform

#endif // KUNGFU_YIJINJING_PLATFORM_MMAP_H
