// SPDX-License-Identifier: Apache-2.0

#include <kungfu/yijinjing/io/advisory_file_lock.h>

#include <chrono>
#include <filesystem>
#include <stdexcept>
#include <string>

namespace fs = std::filesystem;
using namespace kungfu::yijinjing::io;

namespace {

void require(bool condition, const char *message) {
  if (!condition) {
    throw std::runtime_error(message);
  }
}

bool contention_for(const fs::path &path, advisory_file_lock_options options) {
  try {
    auto unexpected = advisory_file_lock(path, options);
    return false;
  } catch (const advisory_file_lock_error &error) {
    return error.operation() == advisory_lock_operation::acquire && is_advisory_lock_contention(error.code());
  }
}

} // namespace

int main() {
  const auto nonce = std::to_string(std::chrono::steady_clock::now().time_since_epoch().count());
  const auto root = fs::temp_directory_path() / fs::u8path("kungfu-lock-\xE8\xB7\xAF\xE5\xBE\x84-" + nonce);
  fs::create_directories(root);

  const auto byte_lock_path = root / "writer.lock";
  auto byte_options = advisory_file_lock_options{};
  byte_options.region = advisory_lock_region::byte(0);
  {
    auto first = advisory_file_lock(byte_lock_path, byte_options);
    require(contention_for(byte_lock_path, byte_options), "exclusive byte lock did not fail fast");
  }
  {
    auto reacquired = advisory_file_lock(byte_lock_path, byte_options);
  }

  const auto authority_path = root / "authority.lock";
  auto shared_options = advisory_file_lock_options{};
  shared_options.mode = advisory_lock_mode::shared;
  auto exclusive_options = advisory_file_lock_options{};
  {
    auto reader_one = advisory_file_lock(authority_path, shared_options);
    auto reader_two = advisory_file_lock(authority_path, shared_options);
    require(contention_for(authority_path, exclusive_options), "exclusive authority lock bypassed shared holders");
  }

  auto existing_options = advisory_file_lock_options{};
  existing_options.open = advisory_lock_open::existing;
  try {
    auto unexpected = advisory_file_lock(root / "missing.lock", existing_options);
    require(false, "existing-only lock created a missing file");
  } catch (const advisory_file_lock_error &error) {
    require(error.operation() == advisory_lock_operation::open, "missing file failure was not classified as open");
  }

  fs::remove_all(root);
}
