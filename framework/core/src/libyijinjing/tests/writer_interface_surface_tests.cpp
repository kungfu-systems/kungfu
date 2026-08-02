// SPDX-License-Identifier: Apache-2.0

#include <kungfu/yijinjing/journal/journal.h>

#include <cstddef>
#include <cstdint>
#include <span>
#include <vector>

using kungfu::yijinjing::journal::writer;
using kungfu::yijinjing::journal::writer_hook;

template <typename T>
concept has_split_reservation = requires(T &target) { target.open_frame(int64_t{}, int32_t{}, size_t{}); };

template <typename T>
concept has_split_commit = requires(T &target) { target.close_frame(size_t{}, int64_t{}); };

template <typename T>
concept has_integer_pointer_write =
    requires(T &target) { target.write_raw(int64_t{}, int32_t{}, uintptr_t{}, uint32_t{}); };

template <typename T>
concept has_integer_pointer_write_at_as = requires(T &target) {
  target.write_raw_at_as(int64_t{}, int64_t{}, uint32_t{}, uint32_t{}, int32_t{}, uintptr_t{}, uint32_t{});
};

template <typename T>
concept has_container_length_write = requires(T &target, const std::vector<uint8_t> &bytes) {
  target.write_bytes(int64_t{}, int32_t{}, bytes, uint32_t{});
};

template <typename T>
concept has_split_data_commit = requires(T &target) { target.close_data(int64_t{}); };

template <typename T>
concept has_typed_split_reservation = requires(T &target) { target.template open_data<int>(); };

template <typename T>
concept has_custom_split_reservation = requires(T &target) { target.template open_custom_data<int>(int32_t{}); };

template <typename T>
concept has_old_reservation_hook =
    requires(T &target, kungfu::yijinjing::journal::frame_ptr frame) { target.on_open_frame(int64_t{}, frame); };

template <typename T>
concept has_old_commit_hook =
    requires(T &target, kungfu::yijinjing::journal::frame_ptr frame) { target.on_close_frame(int64_t{}, frame); };

template <typename T>
concept has_extent_write =
    requires(T &target, std::span<const std::byte> bytes) { target.write_bytes(int64_t{}, int32_t{}, bytes); };

static_assert(!has_split_reservation<writer>);
static_assert(!has_split_commit<writer>);
static_assert(!has_integer_pointer_write<writer>);
static_assert(!has_integer_pointer_write_at_as<writer>);
static_assert(!has_container_length_write<writer>);
static_assert(!has_split_data_commit<writer>);
static_assert(!has_typed_split_reservation<writer>);
static_assert(!has_custom_split_reservation<writer>);
static_assert(!has_old_reservation_hook<writer_hook>);
static_assert(!has_old_commit_hook<writer_hook>);
static_assert(has_extent_write<writer>);

int main() { return 0; }
