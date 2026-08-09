// SPDX-License-Identifier: Apache-2.0

//
// Created by Keren Dong on 2019-06-10.
//

#include <cstring>
#include <stdexcept>
#include <string>

#include <kungfu/yijinjing/hash.h>
#include <xxhash.h>

namespace kungfu {
uint32_t fast_hash_32(const unsigned char *key, int32_t length) { return kungfu::yijinjing::fast_hash_32(key, length); }
} // namespace kungfu

namespace kungfu::yijinjing {
namespace {
size_t checked_length(const unsigned char *key, int32_t length) {
  if (length < 0) {
    throw std::invalid_argument("fast_hash length must be non-negative");
  }
  if (key == nullptr and length != 0) {
    throw std::invalid_argument("fast_hash key must not be null when length is non-zero");
  }
  return static_cast<size_t>(length);
}

std::string uint32_to_canonical_bytes(uint32_t value) {
  char bytes[4] = {static_cast<char>((value >> 24U) & 0xffU), static_cast<char>((value >> 16U) & 0xffU),
                   static_cast<char>((value >> 8U) & 0xffU), static_cast<char>(value & 0xffU)};
  return {bytes, sizeof(bytes)};
}
} // namespace

uint32_t fast_hash_32(const unsigned char *key, int32_t length, uint32_t seed) {
  return static_cast<uint32_t>(fast_hash_64(key, length, seed));
}

uint64_t fast_hash_64(const unsigned char *key, int32_t length, uint32_t seed) {
  return XXH3_64bits_withSeed(key, checked_length(key, length), seed);
}

uint32_t fast_hash_str_32(const std::string &key, uint32_t seed) {
  return fast_hash_32(reinterpret_cast<const unsigned char *>(key.c_str()), key.length(), seed);
}

uint64_t fast_hash_str_64(const std::string &key, uint32_t seed) {
  return fast_hash_64(reinterpret_cast<const unsigned char *>(key.c_str()), key.length(), seed);
}

std::string fast_hash_string_32(const std::string &key, uint32_t seed) {
  return uint32_to_canonical_bytes(fast_hash_str_32(key, seed));
}

std::string fast_hash_string_64(const std::string &key, uint32_t seed) {
  XXH64_canonical_t canonical;
  XXH64_canonicalFromHash(&canonical, fast_hash_str_64(key, seed));
  return {reinterpret_cast<const char *>(canonical.digest), sizeof(canonical.digest)};
}

std::string fast_hash_string_128(const std::string &key, uint32_t seed) {
  const auto digest = XXH3_128bits_withSeed(key.data(), key.size(), seed);
  XXH128_canonical_t canonical;
  XXH128_canonicalFromHash(&canonical, digest);
  return {reinterpret_cast<const char *>(canonical.digest), sizeof(canonical.digest)};
}
} // namespace kungfu::yijinjing
