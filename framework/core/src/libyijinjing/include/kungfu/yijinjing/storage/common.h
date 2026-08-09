// SPDX-License-Identifier: Apache-2.0

#ifndef KUNGFU_YIJINJING_STORAGE_COMMON_H
#define KUNGFU_YIJINJING_STORAGE_COMMON_H

#include <string>

namespace kungfu::yijinjing::storage {

inline constexpr const char *CONTENT_HASH_ALGORITHM_SHA256 = "sha256";
inline constexpr const char *CONTENT_HASH_ALGORITHM_BLAKE3 = "blake3";

struct content_hash {
  std::string algorithm = CONTENT_HASH_ALGORITHM_SHA256;
  std::string value = {};

  [[nodiscard]] bool empty() const { return value.empty(); }
};

} // namespace kungfu::yijinjing::storage

#endif // KUNGFU_YIJINJING_STORAGE_COMMON_H
