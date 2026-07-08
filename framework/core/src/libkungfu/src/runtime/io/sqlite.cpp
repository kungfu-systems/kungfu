// SPDX-License-Identifier: Apache-2.0

//
// Created by Keren Dong on 2020/2/25.
//

#include <kungfu/common.h>
#include <kungfu/yijinjing/common.h>
#include <sqlite3.h>

namespace kungfu::yijinjing {
void handle_sql_error(int rc, const std::string &error_tip) {
  if (SQLITE_OK != rc) {
    SPDLOG_ERROR("sqlite3 rc {}", rc);
    throw yijinjing_error(error_tip);
  }
}

int sql_callback(void *, int argc, char **argv, char **azColName) {
  int i;
  for (i = 0; i < argc; i++) {
    SPDLOG_INFO("[sqlite3] callback: {} = {}", azColName[i], argv[i] ? argv[i] : "nullptr");
  }
  return 0;
}

void sqlite3_log(void *, int result_code, const char *msg) { SPDLOG_WARN("[sqlite3] [{}] {}", result_code, msg); }

struct sqlite_initilize {
  sqlite_initilize() {
    int rc = sqlite3_config(SQLITE_CONFIG_LOG, sqlite3_log, nullptr);
    handle_sql_error(rc, "failed to config sqlite3 log");
    rc = sqlite3_config(SQLITE_CONFIG_MMAP_SIZE, 1048577);
    handle_sql_error(rc, "failed to config sqlite3 map size");
    rc = sqlite3_config(SQLITE_CONFIG_MULTITHREAD);
    handle_sql_error(rc, "failed to config sqlite3 multithread");
    sqlite3_initialize();
  }
};

struct sqlite_shutdown {
  sqlite_shutdown() { sqlite3_shutdown(); }
};

void ensure_sqlite_initilize() { static sqlite_initilize instance{}; }

void ensure_sqlite_shutdown() { static sqlite_shutdown instance{}; }
} // namespace kungfu::yijinjing
