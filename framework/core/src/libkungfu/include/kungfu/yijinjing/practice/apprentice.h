// SPDX-License-Identifier: Apache-2.0

//
// Created by Keren Dong on 2019-06-01.
//

#ifndef KUNGFU_APPRENTICE_H
#define KUNGFU_APPRENTICE_H

#include <kungfu/yijinjing/cache/runtime.h>
#include <kungfu/yijinjing/io.h>
#include <kungfu/yijinjing/practice/hero.h>
#include <kungfu/yijinjing/time.h>

namespace kungfu::practice {
class apprentice;

class resource_manager {
public:
  explicit resource_manager(apprentice &app);

  virtual ~resource_manager();

  void on_react();

  std::thread &get_resource_management_worker();

private:
  practice::apprentice &app_;
  std::thread resource_management_worker;
  std::atomic<bool> m_quit_ = false;

  void do_management();

  [[nodiscard]] bool is_resource_management_worker_required() const;
};

class apprentice : public hero {
public:
  explicit apprentice(const yijinjing::data::location_ptr &home, bool low_latency = false, std::string arguments = "{}");

  explicit apprentice(const yijinjing::io_device_ptr &io_device, std::string arguments = "{}");

  bool is_started() const;

  void pause();

  uint32_t get_master_command_uid() const;

  int64_t get_last_active_time() const;

  int64_t get_checkin_time() const;

  const cache::bank &get_state_bank() const;

  void request_read_from(int64_t trigger_time, uint32_t source_id, int64_t from_time, uint64_t page_size = 0);

  void request_read_from_public(int64_t trigger_time, uint32_t source_id, int64_t from_time, uint64_t page_size = 0);

  void request_read_from_sync(int64_t trigger_time, uint32_t source_id, int64_t from_time, uint64_t page_size = 0);

  void request_read_from_source_to_dest(int64_t trigger_time, const yijinjing::data::location_ptr &source_location,
                                        uint32_t dest_id, uint64_t page_size = 0);

  void request_write_to(int64_t trigger_time, uint32_t dest_id, uint64_t page_size = 0);

  void request_write_to_band(int64_t trigger_time, const yijinjing::data::location_ptr &location, uint64_t page_size = 0);

  uint32_t request_band(const std::string &band_name, uint64_t page_size = 0);

  int32_t add_timer(int64_t nanotime, const std::function<void(const event_ptr &)> &callback);

  int32_t add_time_interval(int64_t nanotime, const std::function<void(const event_ptr &)> &callback);

  void clear_timer(int32_t timer_id);

  template <typename DataType> void write_to(int64_t trigger_time, const DataType &data, uint32_t dest_id) {
    get_writer(dest_id)->write(trigger_time, data);
  }

  template <typename DataType>
  void write_raw_to(int64_t trigger_time, int32_t msg_type, const DataType &data, uint32_t length, uint32_t dest_id) {
    get_writer(dest_id)->write_raw(trigger_time, msg_type, reinterpret_cast<uintptr_t>(&data), length);
  }

  template <typename DataType>
  void write_as(int64_t trigger_time, const DataType &data, uint32_t source_id, uint32_t dest_id) {
    get_writer(dest_id)->write_as(trigger_time, data, source_id, dest_id);
  }

  template <typename DataType>
  void try_write_to(
      int64_t trigger_time, const DataType &data, uint32_t dest_id, const std::function<void()> &callback = []() {}) {
    if (has_writer(dest_id)) {
      write_to(trigger_time, data, dest_id);
      callback();
    } else {
      events_ | rx::is(longfist::types::Channel::tag) | rx::filter([&, dest_id](const event_ptr &event) {
        const longfist::types::Channel &channel = event->data<longfist::types::Channel>();
        return channel.source_id == get_live_home_uid() and channel.dest_id == dest_id;
      }) | rx::first() |
          rx::$([&, trigger_time, data, dest_id, callback](const event_ptr &event) {
            write_to(trigger_time, data, dest_id);
            callback();
          });
      try_write_dest_ids_.emplace(dest_id);
    }
  }

  template <typename DataType>
  void try_write_raw_to(
      int64_t trigger_time, int32_t msg_type, const DataType &data, uint32_t length, uint32_t dest_id,
      const std::function<void()> &callback = []() {}) {
    if (has_writer(dest_id)) {
      write_raw_to(trigger_time, msg_type, data, length, dest_id);
      callback();
    } else {
      events_ | rx::is(longfist::types::Channel::tag) | rx::filter([&, dest_id](const event_ptr &event) {
        const longfist::types::Channel &channel = event->data<longfist::types::Channel>();
        return channel.source_id == get_live_home_uid() and channel.dest_id == dest_id;
      }) | rx::first() |
          rx::$([&, trigger_time, msg_type, data, length, dest_id](const event_ptr &event) {
            write_raw_to(trigger_time, msg_type, data, length, dest_id);
            callback();
          });
      try_write_dest_ids_.emplace(dest_id);
    }
  }

