// SPDX-License-Identifier: Apache-2.0

#ifndef KUNGFU_RUNTIME_STORAGE_PROJECTION_TRANSACTION_H
#define KUNGFU_RUNTIME_STORAGE_PROJECTION_TRANSACTION_H

#include <stdexcept>
#include <utility>

#include <sqlite3.h>

namespace kungfu::runtime::storage_service_api {

template <typename Storage, typename Rebuild>
void rebuild_projection_transaction(const Storage &storage, Rebuild &&rebuild) {
  sqlite3 *transaction_db = nullptr;
  const auto configure_connection = [&transaction_db](sqlite3 *db) {
    sqlite3_busy_timeout(db, 5000);
    transaction_db = db;
  };
  storage->on_open = configure_connection;
  try {
    storage->transaction([&] {
      if (transaction_db == nullptr) {
        throw std::runtime_error("SQLite projection transaction did not expose its connection");
      }
      std::forward<Rebuild>(rebuild)(transaction_db);
      return true;
    });
  } catch (...) {
    storage->on_open = [](sqlite3 *db) { sqlite3_busy_timeout(db, 5000); };
    throw;
  }
  storage->on_open = [](sqlite3 *db) { sqlite3_busy_timeout(db, 5000); };
}

} // namespace kungfu::runtime::storage_service_api

#endif // KUNGFU_RUNTIME_STORAGE_PROJECTION_TRANSACTION_H
