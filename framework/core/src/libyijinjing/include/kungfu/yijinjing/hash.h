// SPDX-License-Identifier: Apache-2.0

#ifndef KUNGFU_YIJINJING_HASH_H
#define KUNGFU_YIJINJING_HASH_H

#include <kungfu/common.h>

#define KUNGFU_HASH_SEED 42

namespace kungfu::yijinjing {
/**
 * Murmur Hash 2
 * @param key content to be hashed
 * @param len length of key
 * @param seed
 * @return hash result
 */
uint32_t hash_32(const unsigned char *key, int32_t length, uint32_t seed = KUNGFU_HASH_SEED);

uint64_t hash_64(const unsigned char *key, int32_t length, uint32_t seed = KUNGFU_HASH_SEED);

uint32_t hash_str_32(const std::string &key, uint32_t seed = KUNGFU_HASH_SEED);

uint64_t hash_str_64(const std::string &key, uint32_t seed = KUNGFU_HASH_SEED);

std::string hash_string_32(const std::string &key, uint32_t seed = KUNGFU_HASH_SEED);

std::string hash_string_64(const std::string &key, uint32_t seed = KUNGFU_HASH_SEED);

std::string hash_string_128(const std::string &key, uint32_t seed = KUNGFU_HASH_SEED);
} // namespace kungfu::yijinjing

#endif // KUNGFU_YIJINJING_HASH_H
