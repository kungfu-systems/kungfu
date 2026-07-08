// SPDX-License-Identifier: Apache-2.0

#ifndef KUNGFU_YIJINJING_HASH_H
#define KUNGFU_YIJINJING_HASH_H

#include <kungfu/common.h>

#define KUNGFU_HASH_SEED 42

namespace kungfu::yijinjing {
/**
 * Fast deterministic non-cryptographic hash for internal ids and in-process
 * keys.
 *
 * The current implementation is MurmurHash3. Do not use this API for content
 * addressing, tamper evidence, manifests, or security boundaries; those must
 * use an explicit content-hash algorithm such as sha256/blake3.
 *
 * @param key content to be hashed
 * @param len length of key
 * @param seed
 * @return hash result
 */
inline constexpr const char *FAST_HASH_ALGORITHM = "murmur3";

uint32_t fast_hash_32(const unsigned char *key, int32_t length, uint32_t seed = KUNGFU_HASH_SEED);

uint64_t fast_hash_64(const unsigned char *key, int32_t length, uint32_t seed = KUNGFU_HASH_SEED);

uint32_t fast_hash_str_32(const std::string &key, uint32_t seed = KUNGFU_HASH_SEED);

uint64_t fast_hash_str_64(const std::string &key, uint32_t seed = KUNGFU_HASH_SEED);

std::string fast_hash_string_32(const std::string &key, uint32_t seed = KUNGFU_HASH_SEED);

std::string fast_hash_string_64(const std::string &key, uint32_t seed = KUNGFU_HASH_SEED);

std::string fast_hash_string_128(const std::string &key, uint32_t seed = KUNGFU_HASH_SEED);
} // namespace kungfu::yijinjing

#endif // KUNGFU_YIJINJING_HASH_H