  template <typename DataType>
  void try_write_as(
      int64_t trigger_time, const DataType &data, uint32_t source_id, uint32_t dest_id,
      const std::function<void()> &callback = []() {}) {
    if (has_writer(dest_id)) {
      write_as(trigger_time, data, source_id, dest_id);
      callback();
    } else {
      events_ | rx::is(longfist::types::Channel::tag) | rx::filter([&, dest_id](const event_ptr &event) {
        const longfist::types::Channel &channel = event->data<longfist::types::Channel>();
        return channel.source_id == get_live_home_uid() and channel.dest_id == dest_id;
      }) | rx::first() |
          rx::$([&, trigger_time, data, source_id, dest_id](const event_ptr &event) {
            write_as(trigger_time, data, source_id, dest_id);
            callback();
          });
      try_write_dest_ids_.emplace(dest_id);
    }
  }

  void release_page();

  template <class DataType> std::string make_nano_msg(uint32_t source, uint32_t dest, const DataType &data) const {
    auto now = this->now();
    nlohmann::json request;
    request["data_type"] = int8_t(longfist::enums::FrameDataType::Json);
    request["msg_type"] = DataType::tag;
    request["gen_time"] = now;
    request["trigger_time"] = now;
    request["initial_source"] = get_live_home_uid();
    request["source"] = source;
    request["dest"] = dest;
    request["data"] = data.to_string();
    return request.dump();
  }

  const std::string &get_arguments() const { return arguments_; }

  std::thread &get_resource_management_worker();

  void preload_next_page();

  yijinjing::journal::writer_ptr &get_thread_writer(uint64_t page_size = 0);

  yijinjing::journal::writer_ptr &get_public_writer();

protected:
  cache::bank state_bank_;
  yijinjing::journal::writer_ptr master_cmd_writer_for_thread_ = nullptr;
  yijinjing::journal::writer_ptr public_writer_ = nullptr;
  inline static thread_local yijinjing::journal::writer_ptr thread_writer_ = nullptr;

  friend void add_location(practice::apprentice &app, const yijinjing::data::location_ptr &location) {
    app.add_location(app.now(), location);
  }

  void react() override;

  void on_active() override;

  void on_frame() override;

  virtual void on_react();

  virtual void on_start();

  virtual void on_register(int64_t trigger_time, const longfist::types::Register &register_data);

  virtual void on_deregister(const event_ptr &event);

  void on_read_from(const event_ptr &event);

  void on_read_from_public(const event_ptr &event);

  void on_read_from_sync(const event_ptr &event);

  void on_request_read_from_others(const event_ptr &event);

  virtual void on_write_to(const event_ptr &event);

  virtual void on_write_to_band(const event_ptr &event);

  int get_observer_recv_timeout() const;

  int32_t get_timer_usage_count() { return timer_usage_count_++; }

  void reader_join(uint32_t source_id, uint32_t dest_id, int64_t from_time, uint64_t page_size = 0);

  std::function<rx::observable<event_ptr>(rx::observable<event_ptr>)> timer(int64_t nanotime, int32_t timer_id) {
    enable_timer(timer_id);
    auto writer = get_writer(get_master_command_uid());
    int64_t duration_ns = nanotime - now();
    longfist::types::TimeRequest &r = writer->open_data<longfist::types::TimeRequest>(now());
    r.id = timer_id;
    r.base_time = now();
    r.duration = duration_ns;
    r.repeat = 1;
    r.location_uid = get_live_home_uid();
    writer->close_data();
    timer_checkpoints_[timer_id] = now();
    return [&, duration_ns, timer_id](const rx::observable<event_ptr> &src) {
      return events_ | rx::filter([&, duration_ns, timer_id](const event_ptr &event) {
               return (event->msg_type() == longfist::types::Time::tag &&
                       event->gen_time() >= timer_checkpoints_[timer_id] + duration_ns);
             }) |
             rx::first() | rx::filter([&, timer_id](const event_ptr &) {
               timer_checkpoints_.erase(timer_id);
               bool enabled = is_timer_enabled(timer_id);
               timers_.erase(timer_id);
               if (not enabled) {
                 SPDLOG_WARN("timer for timer_id {} is disabled", timer_id);
               }
               return enabled;
             });
    };
  }

