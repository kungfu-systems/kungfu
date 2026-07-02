// SPDX-License-Identifier: Apache-2.0

//
// Created by Keren Dong on 2019-06-15.
//

#ifndef KUNGFU_MASTER_H
#define KUNGFU_MASTER_H

#include <kungfu/yijinjing/cache/cached.h>
#include <kungfu/yijinjing/io.h>
#include <kungfu/yijinjing/journal/common.h>
#include <kungfu/yijinjing/practice/hero.h>

namespace kungfu::practice {

struct timer_task {
  int64_t checkpoint;
  int64_t duration;
  int64_t repeat_limit;
  int64_t repeat_count;
};

class master : public hero {
public:
  explicit master(const yijinjing::data::location_ptr &home, bool low_latency = false);

  explicit master(const yijinjing::io_device_ptr &io_device);

  void on_exit() override;

  void notify_deregister_on_exit();

  void notify_master_deregister_on_exit();

  void mark_session_end_on_exit();

  void on_notify() override;

  virtual void on_register(int64_t gen_time, const longfist::types::Register &register_data) = 0;

  virtual bool check_register(int64_t gen_time, const longfist::types::Register &register_data) = 0;

  virtual void on_interval_check(int64_t nanotime) = 0;

  void register_app(const event_ptr &event);

  void deregister_app(int64_t trigger_time, uint32_t app_location_uid);

  void on_request_deregister(const event_ptr &event);

  bool is_reactable(const event_ptr &event) override;

  void pre_setup() override;

protected:
  int64_t last_check_;
  cache::cached cached_;

  std::unordered_map<uint32_t, uint32_t> app_cmd_locations_ = {};
  std::unordered_map<uint32_t, std::unordered_map<int32_t, timer_task>> timer_tasks_ = {};

  void react() override;

  void on_active() final;

  void on_frame() final;

  void try_add_location(int64_t trigger_time, const yijinjing::data::location_ptr &app_location);

private:
  void handle_timer_tasks();

  void feed(const event_ptr &event);

  void pong(const event_ptr &event);

  void on_request_write_to_band(const event_ptr &event);

  void on_request_write_to(const event_ptr &event);

  void on_request_read_from(const event_ptr &event);

  void on_request_read_from_public(const event_ptr &event);

  void on_request_read_from_sync(const event_ptr &event);

  void on_request_read_from_others(const event_ptr &event);

  void on_channel_request(const event_ptr &event);

  void on_time_request(const event_ptr &event);

  void on_new_location(const event_ptr &event);

  static void write_time_reset(int64_t trigger_time, const yijinjing::journal::writer_ptr &writer);

  void write_locations(int64_t trigger_time, const yijinjing::journal::writer_ptr &writer);

  void write_registries(int64_t trigger_time, const yijinjing::journal::writer_ptr &writer);

  void write_channels(int64_t trigger_time, const yijinjing::journal::writer_ptr &writer);

  void write_bands(int64_t trigger_time, const yijinjing::journal::writer_ptr &writer);
};
} // namespace kungfu::practice
#endif // KUNGFU_MASTER_H
