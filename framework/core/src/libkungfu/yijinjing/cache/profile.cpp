// SPDX-License-Identifier: Apache-2.0

//
// Created by Keren Dong on 2020/2/25.
//

#include <kungfu/yijinjing/cache/profile.h>

using namespace kungfu::longfist;
using namespace kungfu::longfist::enums;
using namespace kungfu::yijinjing::data;

namespace kungfu::cache {

std::string default_db_file(const locator_ptr &locator) {
  auto config_location = std::make_shared<location>(mode::LIVE, category::SYSTEM, "etc", "kungfu", locator);
  return locator->layout_file(config_location, enums::layout::SQLITE, "config");
}

profile::profile(const yijinjing::data::locator_ptr &locator) : profile(default_db_file(locator)) {}

profile::profile(std::string profile_db_file) : profile_db_file_(std::move(profile_db_file)) {}

void profile::setup() {
  auto storage = get_storage();
  storage->pragma.journal_mode(sqlite_orm::journal_mode::WAL);
  storage->pragma.synchronous(0);
  storage->sync_schema();
}

cache::ProfileStoragePtr &profile::get_storage() {
  static auto storage = cache::make_storage_ptr(profile_db_file_, ProfileDataTypes);
  return storage;
}
} // namespace kungfu::cache
