// SPDX-License-Identifier: Apache-2.0

#ifndef KUNGFU_YIJINJING_STORAGE_ACCEPTANCE_H
#define KUNGFU_YIJINJING_STORAGE_ACCEPTANCE_H

#include <cstdint>
#include <string>
#include <vector>

#include <kungfu/yijinjing/storage/bundle.h>
#include <kungfu/yijinjing/storage/channel.h>

namespace kungfu::yijinjing::storage {

struct accepted_segment {
  std::string id = {};
  manifest_ref manifest = {};
  source_head source_head = {};
  channel_cursor cursor = {};
  verification_status status = verification_status::Ok;
};

struct import_result {
  accepted_segment accepted = {};
  uint64_t event_count = 0;
  uint64_t payload_count = 0;
};

struct export_result {
  manifest_ref manifest = {};
  std::string artifact_uri = {};
  uint64_t event_count = 0;
  uint64_t payload_count = 0;
};

struct sync_result {
  source_ref source = {};
  std::vector<accepted_segment> accepted = {};
  verification_status status = verification_status::Ok;
};

} // namespace kungfu::yijinjing::storage

#endif // KUNGFU_YIJINJING_STORAGE_ACCEPTANCE_H
