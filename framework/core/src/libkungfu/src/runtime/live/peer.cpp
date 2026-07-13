// SPDX-License-Identifier: Apache-2.0

//
// Created by Keren Dong on 2019-06-01.
//

#include <kungfu/common.h>
#include <kungfu/runtime/live/peer.h>
#include <kungfu/runtime/os.h>
#include <kungfu/runtime/state_cache/manager.h>
#include <kungfu/runtime/util/terminal.h>
#include <utility>

using namespace kungfu::rx;
using namespace kungfu::yijinjing;
using namespace kungfu::yijinjing::types;
using namespace kungfu::yijinjing::enums;
using namespace kungfu::runtime;
using namespace kungfu::yijinjing::data;
using namespace kungfu::runtime::state_cache;
using namespace std::chrono;
namespace fs = std::filesystem;

namespace kungfu::runtime::live {

peer::peer(const yijinjing::data::location_ptr &home, bool low_latency, std::string arguments)
    : peer(std::make_shared<kungfu::runtime::io_device_peer>(home, low_latency), std::move(arguments)) {}

peer::peer(const kungfu::runtime::io_device_ptr &io_device, std::string arguments)
    : reactor(io_device), manager_(*this), arguments_(std::move(arguments)) {}

bool peer::is_started() const { return started_; }

void peer::pause() { started_ = false; }

uint32_t peer::get_coordinator_command_uid() const { return coordinator_cmd_location_->uid; }

int64_t peer::get_checkin_time() const { return checkin_time_; }

const state_cache::bank &peer::get_state_bank() const { return state_bank_; }

void peer::request_read_from(int64_t trigger_time, uint32_t source_id, int64_t from_time, uint64_t page_size) {
  require_read_from(trigger_time, get_coordinator_command_uid(), source_id, from_time, page_size);
}

void peer::request_read_from_public(int64_t trigger_time, uint32_t source_id, int64_t from_time, uint64_t page_size) {
  require_read_from_public(trigger_time, get_coordinator_command_uid(), source_id, from_time, page_size);
}

void peer::request_read_from_sync(int64_t trigger_time, uint32_t source_id, int64_t from_time, uint64_t page_size) {
  require_read_from_sync(trigger_time, get_coordinator_command_uid(), source_id, from_time, page_size);
}

void peer::request_read_from_source_to_dest(int64_t trigger_time, const location_ptr &source_location, uint32_t dest_id,
                                            uint64_t page_size) {
  reader_join(source_location->uid, dest_id, trigger_time, page_size);
}

void peer::request_write_to(int64_t trigger_time, uint32_t dest_id, uint64_t page_size) {
  require_write_to(trigger_time, get_coordinator_command_uid(), dest_id, page_size);
}

void peer::request_write_to_outlet(int64_t trigger_time, const location_ptr &location, uint64_t page_size) {
  require_write_to_outlet(trigger_time, get_coordinator_command_uid(), location, page_size);
}

uint32_t peer::request_outlet(const std::string &outlet_name, uint64_t page_size) {
  auto io_device = get_io_device();
  auto home = io_device->get_live_home();
  auto outlet_location = location::make_shared(home->mode, home->role, home->namespace_, outlet_name, get_locator());
  request_write_to_outlet(now(), outlet_location, page_size);
  return outlet_location->uid;
}

int32_t peer::add_timer(int64_t nanotime, const std::function<void(const event_ptr &)> &callback) {
  int32_t timer_id = get_timer_usage_count();
  events_ | timer(nanotime, timer_id) | $([&, callback](const event_ptr &event) { callback(event); });
  return timer_id;
}

int32_t peer::add_time_interval(int64_t duration, const std::function<void(const event_ptr &)> &callback) {
  int32_t timer_id = get_timer_usage_count();
  events_ | time_interval(std::chrono::nanoseconds(duration), timer_id) |
      $([&, callback](const event_ptr &event) { callback(event); });
  return timer_id;
}

void peer::release_page() {
  reader_->release_page();
  for (auto &iter : get_writers()) {
    iter.second->release_page();
  }
}

void peer::preload_next_page() {
  reader_->preload_next_page();
  for (auto &iter : get_writers()) {
    iter.second->preload_next_page();
  }
}

void peer::react() {

  SPDLOG_TRACE("building reactive event handlers");
  on_react();
  manager_.on_react();

  if (get_io_device()->get_home()->mode != mode::BACKTEST) {
    events_ | is(Location::tag) | $$(add_location(event->gen_time(), event->data<Location>()));
    events_ | is(Register::tag) | $$(on_register(event->trigger_time(), event->data<Register>()));
    events_ | is(RequestReadFromOthers::tag) | $$(on_request_read_from_others(event));
    events_ | is(RequestReadFrom::tag) | $$(on_read_from(event));
    events_ | is(RequestReadFromPublic::tag) | $$(on_read_from_public(event));
    events_ | is(RequestReadFromSync::tag) | $$(on_read_from_sync(event));
    events_ | is(RequestWriteTo::tag) | $$(on_write_to(event));
    events_ | is(RequestWriteToOutlet::tag) | $$(on_write_to_outlet(event));
    events_ | is(Channel::tag) | $$(register_channel(event->gen_time(), event->data<Channel>()));
    events_ | is(Outlet::tag) | $$(register_outlet(event->gen_time(), event->data<Outlet>()));
    events_ | is(RequestStop::tag) | to(get_live_home_uid()) | $$(signal_stop());
    events_ | take_until(events_ | is(RequestStart::tag)) | $$(manager::feed_state_data(event, state_bank_));
    events_ | is(Deregister::tag) | $$(on_deregister(event));
    events_ | is(TimeReset::tag) | first() | $$(reset_time(event->data<TimeReset>()));
  }

  if (get_io_device()->get_home()->mode == mode::LIVE) {
    // Deterministic, thread-free register handshake timeout. The peer is not yet
    // live during the handshake, so the coordinator's journal time service does
    // not serve it; instead of a background rx::timeout thread we set a
    // wall-clock deadline that on_active checks on the observer recv_timeout
    // heartbeat.
    register_deadline_ =
        yijinjing::time::now_in_nano() + REGISTER_TIMEOUT_SECONDS * yijinjing::time_unit::NANOSECONDS_PER_SECOND;

    auto self_register_event = events_ | skip_until(events_ | is(Register::tag) | filter([&](const event_ptr &event) {
                                                      auto uid = event->data<Register>().location_uid;
                                                      return uid == get_live_home_uid();
                                                    })) |
                               first();

    self_register_event | $([&](const event_ptr &event) {
      registered_ = true;
      auto data = event->data<Register>();
      checkin_time_ = data.checkin_time;
      // in case operation-system time change, begin_time_ mismatch clock of coordinator, keep using event->gen_time()
      reader_->join(coordinator_cmd_location_, get_live_home_uid(), event->gen_time());
    });

    expect_start();
    checkin();
  }
  if (get_io_device()->get_home()->mode == mode::REPLAY) {
    reader_->join(coordinator_cmd_location_, get_live_home_uid(), begin_time_);
    expect_start();

    auto exceed_end_time_check =
        events_ | skip_until(events_ | filter([&](const event_ptr &event) { return event->gen_time() > end_time_; })) |
        first();
    exceed_end_time_check | $([&](const event_ptr &event) { request_deregister(); });
  }
  if (get_io_device()->get_home()->mode == mode::BACKTEST) {
    std::string journal_dir = get_locator()->layout_dir(get_home(), layout::JOURNAL);
    fs::remove_all(journal_dir);
    std::string coordinator_cmd_dir = get_locator()->layout_dir(coordinator_cmd_location_, layout::JOURNAL);
    fs::remove_all(coordinator_cmd_dir);
    auto peer_cmd_writer = get_io_device()->open_writer_at(coordinator_cmd_location_, get_home_uid());

    {
      std::lock_guard<std::mutex> lock(writers_mtx_);
      writers_.insert_or_assign(get_home_uid(), peer_cmd_writer);
    }
    reader_->join(coordinator_cmd_location_, get_home_uid(), begin_time_);
    auto public_writer = get_io_device()->open_writer(location::PUBLIC);
    {
      std::lock_guard<std::mutex> lock(writers_mtx_);
      writers_.insert_or_assign(location::PUBLIC, std::move(public_writer));
    }
    reader_->join(get_home(), location::PUBLIC, begin_time_);
    started_ = true;
    on_start();
  }
}

void peer::on_active() {
  // Register handshake timeout, checked on the recv_timeout heartbeat: on_active
  // is driven by produce() even when the coordinator is silent, so this is the
  // one live path during a stalled handshake. Wall-clock, because the peer has
  // no trustworthy journal time before it is live.
  if (registered_ or get_io_device()->get_home()->mode != mode::LIVE) {
    return;
  }
  if (yijinjing::time::now_in_nano() >= register_deadline_) {
    registered_ = true; // report once and stop checking
    SPDLOG_ERROR("peer register timeout");
    reactor::signal_stop();
  }
}

void peer::on_frame() {
  // request_write_to the dest which from try_write_to
  for (const uint32_t dest_id : try_write_dest_ids_) {
    request_write_to(now(), dest_id);
  }
  try_write_dest_ids_.clear();
}

void peer::on_react() {}

void peer::on_start() {}

void peer::observe(int32_t carrier_type, const std::function<void(const event_ptr &)> &callback) {
  // Same shape as the built-in react() subscriptions, but the handler is
  // supplied by the caller (e.g. a Python subclass). Capture the callback by
  // value so it outlives this call and lives for the reactor's lifetime.
  events_ | is(carrier_type) | $([callback](const event_ptr &event) { callback(event); });
}

void peer::on_register(int64_t trigger_time, const Register &register_data) {
  register_location(trigger_time, register_data);
}

void peer::on_deregister(const event_ptr &event) {
  const auto &deregister = event->data<Deregister>();
  SPDLOG_DEBUG("deregister: {}", deregister.to_string());
  uint32_t location_uid = event->data<Deregister>().location_uid;
  SPDLOG_DEBUG("deregister peer {}", get_location_uname(location_uid));
  if (location_uid == get_live_home_uid()) {
    if (get_home()->mode == mode::REPLAY) {
      SPDLOG_WARN("deregister peer in replay mode");
      request_deregister();
    }
    return;
  }

  if (has_location(location_uid)) {
    disjoin(get_location(location_uid));
  }
  deregister_channel(location_uid);
  deregister_outlet(location_uid);
  deregister_location(event->trigger_time(), location_uid);
}

void peer::on_read_from(const event_ptr &event) { do_read_from<RequestReadFrom>(event, get_live_home_uid()); }

void peer::on_read_from_public(const event_ptr &event) { do_read_from<RequestReadFromPublic>(event, 0); }

void peer::on_read_from_sync(const event_ptr &event) { do_read_from<RequestReadFromSync>(event, location::SYNC); }

void peer::on_request_read_from_others(const event_ptr &event) {
  const auto &request = event->data<RequestReadFromOthers>();
  if (has_location(request.source_id)) {
    reader_->join(get_location(request.source_id), request.dest_id, request.from_time);
  }
}

void peer::on_write_to(const event_ptr &event) {
  const auto &request = event->data<RequestWriteTo>();
  auto dest_id = request.dest_id;
  if (not has_writer(dest_id)) {
    auto writer = get_io_device()->open_writer(dest_id, request.page_size);
    {
      std::lock_guard<std::mutex> lock(writers_mtx_);
      writers_.emplace(dest_id, std::move(writer));
    }
    if (dest_id == get_coordinator_command_uid()) {
      coordinator_cmd_writer_for_thread_ = get_writer(dest_id);
    }
    if (dest_id == location::PUBLIC) {
      public_writer_ = get_writer(location::PUBLIC);
    }
  }
}

void peer::on_write_to_outlet(const event_ptr &event) {
  const auto &request = event->data<RequestWriteToOutlet>();
  SPDLOG_DEBUG("RequestWriteToOutlet: {}", request.to_string());
  auto dest_id = request.location_uid;
  auto page_size = request.page_size;
  std::lock_guard<std::mutex> lk(off_thread_mtx_);
  if (off_thread_writers_.find(dest_id) == off_thread_writers_.end()) {
    off_thread_writers_.emplace(dest_id, get_io_device()->open_writer(dest_id, page_size));
  }
}

int peer::get_observer_recv_timeout() const { return get_io_device()->get_observer()->get_recv_timeout(); }

void peer::reader_join(uint32_t source_id, uint32_t dest_id, int64_t from_time, uint64_t page_size) {

  if (not has_location(source_id)) {
    SPDLOG_ERROR("no location {}", source_id);
    return;
  }

  reader_->join(get_location(source_id), dest_id, from_time);

  if (not has_writer(get_coordinator_command_uid())) {
    SPDLOG_ERROR("no coordinator cmd writer {}", get_coordinator_command_uid());
    return;
  }

  auto writer = get_writer(get_coordinator_command_uid());
  auto &request = writer->open_data<RequestReadFromOthers>(now());
  request.source_id = source_id;
  request.dest_id = dest_id;
  request.from_time = from_time;
  request.page_size = page_size;
  writer->close_data();
}

void peer::checkin() {
  auto now = yijinjing::time::now_in_nano();
  auto home = get_live_home();
  Register register_data{};
  register_data.mode = home->mode;
  register_data.role = home->role;
  register_data.namespace_ = home->namespace_;
  register_data.name = home->name;
  register_data.seed = home->seed;
  register_data.location_uid = home->uid;
  register_data.uid64 = home->uid64;
  register_data.pid = GETPID();
  register_data.checkin_time = now;
  SPDLOG_INFO("peer checkin Register: {}", register_data.to_string());

  auto try_register = [&]() {
    return get_io_device()->get_publisher()->publish(
               make_nano_msg(get_live_home_uid(), coordinator_home_location_->uid, register_data), 0, true) == 0;
  };

  int count = (REGISTER_TIMEOUT_SECONDS * 1000) / DEFAULT_NOTICE_TIMEOUT;
  while (not try_register()) {
    SPDLOG_WARN("try register failed, retrying...");

    if (count-- <= 0) {
      SPDLOG_ERROR("register failed");
      throw yijinjing_error("register failed");
    }
  }

  SPDLOG_INFO("peer checkin done");
}

void peer::expect_start() {
  reader_->join(coordinator_home_location_, location::PUBLIC, begin_time_);
  events_ | is(RequestStart::tag) | first() | $([&](const event_ptr &event) {
    started_ = true;
    SPDLOG_INFO("ready to start");
    on_start();
  });
}

void peer::reset_time(const yijinjing::types::TimeReset &time_reset) {
  yijinjing::time::reset(time_reset.system_clock_count, time_reset.steady_clock_count);
}

std::thread &peer::get_resource_management_worker() { return manager_.get_resource_management_worker(); }

void peer::clear_timer(int32_t timer_id) { timers_.insert_or_assign(timer_id, false); }

bool peer::is_timer_enabled(int32_t timer_id) { return timers_.try_emplace(timer_id).first->second; }

void peer::enable_timer(int32_t timer_id) { timers_.insert_or_assign(timer_id, true); }

yijinjing::journal::writer_ptr &peer::get_thread_writer(uint64_t page_size) {
  if (not thread_writer_) {
    uint32_t dest_id = util::get_thread_id();
    thread_writer_ = get_io_device()->open_writer(dest_id, page_size);

    /// join channel in sub-thread will crash, so tell coordinator to ask myself to join
    /// do not use writer because of multi-thread concurrency issues
    if (not coordinator_cmd_writer_for_thread_) {
      SPDLOG_ERROR("has no writer for coordinator_cmd: {:8x}:{}", get_coordinator_command_uid(),
                   get_location_uname(get_coordinator_command_uid()));
    }
    RequestReadFromOthers &request = coordinator_cmd_writer_for_thread_->open_data<RequestReadFromOthers>();
    request.source_id = get_live_home_uid();
    request.dest_id = dest_id;
    request.from_time = now();
    SPDLOG_TRACE("RequestReadFromOthers: {}", request.to_string());
    coordinator_cmd_writer_for_thread_->close_data();
  }
  return thread_writer_;
}

yijinjing::journal::writer_ptr &peer::get_public_writer() { return public_writer_; }

} // namespace kungfu::runtime::live
