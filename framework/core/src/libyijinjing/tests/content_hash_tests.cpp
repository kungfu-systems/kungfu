// SPDX-License-Identifier: Apache-2.0

#include <kungfu/yijinjing/storage/content_hash.h>

#include <array>
#include <cassert>
#include <cstddef>
#include <stdexcept>

using kungfu::yijinjing::storage::compute_content_hash;
using kungfu::yijinjing::storage::compute_content_hash_value;
using kungfu::yijinjing::storage::content_bytes;
using kungfu::yijinjing::storage::verify_content_hash;

int main() {
  constexpr std::array payload{std::byte{'a'}, std::byte{'b'}, std::byte{'c'}};
  const content_bytes bytes{payload};
  const auto hash = compute_content_hash(bytes);
  assert(hash.value == "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert(compute_content_hash_value(bytes) == hash.value);
  assert(verify_content_hash(bytes, hash));

  // Pointer/length remains an edge adapter for C ABI and language bindings;
  // the typed span owns the internal size invariant.
  assert(compute_content_hash(payload.data(), payload.size()).value == hash.value);
  bool rejected = false;
  try {
    (void)compute_content_hash(nullptr, 1);
  } catch (const std::invalid_argument &) {
    rejected = true;
  }
  assert(rejected);
}
