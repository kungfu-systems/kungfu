// SPDX-License-Identifier: Apache-2.0

#ifndef KUNGFU_YIJINJING_PLATFORM_MMAP_H
#define KUNGFU_YIJINJING_PLATFORM_MMAP_H

#include <cstddef>
#include <cstdint>
#include <string>

namespace kungfu::yijinjing::platform {

enum class mapping_access : uint8_t { read_only, read_write };
enum class mapping_creation : uint8_t { existing_only, create_or_grow };
enum class mapping_residency : uint8_t { demand, prefault, pinned };
enum class mapping_durability : uint8_t { visibility, asynchronous, durable };

/**
 * Orthogonal mapping authorization and operating intent.
 *
 * S2 deliberately qualifies demand-paged, visibility-only mappings. Prefault,
 * pinning, asynchronous flush, and durable flush remain named requests so a
 * caller cannot smuggle them through a boolean; construction rejects them
 * until the performance and crash-qualification gates enable them.
 */
struct mapping_policy {
  mapping_access access;
  mapping_creation creation;
  mapping_residency residency;
  mapping_durability durability;

  [[nodiscard]] constexpr bool writable() const noexcept { return access == mapping_access::read_write; }
  [[nodiscard]] constexpr bool creates_or_grows() const noexcept {
    return creation == mapping_creation::create_or_grow;
  }
  [[nodiscard]] constexpr bool structurally_valid() const noexcept { return writable() || !creates_or_grows(); }
  [[nodiscard]] constexpr bool qualified() const noexcept {
    return structurally_valid() && residency == mapping_residency::demand &&
           durability == mapping_durability::visibility;
  }

  [[nodiscard]] static constexpr mapping_policy read_existing() noexcept {
    return {mapping_access::read_only, mapping_creation::existing_only, mapping_residency::demand,
            mapping_durability::visibility};
  }
  [[nodiscard]] static constexpr mapping_policy write_existing() noexcept {
    return {mapping_access::read_write, mapping_creation::existing_only, mapping_residency::demand,
            mapping_durability::visibility};
  }
  [[nodiscard]] static constexpr mapping_policy write_create_or_grow() noexcept {
    return {mapping_access::read_write, mapping_creation::create_or_grow, mapping_residency::demand,
            mapping_durability::visibility};
  }
};

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

  static mapped_region map(const std::string &path, size_t size, mapping_policy policy);

  [[nodiscard]] uintptr_t address() const noexcept { return address_; }
  [[nodiscard]] size_t size() const noexcept { return size_; }
  [[nodiscard]] bool writable() const noexcept { return writable_; }
  [[nodiscard]] bool locked() const noexcept { return locked_; }
  [[nodiscard]] mapping_policy policy() const noexcept { return policy_; }
  [[nodiscard]] explicit operator bool() const noexcept { return address_ != 0; }

  [[nodiscard]] bool flush() const noexcept;
  [[nodiscard]] bool reset() noexcept;

  /** Transfer the raw mapping to the legacy uintptr_t API. */
  [[nodiscard]] uintptr_t release() noexcept;

private:
  mapped_region(uintptr_t address, size_t size, mapping_policy policy, bool locked) noexcept
      : address_(address), size_(size), writable_(policy.writable()), locked_(locked), policy_(policy) {}

  uintptr_t address_ = 0;
  size_t size_ = 0;
  bool writable_ = false;
  bool locked_ = false;
  mapping_policy policy_ = mapping_policy::read_existing();
};

/** Raw-address compatibility surface for embedders that cannot own mapped_region. */
uintptr_t load_mmap_buffer(const std::string &path, size_t size, mapping_policy policy);
bool flush_mmap_buffer(uintptr_t address, size_t size, mapping_durability durability);
bool release_mmap_buffer(uintptr_t address, size_t size);

} // namespace kungfu::yijinjing::platform

#endif // KUNGFU_YIJINJING_PLATFORM_MMAP_H
