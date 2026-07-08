// SPDX-License-Identifier: Apache-2.0

#ifndef KUNGFU_YIJINJING_STORAGE_BUNDLE_H
#define KUNGFU_YIJINJING_STORAGE_BUNDLE_H

#include <string>
#include <vector>

#include <kungfu/yijinjing/storage/common.h>
#include <kungfu/yijinjing/storage/range.h>
#include <kungfu/yijinjing/storage/source.h>

namespace kungfu::yijinjing::storage {

struct schema_ref {
  std::string id = {};
  std::string version = {};
  content_hash hash = {};
};

struct schema_inventory_entry {
  schema_ref schema = {};
  std::string content_type = {};
};

struct payload_inventory_entry {
  payload_ref payload = {};
  std::string subject = {};
};

struct manifest_ref {
  std::string id = {};
  std::string format_namespace = "libkungfu:fact-ledger";
  std::string spec_version = {};
  source_ref source = {};
  location_ref location = {};
  event_range range = {};
  std::vector<payload_ref> payloads = {};
  std::vector<payload_inventory_entry> payload_inventory = {};
  std::vector<schema_inventory_entry> schema_inventory = {};
  std::string schema_root = {};
  std::string projection_watermark = {};
  content_hash manifest_hash = {};
};

struct bundle_ref {
  std::string id = {};
  manifest_ref manifest = {};
  hash_inventory inventory = {};
};

} // namespace kungfu::yijinjing::storage

#endif // KUNGFU_YIJINJING_STORAGE_BUNDLE_H
