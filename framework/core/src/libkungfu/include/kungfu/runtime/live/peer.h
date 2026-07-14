// SPDX-License-Identifier: Apache-2.0

//
// Created by Keren Dong on 2019-06-01.
//

#ifndef KUNGFU_RUNTIME_LIVE_PEER_H
#define KUNGFU_RUNTIME_LIVE_PEER_H

#include <kungfu/runtime/common.h>

#include <kungfu/runtime/io.h>
#include <kungfu/runtime/live/reactor.h>
#include <kungfu/runtime/projection_bootstrap.h>
#include <kungfu/runtime/state_cache/model.h>
#include <kungfu/yijinjing/time.h>

namespace kungfu::runtime::live {
class peer;

class resource_manager {
public:
  explicit resource_manager(peer &runtime_peer);

  virtual ~resource_manager();

  void on_react();

  std::thread &get_resource_management_worker();

private:
  peer &peer_;
  std::thread resource_management_worker;
  std::atomic<bool> m_quit_ = false;

  void do_management();

  [[nodiscard]] bool is_resource_management_worker_required() const;
};

class peer : public reactor {
public:
  explicit peer(const yijinjing::data::location_ptr &home, bool low_latency = false, std::string arguments = "{}");

  explicit peer(const kungfu::runtime::io_device_ptr &io_device, std::string arguments = "{}");

  bool is_started() const;

  void pause();

  uint32_t get_coordinator_command_uid() const;

  int64_t get_checkin_time() const;

  const state_cache::bank &get_state_bank() const;

  [[nodiscard]] const state_service::projection_candidate_status_view &get_projection_candidate_status() const;

  // observe() now lives on the common base reactor (peer + coordinator share it).

  void request_read_from(int64_t trigger_time, uint32_t source_id, int64_t from_time, uint64_t page_size = 0);

  void request_read_from_public(int64_t trigger_time, uint32_t source_id, int64_t from_time, uint64_t page_size = 0);

  void request_read_from_sync(int64_t trigger_time, uint32_t source_id, int64_t from_time, uint64_t page_size = 0);

  void request_read_from_source_to_dest(int64_t trigger_time, const yijinjing::data::location_ptr &source_location,
                                        uint32_t dest_id, uint64_t page_size = 0);

  void request_write_to(int64_t trigger_time, uint32_t dest_id, uint64_t page_size = 0);

  void request_write_to_outlet(int64_t trigger_time, const yijinjing::data::location_ptr &location,
                               uint64_t page_size = 0);

  uint32_t request_outlet(const std::string &outlet_name, uint64_t page_size = 0);

  int32_t add_timer(int64_t nanotime, const std::function<void(const event_ptr &)> &callback);

  int32_t add_time_interval(int64_t nanotime, const std::function<void(const event_ptr &)> &callback);

  void clear_timer(int32_t timer_id);

  template <typename DataType> void write_to(int64_t trigger_time, const DataType &data, uint32_t dest_id) {
    get_writer(dest_id)->write(trigger_time, data);
  }

