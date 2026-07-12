// SPDX-License-Identifier: Apache-2.0

#ifndef KUNGFU_YIJINJING_STORAGE_CONTENT_HASH_H
#define KUNGFU_YIJINJING_STORAGE_CONTENT_HASH_H

#include <cstddef>
#include <span>
#include <string>

#include <kungfu/yijinjing/storage/common.h>

namespace kungfu::yijinjing::storage {

std::string normalize_content_hash_algorithm(const std::string &algorithm);

bool is_supported_content_hash_algorithm(const std::string &algorithm);

content_hash make_content_hash(const std::string &value, const std::string &algorithm = CONTENT_HASH_ALGORITHM_SHA256);

std::string format_content_hash(const content_hash &hash);

content_hash parse_content_hash(const std::string &formatted);

using content_bytes = std::span<const std::byte>;

content_hash compute_content_hash(content_bytes data, const std::string &algorithm = CONTENT_HASH_ALGORITHM_SHA256);

content_hash compute_content_hash(const void *data, size_t size,
                                  const std::string &algorithm = CONTENT_HASH_ALGORITHM_SHA256);

content_hash compute_content_hash(const std::string &data,
                                  const std::string &algorithm = CONTENT_HASH_ALGORITHM_SHA256);

std::string compute_content_hash_value(content_bytes data,
                                       const std::string &algorithm = CONTENT_HASH_ALGORITHM_SHA256);

std::string compute_content_hash_value(const void *data, size_t size,
                                       const std::string &algorithm = CONTENT_HASH_ALGORITHM_SHA256);

std::string compute_content_hash_value(const std::string &data,
                                       const std::string &algorithm = CONTENT_HASH_ALGORITHM_SHA256);

bool verify_content_hash(content_bytes data, const content_hash &expected);

bool verify_content_hash(const void *data, size_t size, const content_hash &expected);

bool verify_content_hash(const std::string &data, const content_hash &expected);

} // namespace kungfu::yijinjing::storage

#endif // KUNGFU_YIJINJING_STORAGE_CONTENT_HASH_H
