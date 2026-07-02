// SPDX-License-Identifier: Apache-2.0

//
// Created by Keren Dong on 2019-06-04.
//

#ifndef KUNGFU_YIJINJING_UTIL_H
#define KUNGFU_YIJINJING_UTIL_H

#define KUNGFU_HASH_SEED 42

#include <kungfu/common.h>

namespace kungfu::yijinjing::util {
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

void color_print(const std::string &level, const std::string &log);

bool in_color_terminal();

size_t get_thread_id();
} // namespace kungfu::yijinjing::util

#endif // KUNGFU_YIJINJING_UTIL_H
