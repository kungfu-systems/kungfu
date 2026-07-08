// SPDX-License-Identifier: Apache-2.0

#ifndef KUNGFU_YIJINJING_STORAGE_SOURCE_H
#define KUNGFU_YIJINJING_STORAGE_SOURCE_H

#include <string>
#include <vector>

#include <kungfu/yijinjing/storage/common.h>

namespace kungfu::yijinjing::storage {

struct source_ref {
  std::string id = {};
  source_kind kind = source_kind::Local;
  std::string coordinate = {};
  std::string head = {};
};

struct source_head {
  source_ref source = {};
  std::string head = {};
  event_range range = {};
  content_hash inventory_hash = {};
};

struct accepted_range {
  source_ref source = {};
  event_range range = {};
  std::string manifest_id = {};
  verification_status status = verification_status::Ok;
};

struct source_record {
  source_ref source = {};
  location_ref location = {};
  source_head current_head = {};
  std::vector<accepted_range> accepted = {};
};

struct source_registry_snapshot {
  std::vector<source_record> sources = {};
};

} // namespace kungfu::yijinjing::storage

#endif // KUNGFU_YIJINJING_STORAGE_SOURCE_H