  template <typename Duration, typename Enabled = rx::is_duration<Duration>>
  std::function<rx::observable<event_ptr>(rx::observable<event_ptr>)> time_interval(Duration &&d, int32_t timer_id) {
    enable_timer(timer_id);
    auto duration_ns = std::chrono::duration_cast<std::chrono::nanoseconds>(d).count();
    auto writer = get_writer(get_master_command_uid());
    longfist::types::TimeRequest &r = writer->open_data<longfist::types::TimeRequest>(now());
    r.id = timer_id;
    r.base_time = now();
    r.duration = duration_ns;
    r.repeat = 1;
    r.location_uid = get_live_home_uid();
    writer->close_data();
    timer_checkpoints_[timer_id] = now();
    return [&, duration_ns, timer_id](const rx::observable<event_ptr> &src) {
      return events_ | rx::take_until(events_ | rx::filter([&, timer_id](const event_ptr &event) {
                                        bool enabled = is_timer_enabled(timer_id);
                                        if (not enabled) {
                                          SPDLOG_WARN("interval timer for timer_id {} is disabled", timer_id);
                                          timers_.erase(timer_id);
                                          timer_checkpoints_.erase(timer_id);
                                        }
                                        return not enabled;
                                      })) |
             rx::filter([&, duration_ns, timer_id](const event_ptr &event) {
               if (event->msg_type() == longfist::types::Time::tag &&
                   event->gen_time() >= timer_checkpoints_[timer_id] + duration_ns) {
                 auto writer = get_writer(get_master_command_uid());
                 longfist::types::TimeRequest &r = writer->open_data<longfist::types::TimeRequest>(now());
                 r.id = timer_id;
                 r.base_time = timer_checkpoints_[timer_id] + duration_ns;
                 r.duration = duration_ns;
                 r.repeat = 1;
                 r.location_uid = get_live_home_uid();
                 writer->close_data();
                 timer_checkpoints_[timer_id] = timer_checkpoints_[timer_id] + duration_ns;
                 return true;
               } else {
                 return false;
               }
             });
    };
  }

  template <typename Duration, typename Enabled = rx::is_duration<Duration>>
  std::function<rx::observable<event_ptr>(rx::observable<event_ptr>)> timeout(Duration &&d, int32_t timer_id) {
    enable_timer(timer_id);
    auto duration_ns = std::chrono::duration_cast<std::chrono::nanoseconds>(d).count();
    auto writer = get_writer(get_master_command_uid());
    longfist::types::TimeRequest &r = writer->open_data<longfist::types::TimeRequest>(now());
    r.id = timer_id;
    r.base_time = now();
    r.duration = duration_ns;
    r.repeat = 1;
    r.location_uid = get_live_home_uid();
    writer->close_data();
    timer_checkpoints_[timer_id] = now();
    return [&, duration_ns, timer_id](const rx::observable<event_ptr> &src) {
      return (src | rx::take_until(events_ | rx::filter([&, timer_id](const event_ptr &event) {
                                     return not is_timer_enabled(timer_id);
                                   })) |
              rx::filter([&, duration_ns, timer_id](const event_ptr &event) {
                if (event->msg_type() != longfist::types::Time::tag) {
                  auto writer = get_writer(get_master_command_uid());
                  longfist::types::TimeRequest &r = writer->open_data<longfist::types::TimeRequest>(now());
                  r.id = timer_id;
                  r.base_time = now();
                  r.duration = duration_ns;
                  r.repeat = 1;
                  r.location_uid = get_live_home_uid();
                  writer->close_data();
                  timer_checkpoints_[timer_id] = now();
                  return true;
                } else {
                  return false;
                }
              }))
          .merge(events_ | rx::filter([&, duration_ns, timer_id](const event_ptr &event) {
                   if (event->gen_time() >= timer_checkpoints_[timer_id] + duration_ns) {
                     throw rx::timeout_error("timeout");
                   }
                   return false;
                 }));
    };
  }

private:
  resource_manager manager_;
  bool started_ = false;
  int64_t last_active_time_ = INT64_MIN;
  int64_t checkin_time_ = INT64_MIN;
  int32_t timer_usage_count_{0};
  const std::string arguments_ = {};
  std::unordered_map<int, int64_t> timer_checkpoints_ = {};
  std::unordered_set<uint32_t> try_write_dest_ids_ = {};
  std::unordered_map<int32_t, bool> timers_ = {};

  void checkin();

  void expect_start();

  template <typename DataType> void do_read_from(const event_ptr &event, uint32_t dest_id) {
    const DataType &request = event->data<DataType>();
    reader_->join(get_location(request.source_id), dest_id, request.from_time);
  }

  static void reset_time(const longfist::types::TimeReset &time_reset);

  bool is_timer_enabled(int32_t timer_id);

  void enable_timer(int32_t timer_id);
};

DECLARE_PTR(apprentice)
} // namespace kungfu::practice

#endif // KUNGFU_APPRENTICE_H
