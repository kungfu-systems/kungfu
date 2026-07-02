// SPDX-License-Identifier: Apache-2.0

//
// Created by Keren Dong on 2020/3/27.
//

#ifndef KUNGFU_SESSION_H
#define KUNGFU_SESSION_H

#include <kungfu/common.h>
#include <kungfu/longfist/longfist.h>
#include <kungfu/yijinjing/cache/backend.h>
#include <kungfu/yijinjing/io.h>
#include <kungfu/yijinjing/journal/journal.h>
#include <kungfu/yijinjing/time.h>

namespace kungfu::index {
typedef std::vector<longfist::types::Session> SessionVector;
typedef std::unordered_map<uint32_t, longfist::types::Session> SessionMap;

class session_finder {
public:
  explicit session_finder(const yijinjing::io_device_ptr &io_device);

  virtual ~session_finder();

  virtual int64_t find_last_active_time(const yijinjing::data::location_ptr &source_location);

  SessionVector find_sessions(int64_t from = 0, int64_t to = INT64_MAX);

  SessionVector find_sessions_for(const yijinjing::data::location_ptr &source_location, int64_t from = 0, int64_t to = INT64_MAX);

protected:
  yijinjing::io_device_ptr io_device_;
  cache::SessionStoragePtr session_storage_;
};

class session_builder : public session_finder {
public:
  explicit session_builder(const yijinjing::io_device_ptr &io_device);

  int64_t find_last_active_time(const yijinjing::data::location_ptr &source_location) override;

  longfist::types::Session &open_session(const yijinjing::data::location_ptr &source_location, int64_t time);

  void close_session(const yijinjing::data::location_ptr &source_location, int64_t time);

  void close_all_sessions(int64_t time);

  void update_session(const yijinjing::journal::frame_ptr &frame);

  void rebuild_index_db();

  void update_index_db();

  SessionMap &get_all_sessions();

private:
  SessionMap live_sessions_ = {};
  std::mutex update_session_mutex_;
};
} // namespace kungfu::index

#endif // KUNGFU_SESSION_H
