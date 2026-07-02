// SPDX-License-Identifier: Apache-2.0

//
// Created by Keren Dong on 2020/3/27.
//

#include <kungfu/yijinjing/cache/backend.h>

namespace kungfu::cache {

namespace fs = std::filesystem;

shift::shift(yijinjing::data::location_ptr location) : location_(std::move(location)), storage_map_() {}

shift::shift(const shift &copy) : location_(copy.location_), storage_map_(copy.storage_map_) {}

void shift::ensure_storage(uint32_t dest) {
  if (storage_map_.find(dest) != storage_map_.end()) {
    return;
  }
  auto locator = location_->locator;
  auto db_file = locator->layout_file(location_, longfist::enums::layout::SQLITE, fmt::format("{:08x}", dest));
  auto storage = make_storage_ptr(db_file, longfist::StateDataTypes);
  storage->pragma.journal_mode(sqlite_orm::journal_mode::WAL);
  storage->pragma.synchronous(0);
  storage->sync_schema();
  storage_map_.emplace(dest, storage);
}

bool shift::check_storage_exists(uint32_t dest) {
  auto locator = location_->locator;
  auto db_file = locator->layout_file(location_, longfist::enums::layout::SQLITE, fmt::format("{:08x}", dest));
  return fs::exists(db_file);
}

} // namespace kungfu::cache
