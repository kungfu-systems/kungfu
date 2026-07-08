// SPDX-License-Identifier: Apache-2.0

#ifndef KUNGFU_YIJINJING_STORAGE_CHANNEL_H
#define KUNGFU_YIJINJING_STORAGE_CHANNEL_H

#include <string>

#include <kungfu/yijinjing/storage/range.h>
#include <kungfu/yijinjing/storage/source.h>

namespace kungfu::yijinjing::storage {

struct channel_ref {
  std::string id = {};
  location_ref source_location = {};
  location_ref target_location = {};
};

struct channel_cursor {
  channel_ref channel = {};
  std::string value = {};
  event_range acknowledged = {};
};

struct channel_request {
  channel_request_kind kind = channel_request_kind::Fetch;
  source_ref source = {};
  channel_ref channel = {};
  range_selector range = {};
  channel_cursor cursor = {};
};

} // namespace kungfu::yijinjing::storage

#endif // KUNGFU_YIJINJING_STORAGE_CHANNEL_H
