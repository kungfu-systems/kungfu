// SPDX-License-Identifier: Apache-2.0

#ifndef KUNGFU_YIJINJING_STORAGE_RANGE_H
#define KUNGFU_YIJINJING_STORAGE_RANGE_H

#include <string>
#include <vector>

#include <kungfu/yijinjing/storage/common.h>

namespace kungfu::yijinjing::storage {

struct range_selector {
  event_range events = {};
  std::string session_id = {};
  std::string hash_anchor = {};
  std::string cursor = {};

  [[nodiscard]] bool empty() const {
    return !events.has_frame_bounds() && !events.has_time_bounds() && session_id.empty() && hash_anchor.empty() &&
           cursor.empty();
  }
};

struct hash_inventory_entry {
  content_hash hash = {};
  std::string subject = {};
  uint64_t byte_length = 0;
};

struct hash_inventory {
  std::string algorithm = CONTENT_HASH_ALGORITHM_SHA256;
  std::vector<hash_inventory_entry> entries = {};
};

} // namespace kungfu::yijinjing::storage

#endif // KUNGFU_YIJINJING_STORAGE_RANGE_H
