// SPDX-License-Identifier: Apache-2.0

#ifndef KUNGFU_RUNTIME_STORAGE_PROJECTION_TYPES_H
#define KUNGFU_RUNTIME_STORAGE_PROJECTION_TYPES_H

#include <cstdint>
#include <string>
#include <vector>

namespace kungfu::runtime::storage_service_api {

struct storage_projection_count {
  std::string table = {};
  uint64_t count = 0;
};

struct storage_projection_drift {
  std::string table = {};
  uint64_t projection_rows = 0;
  uint64_t journal_distinct = 0;
};

struct storage_projection_verify_result {
  bool ok = true;
  std::string status = "ok";
  std::string schema = {};
  std::string runtime_dir = {};
  std::string authority = "yijinjing-journal";
  bool projection_present = false;
  bool degraded = false;
  std::string note = {};
  std::vector<storage_projection_drift> drift = {};
  std::vector<storage_projection_count> rows = {};
  std::vector<storage_projection_count> journal_distinct = {};
};

struct storage_projection_rebuild_result {
  bool ok = true;
  std::string schema = {};
  std::string runtime_dir = {};
  std::string authority = "yijinjing-journal";
  std::string projection = "sqlite";
  std::string sqlite_path = {};
  std::vector<storage_projection_count> rows = {};
  std::vector<storage_projection_count> journal_records = {};
};

} // namespace kungfu::runtime::storage_service_api

#endif // KUNGFU_RUNTIME_STORAGE_PROJECTION_TYPES_H
