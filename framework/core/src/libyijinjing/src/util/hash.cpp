// SPDX-License-Identifier: Apache-2.0

//
// Created by Keren Dong on 2019-06-10.
//

#include "MurmurHash3.h"
#include <string>

#include <kungfu/yijinjing/util/util.h>

namespace kungfu {
uint32_t hash_32(const unsigned char *key, int32_t length) { return kungfu::yijinjing::util::hash_32(key, length); }
} // namespace kungfu

namespace kungfu::yijinjing::util {
uint32_t hash_32(const unsigned char *key, int32_t length, uint32_t seed) {
  uint32_t h;
  MurmurHash3_x86_32(key, length, seed, &h);
  return h;
}

uint64_t hash_64(const unsigned char *key, int32_t length, uint32_t seed) {
  uint64_t h[2];
  MurmurHash3_x64_128(key, length, seed, &h);
  return h[0];
}

uint32_t hash_str_32(const std::string &key, uint32_t seed) {
  return hash_32(reinterpret_cast<const unsigned char *>(key.c_str()), key.length(), seed);
}

uint64_t hash_str_64(const std::string &key, uint32_t seed) {
  return hash_64(reinterpret_cast<const unsigned char *>(key.c_str()), key.length(), seed);
}

std::string hash_string_32(const std::string &key, uint32_t seed) {
  char h[32] = {0};
  MurmurHash3_x86_32(key.c_str(), key.length(), seed, &h);
  return std::string{h, 32};
}

std::string hash_string_64(const std::string &key, uint32_t seed) {
  char h[128] = {0};
  MurmurHash3_x64_128(key.c_str(), key.length(), seed, &h);
  return std::string{h, 64};
}

std::string hash_string_128(const std::string &key, uint32_t seed) {
  char h[128] = {0};
  MurmurHash3_x86_128(key.c_str(), key.length(), seed, &h);
  return std::string{h, 128};
}
} // namespace kungfu::yijinjing::util