  template <typename DataType>
  void write_raw_to(int64_t trigger_time, int32_t carrier_type, const DataType &data, uint32_t length,
                    uint32_t dest_id) {
    get_writer(dest_id)->write_raw(trigger_time, carrier_type, reinterpret_cast<uintptr_t>(&data), length);
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
      events_ | rx::is(yijinjing::types::Channel::tag) | rx::filter([&, dest_id](const event_ptr &event) {
        const yijinjing::types::Channel &channel = event->data<yijinjing::types::Channel>();
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
      int64_t trigger_time, int32_t carrier_type, const DataType &data, uint32_t length, uint32_t dest_id,
      const std::function<void()> &callback = []() {}) {
    if (has_writer(dest_id)) {
      write_raw_to(trigger_time, carrier_type, data, length, dest_id);
      callback();
    } else {
      events_ | rx::is(yijinjing::types::Channel::tag) | rx::filter([&, dest_id](const event_ptr &event) {
        const yijinjing::types::Channel &channel = event->data<yijinjing::types::Channel>();
        return channel.source_id == get_live_home_uid() and channel.dest_id == dest_id;
      }) | rx::first() |
          rx::$([&, trigger_time, carrier_type, data, length, dest_id](const event_ptr &event) {
            write_raw_to(trigger_time, carrier_type, data, length, dest_id);
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
      events_ | rx::is(yijinjing::types::Channel::tag) | rx::filter([&, dest_id](const event_ptr &event) {
        const yijinjing::types::Channel &channel = event->data<yijinjing::types::Channel>();
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
    request["data_type"] = int8_t(yijinjing::enums::FrameDataType::Json);
    request["carrier_type"] = DataType::tag;
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
  state_cache::bank state_bank_;
  yijinjing::journal::writer_ptr coordinator_cmd_writer_for_thread_ = nullptr;
  yijinjing::journal::writer_ptr public_writer_ = nullptr;
  inline static thread_local yijinjing::journal::writer_ptr thread_writer_ = nullptr;

  friend void add_location(peer &runtime_peer, const yijinjing::data::location_ptr &location) {
    runtime_peer.add_location(runtime_peer.now(), location);
  }

  void react() override;

  void on_active() override;

  void on_frame() override;

  virtual void on_react();

  virtual void on_start();

  virtual void on_register(int64_t trigger_time, const yijinjing::types::Register &register_data);

  virtual void on_deregister(const event_ptr &event);

  void on_read_from(const event_ptr &event);

  void on_read_from_public(const event_ptr &event);

  void on_read_from_sync(const event_ptr &event);

  void on_request_read_from_others(const event_ptr &event);

  virtual void on_write_to(const event_ptr &event);

  virtual void on_write_to_outlet(const event_ptr &event);

  int get_observer_recv_timeout() const;

  int32_t get_timer_usage_count() { return timer_usage_count_++; }

  void reader_join(uint32_t source_id, uint32_t dest_id, int64_t from_time, uint64_t page_size = 0);

  // --- journal-time timer helpers (shared by timer / time_interval / timeout) ---
  // Ask the coordinator, via a TimeRequest, for a Time event at base_time + duration.
  void send_time_request(int32_t timer_id, int64_t base_time, int64_t duration_ns) {
    auto writer = get_writer(get_coordinator_command_uid());
    yijinjing::types::TimeRequest &r = writer->open_data<yijinjing::types::TimeRequest>(now());
    r.id = timer_id;
    r.base_time = base_time;
    r.duration = duration_ns;
    r.repeat = 1;
    r.location_uid = get_live_home_uid();
    writer->close_data();
  }

  // Enable the timer and arm its first tick at now() + duration.
  void arm_timer(int32_t timer_id, int64_t duration_ns) {
    enable_timer(timer_id);
    send_time_request(timer_id, now(), duration_ns);
    timer_checkpoints_[timer_id] = now();
  }

  // Drop all state for a timer once it has fired or been disabled.
  void disarm_timer(int32_t timer_id) {
    timer_checkpoints_.erase(timer_id);
    timers_.erase(timer_id);
  }

  // True when a Time event has reached this timer's checkpoint. Uses find, not
  // operator[], so a missing checkpoint never silently re-inserts a zero deadline.
  bool timer_due(const event_ptr &event, int32_t timer_id, int64_t duration_ns) const {
    if (event->carrier_type() != yijinjing::types::Time::tag) {
      return false;
    }
    auto it = timer_checkpoints_.find(timer_id);
    return it != timer_checkpoints_.end() and event->gen_time() >= it->second + duration_ns;
  }

  std::function<rx::observable<event_ptr>(rx::observable<event_ptr>)> timer(int64_t nanotime, int32_t timer_id) {
    int64_t duration_ns = nanotime - now();
    arm_timer(timer_id, duration_ns);
    return [&, duration_ns, timer_id](const rx::observable<event_ptr> &src) {
      return events_ | rx::filter([&, duration_ns, timer_id](const event_ptr &event) {
               return timer_due(event, timer_id, duration_ns);
             }) |
             rx::first() | rx::filter([&, timer_id](const event_ptr &) {
               bool enabled = is_timer_enabled(timer_id);
               disarm_timer(timer_id);
               if (not enabled) {
                 SPDLOG_WARN("timer for timer_id {} is disabled", timer_id);
               }
               return enabled;
             });
    };
  }

  template <typename Duration, typename Enabled = rx::is_duration<Duration>>
  std::function<rx::observable<event_ptr>(rx::observable<event_ptr>)> time_interval(Duration &&d, int32_t timer_id) {
    auto duration_ns = std::chrono::duration_cast<std::chrono::nanoseconds>(d).count();
    arm_timer(timer_id, duration_ns);
    return [&, duration_ns, timer_id](const rx::observable<event_ptr> &src) {
      return events_ | rx::take_until(events_ | rx::filter([&, timer_id](const event_ptr &event) {
                                        bool enabled = is_timer_enabled(timer_id);
                                        if (not enabled) {
                                          SPDLOG_WARN("interval timer for timer_id {} is disabled", timer_id);
                                          disarm_timer(timer_id);
                                        }
                                        return not enabled;
                                      })) |
             rx::filter([&, duration_ns, timer_id](const event_ptr &event) {
               if (not timer_due(event, timer_id, duration_ns)) {
                 return false;
               }
               // periodic: re-arm the next tick and advance the checkpoint by one duration
               int64_t next_base = timer_checkpoints_[timer_id] + duration_ns;
               send_time_request(timer_id, next_base, duration_ns);
               timer_checkpoints_[timer_id] = next_base;
               return true;
             });
    };
  }

  // Deterministic, replayable business timeout for use AFTER the peer is live.
  // It drives off journal Time events from the coordinator, so it is only valid
  // once the coordinator serves this peer's TimeRequest. It must NOT be used for
  // the register handshake: during the handshake the peer is not yet live and
  // coordinator::on_time_request drops its TimeRequest, so the deadline would
  // never fire. The register handshake uses a wall-clock deadline checked from
  // on_active instead.
  template <typename Duration, typename Enabled = rx::is_duration<Duration>>
  std::function<rx::observable<event_ptr>(rx::observable<event_ptr>)> timeout(Duration &&d, int32_t timer_id) {
    auto duration_ns = std::chrono::duration_cast<std::chrono::nanoseconds>(d).count();
    arm_timer(timer_id, duration_ns);
    return [&, duration_ns, timer_id](const rx::observable<event_ptr> &src) {
      return (src | rx::take_until(events_ | rx::filter([&, timer_id](const event_ptr &event) {
                                     return not is_timer_enabled(timer_id);
                                   })) |
              rx::filter([&, duration_ns, timer_id](const event_ptr &event) {
                if (event->carrier_type() == yijinjing::types::Time::tag) {
                  return false;
                }
                // any non-Time activity resets the idle deadline
                send_time_request(timer_id, now(), duration_ns);
                timer_checkpoints_[timer_id] = now();
                return true;
              }))
          .merge(events_ | rx::filter([&, duration_ns, timer_id](const event_ptr &event) {
                   auto it = timer_checkpoints_.find(timer_id);
                   if (it != timer_checkpoints_.end() and event->gen_time() >= it->second + duration_ns) {
                     throw rx::timeout_error("timeout");
                   }
                   return false;
                 }));
    };
  }

private:
  resource_manager manager_;
  bool started_ = false;
  bool registered_ = false;
  int64_t checkin_time_ = INT64_MIN;
  // Wall-clock deadline (ns) for the LIVE register handshake. The handshake runs
  // before the peer is live, so the coordinator's journal time service does not
  // serve it; on_active checks this against wall-clock on the observer
  // recv_timeout heartbeat instead of a background rx::timeout thread.
  int64_t register_deadline_ = INT64_MAX;
  int32_t timer_usage_count_{0};
  const std::string arguments_ = {};
  state_service::peer_projection_declaration projection_declaration_ = {};
  state_service::projection_candidate_status_view projection_candidate_status_ = {};
  std::unordered_map<int, int64_t> timer_checkpoints_ = {};
  std::unordered_set<uint32_t> try_write_dest_ids_ = {};
  std::unordered_map<int32_t, bool> timers_ = {};

  void checkin();

  void expect_start();

  template <typename DataType> void do_read_from(const event_ptr &event, uint32_t dest_id) {
    const DataType &request = event->data<DataType>();
    reader_->join(get_location(request.source_id), dest_id, request.from_time);
  }

  static void reset_time(const yijinjing::types::TimeReset &time_reset);

  bool is_timer_enabled(int32_t timer_id);

  void enable_timer(int32_t timer_id);
};

DECLARE_PTR(peer)
} // namespace kungfu::runtime::live

#endif // KUNGFU_RUNTIME_LIVE_PEER_H
