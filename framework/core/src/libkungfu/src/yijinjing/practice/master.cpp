// SPDX-License-Identifier: Apache-2.0

//
// Created by Keren Dong on 2019-06-15.
//

#include <kungfu/common.h>
#include <kungfu/longfist/longfist.h>
#include <kungfu/yijinjing/journal/frame.h>
#include <kungfu/yijinjing/practice/master.h>
#include <kungfu/yijinjing/time.h>
#include <kungfu/yijinjing/util/os.h>

using namespace kungfu::rx;
using namespace kungfu::longfist;
using namespace kungfu::longfist::types;
using namespace kungfu::longfist::enums;
using namespace kungfu::cache;
using namespace kungfu::yijinjing::data;
using namespace kungfu::yijinjing::journal;

namespace kungfu::practice {

master::master(const location_ptr &home, bool low_latency)
    : master(std::make_shared<yijinjing::io_device_master>(home, low_latency)) {}

master::master(const yijinjing::io_device_ptr &io_device) : hero(io_device), last_check_(0), cached_(io_device) {}

void master::pre_setup() {
  hero::pre_setup();
  for (const auto &app_location : cached_.get_all(Location{})) {
    add_location(begin_time_, location::make_shared(app_location, get_locator()));
  }
  for (const auto &config : cached_.get_all(Config{})) {
    try_add_location(begin_time_, location::make_shared(config, get_locator()));
  }

  cached_.open_session(master_home_location_, begin_time_);
  writers_.insert_or_assign(location::PUBLIC, get_io_device()->open_writer(location::PUBLIC));
  cached_.run_store_workers();
  get_writer(location::PUBLIC)->mark(begin_time_, SessionStart::tag);
}

void master::on_exit() {
  notify_deregister_on_exit();
  notify_master_deregister_on_exit();
  mark_session_end_on_exit();
}

void master::notify_deregister_on_exit() {
  auto &live_sessions = cached_.get_all_sessions();
  for (auto &iter : live_sessions) {
    auto &session = iter.second;
    auto location_from_session = location::make_shared(session, get_locator());
    if (session.location_uid != master_home_location_->uid) {
      get_writer(location::PUBLIC)->write(yijinjing::time::now_in_nano(), location_from_session->to<Deregister>());
    }
  }
}

// after finished sending deregisters of other processes, then tell everyone master down
void master::notify_master_deregister_on_exit() {
  auto &live_sessions = cached_.get_all_sessions();
  for (auto &iter : live_sessions) {
    auto &session = iter.second;

    if (has_writer(session.location_uid)) {
      auto writer = get_writer(session.location_uid);
      writer->write(yijinjing::time::now_in_nano(), master_home_location_->to<Deregister>());
    } else {
      SPDLOG_WARN("no writer {} {}", session.location_uid, get_location_uname(session.location_uid));
    }
  }
}

void master::mark_session_end_on_exit() {
  get_writer(location::PUBLIC)->mark(yijinjing::time::now_in_nano(), SessionEnd::tag);
  auto &live_sessions = cached_.get_all_sessions();
  for (auto &iter : live_sessions) {
    auto &session = iter.second;
    if (has_writer(session.location_uid)) {
      auto writer = get_writer(session.location_uid);
      writer->mark(yijinjing::time::now_in_nano(), SessionEnd::tag);
    } else {
      SPDLOG_WARN("no writer {} {}", session.location_uid, get_location_uname(session.location_uid));
    }
  }

  // have to use new now, ensuring later than all messages
  cached_.close_all_sessions(yijinjing::time::now_in_nano());
}

void master::on_notify() { get_io_device()->get_publisher()->notify(); }

void master::register_app(const event_ptr &event) {
  auto home = get_io_device()->get_home();

  auto request_data = event->data_as_string();
  Register register_data(request_data.c_str(), request_data.length());
  if (not check_register(event->gen_time(), register_data)) {
    return;
  }

  auto app_location = location::make_shared(register_data, home->locator);
  if (is_location_live(app_location->uid)) {
    SPDLOG_ERROR("location {} has already been registered live", app_location->uname);
    return;
  }
  register_data.last_active_time = cached_.find_last_active_time(app_location);
  register_location(event->gen_time(), register_data);
  try_add_location(event->gen_time(), app_location);

  auto now = yijinjing::time::now_in_nano();
  auto uid_str = fmt::format("{:08x}", app_location->uid);
  auto master_cmd_location =
      location::make_shared(mode::LIVE, category::SYSTEM, "master", uid_str, home->locator, app_location->seed);
  SPDLOG_INFO("registering location {} uname {} uid {}, master_cmd_location {} uid {}", uid_str, app_location->uname,
              app_location->uid, master_cmd_location->uname, master_cmd_location->uid);
  try_add_location(event->gen_time(), master_cmd_location);

  auto app_cmd_writer = get_io_device()->open_writer_at(master_cmd_location, app_location->uid);
  writers_.insert_or_assign(app_location->uid, app_cmd_writer);
  reader_->join(app_location, location::PUBLIC, now);
  reader_->join(app_location, location::SYNC, now); // create sync journal
  disjoin_channel(app_location, location::SYNC);    // no need to deal feed from sync
  reader_->join(app_location, master_cmd_location->uid, now, 0, Priority::High);

  auto public_writer = get_writer(location::PUBLIC);
  public_writer->write(event->gen_time(), *std::dynamic_pointer_cast<Location>(app_location));
  public_writer->write(event->gen_time(), register_data);

  // hava to be put after register sent, because master cmd journal only be joined after register;
  require_write_to(event->gen_time(), app_location->uid, location::PUBLIC);
  require_write_to(event->gen_time(), app_location->uid, location::SYNC);
  require_write_to(event->gen_time(), app_location->uid, master_cmd_location->uid);

  // after register sent, then open session
  cached_.open_session(app_location, event->gen_time());
  cached_.reset_cache_shift(app_location);
  cached_.try_ensure_cached_storage(app_location, location::PUBLIC);
  cached_.restore(app_location, app_cmd_writer);

  write_time_reset(event->gen_time(), app_cmd_writer);
  app_cmd_writer->mark(event->gen_time(), SessionStart::tag);
  app_cmd_writer->mark(yijinjing::time::now_in_nano(), RequestStart::tag);

  // have to be at this position, for triggering strategy(other) prepare
  write_locations(event->gen_time(), app_cmd_writer);
  write_registries(event->gen_time(), app_cmd_writer);
  write_channels(event->gen_time(), app_cmd_writer);
  write_bands(event->gen_time(), app_cmd_writer);

  on_register(event->gen_time(), register_data);
}

void master::deregister_app(int64_t trigger_time, uint32_t app_location_uid) {
  if (not is_location_live(app_location_uid)) {
    SPDLOG_ERROR("location {} has already been deregistered", get_location_uname(app_location_uid));
    return;
  }

  auto location = get_location(app_location_uid);
  SPDLOG_DEBUG("location: {}", location->to_string());
  SPDLOG_INFO("app {} gone", location->uname);
  if (has_writer(app_location_uid)) {
    get_writer(app_location_uid)->mark(trigger_time, SessionEnd::tag);
  }
  deregister_channel(app_location_uid);
  deregister_band(app_location_uid);
  deregister_location(trigger_time, app_location_uid);
  disjoin(location);
  writers_.erase(app_location_uid);
  timer_tasks_.erase(app_location_uid);
  const Deregister deregister = location->to<Deregister>();
  SPDLOG_DEBUG("Deregister: {}", deregister.to_string());
  get_writer(location::PUBLIC)->write(trigger_time, deregister);
  cached_.close_session(location, yijinjing::time::now_in_nano());
}

void master::on_request_deregister(const event_ptr &event) {
  auto dest = event->dest();
  auto source = event->source();
  SPDLOG_INFO("deregister_app from {} to {}", get_location_uname(source), get_location_uname(dest));
  deregister_app(event->trigger_time(), source);
}

void master::react() {
  events_ | is(RequestWriteTo::tag) | $$(on_request_write_to(event));
  events_ | is(RequestWriteToBand::tag) | $$(on_request_write_to_band(event));
  events_ | is(RequestReadFrom::tag) | $$(on_request_read_from(event));
  events_ | is(RequestReadFromPublic::tag) | $$(on_request_read_from_public(event));
  events_ | is(RequestReadFromSync::tag) | $$(on_request_read_from_sync(event));
  events_ | is(RequestReadFromOthers::tag) | $$(on_request_read_from_others(event));
  // for watcher request stop master in widnows
  events_ | is(RequestStop::tag) | filter([&](const event_ptr &event) {
    auto dest = event->dest();
    if (has_location(dest)) {
      auto dest_location = get_location(dest);
      if (dest_location->category == category::SYSTEM and dest_location->group == "master") {
        return true;
      }
    }
    return false;
  }) | $$(signal_stop());
  events_ | is(ChannelRequest::tag) | $$(on_channel_request(event));
  events_ | is(TimeRequest::tag) | $$(on_time_request(event));
  events_ | is(Location::tag) | $$(on_new_location(event));
  events_ | is(Register::tag) | $$(register_app(event));
  events_ | is(Ping::tag) | $$(pong(event));
  events_ | is(CacheReset::tag) | $([&](const event_ptr &event) { cached_.cache_reset(event); });
  events_ | is(CachedPause::tag) | $$(cached_.switch_feed_storage(true));
  events_ | is(CachedResume::tag) | $$(cached_.switch_feed_storage(false));
  events_ | instanceof <yijinjing::journal::frame>() | $$(feed(event));

  // have to be at bottom of react, for avoid event still required after reader disjoin
  events_ | is(RequestDeregister::tag) | $$(on_request_deregister(event));
}

void master::on_active() {
  auto now = yijinjing::time::now_in_nano();
  if (last_check_ + yijinjing::time_unit::NANOSECONDS_PER_SECOND < now) {
    on_interval_check(now);
    last_check_ = now;
  }
  on_frame();
}

void master::on_frame() { handle_timer_tasks(); }

void master::handle_timer_tasks() {
  auto now = yijinjing::time::now_in_nano();
  for (auto &app : timer_tasks_) {
    uint32_t app_id = app.first;
    auto &app_tasks = app.second;
    for (auto it = app_tasks.begin(); it != app_tasks.end();) {
      auto &task = it->second;
      if (task.checkpoint <= now && has_writer(app_id)) {
        get_writer(app_id)->mark(0, Time::tag);
        task.checkpoint += task.duration;
        task.repeat_count++;
        if (task.repeat_count >= task.repeat_limit) {
          it = app_tasks.erase(it);
          continue;
        }
      }
      it++;
    }
  }
}

void master::try_add_location(int64_t trigger_time, const location_ptr &app_location) {
  if (not has_location(app_location->uid)) {
    add_location(trigger_time, app_location);
    cached_.feed_profile(dynamic_cast<Location &>(*app_location));
  }
}

void master::feed(const event_ptr &event) {
  handle_timer_tasks();

  if (!is_location_live(event->source())) {
    return;
  }

  cached_.update_session(std::dynamic_pointer_cast<yijinjing::journal::frame>(event));

  if (event->dest() == location::SYNC) {
    return;
  }

  if (get_location(event->source())->category == category::OPERATOR) {
    return;
  }

  if (event->msg_type() != Instrument::tag and event->msg_type() != InstrumentFactor::tag and
      get_location(event->source())->category == category::MD) {
    return;
  }

  cached_.feed(event);
}

void master::pong(const event_ptr &) { get_io_device()->get_publisher()->publish("{}"); }

void master::on_request_write_to_band(const event_ptr &event) {
  const RequestWriteToBand &request = event->data<RequestWriteToBand>();
  auto trigger_time = event->gen_time();
  auto app_uid = event->source();
  auto home = get_io_device()->get_home();
  auto target_location = location::make_shared(request, home->locator);
  auto page_size = request.page_size;

  // layout have to be journal, for locator::list_locations
  auto dirname = home->locator->layout_dir(target_location, enums::layout::JOURNAL);
  reader_->join(target_location, location::PUBLIC, trigger_time, 1);
  disjoin(target_location);

  // notify others band location, but it represents a simulation location, no register, only location
  try_add_location(now(), target_location);
  get_writer(location::PUBLIC)->write(now(), dynamic_cast<Location &>(*target_location));

  SPDLOG_DEBUG("on_request_write_to_band for {} to {}, dirname {}", get_location_uname(app_uid), request.name, dirname);
  if (not is_location_live(app_uid)) {
    return;
  }

  // cached_.try_ensure_cached_storage have to be in this position, for case it taking too long to send channel/band
  // slowly
  cached_.try_ensure_cached_storage(get_location(app_uid), request.location_uid);
  reader_->join(get_location(app_uid), request.location_uid, trigger_time, page_size);
  require_write_to_band(trigger_time, app_uid, target_location, page_size);
  Band band = {};
  band.source_id = app_uid;
  band.dest_id = target_location->location_uid;
  register_band(trigger_time, band);
  get_writer(location::PUBLIC)->write(trigger_time, band);
}

void master::on_request_write_to(const event_ptr &event) {
  const RequestWriteTo &request = event->data<RequestWriteTo>();
  auto trigger_time = event->gen_time();
  auto app_uid = event->source();
  SPDLOG_DEBUG("on_request_write_to for {} to {}", get_location_uname(app_uid), get_location_uname(request.dest_id));
  if (not is_location_live(app_uid)) {
    return;
  }

  // cached_.try_ensure_cached_storage have to be in this position, for case it taking too long to send channel/band
  // slowly
  cached_.try_ensure_cached_storage(get_location(app_uid), request.dest_id);
  reader_->join(get_location(app_uid), request.dest_id, trigger_time, request.page_size);
  require_write_to(trigger_time, app_uid, request.dest_id, request.page_size);

  if (is_location_live(request.dest_id) and has_writer(request.dest_id)) {
    require_read_from(0, request.dest_id, app_uid, trigger_time);
  }
  Channel channel = {};
  channel.source_id = app_uid;
  channel.dest_id = request.dest_id;
  register_channel(trigger_time, channel);
  get_writer(location::PUBLIC)->write(trigger_time, channel);
}

void master::on_request_read_from(const event_ptr &event) {
  const RequestReadFrom &request = event->data<RequestReadFrom>();
  auto trigger_time = event->gen_time();
  auto app_uid = event->source();
  SPDLOG_DEBUG("on_request_read_from for {} to {}", get_location_uname(app_uid), get_location_uname(request.source_id));
  if (not check_location_live(request.source_id, app_uid)) {
    return;
  }

  // cached_.try_ensure_cached_storage have to be in this position, for case it taking too long to send channel/band
  // slowly
  cached_.try_ensure_cached_storage(get_location(request.source_id), app_uid);
  reader_->join(get_location(request.source_id), app_uid, trigger_time, request.page_size);
  require_write_to(trigger_time, request.source_id, app_uid, request.page_size);
  require_read_from(trigger_time, app_uid, request.source_id, request.from_time, request.page_size);

  Channel channel = {};
  channel.source_id = request.source_id;
  channel.dest_id = app_uid;
  register_channel(trigger_time, channel);
  get_writer(location::PUBLIC)->write(trigger_time, channel);
}

void master::on_request_read_from_public(const event_ptr &event) {
  const RequestReadFromPublic &request = event->data<RequestReadFromPublic>();
  require_read_from_public(event->gen_time(), event->source(), request.source_id, request.from_time, request.page_size);
}

void master::on_request_read_from_sync(const event_ptr &event) {
  const RequestReadFromSync &request = event->data<RequestReadFromSync>();
  require_read_from_sync(event->gen_time(), event->source(), request.source_id, request.from_time, request.page_size);
}

void master::on_request_read_from_others(const event_ptr &event) {
  const RequestReadFromOthers request = event->data<RequestReadFromOthers>();
  auto source = event->source();
  if (has_writer(source)) {
    get_writer(source)->write(now(), request);
  }
}

void master::on_channel_request(const event_ptr &event) {
  const Channel &channel = event->data<Channel>();
  auto trigger_time = event->gen_time();
  if (is_location_live(channel.source_id) and not has_channel(channel.source_id, channel.dest_id)) {
    cached_.try_ensure_cached_storage(get_location(channel.source_id), channel.dest_id);
    reader_->join(get_location(channel.source_id), channel.dest_id, trigger_time);
    require_write_to(trigger_time, channel.source_id, channel.dest_id);
    register_channel(trigger_time, channel);
    get_writer(location::PUBLIC)->write(trigger_time, channel);
  }
}

void master::on_time_request(const event_ptr &event) {
  if (not is_location_live(event->source())) {
    return;
  }
  const TimeRequest &request = event->data<TimeRequest>();
  auto &app_tasks = timer_tasks_.try_emplace(event->source()).first->second;
  auto &task = app_tasks.try_emplace(request.id).first->second;
  task.checkpoint = request.base_time + request.duration;
  task.duration = request.duration;
  task.repeat_count = 0;
  task.repeat_limit = request.repeat;
}

void master::on_new_location(const event_ptr &event) {
  const Location &location = event->data<Location>();
  try_add_location(event->gen_time(), yijinjing::data::location::make_shared(location, get_locator()));
  get_writer(location::PUBLIC)->write(event->gen_time(), location);
}

void master::write_time_reset(int64_t, const writer_ptr &writer) {
  auto time_base = yijinjing::time::get_base();
  TimeReset &time_reset = writer->open_data<TimeReset>();
  time_reset.system_clock_count = time_base.system_clock_count;
  time_reset.steady_clock_count = time_base.steady_clock_count;
  writer->close_data();
}

void master::write_registries(int64_t trigger_time, const writer_ptr &writer) {
  for (const auto &item : get_registry()) {
    writer->write(trigger_time, item.second);
  }
}

void master::write_locations(int64_t trigger_time, const writer_ptr &writer) {
  for (const auto &item : get_locations()) {
    writer->write(trigger_time, dynamic_cast<Location &>(*item.second));
  }
}

void master::write_channels(int64_t trigger_time, const writer_ptr &writer) {
  for (const auto &item : get_channels()) {
    writer->write(trigger_time, item.second);
  }
}

void master::write_bands(int64_t trigger_time, const writer_ptr &writer) {
  for (const auto &item : get_bands()) {
    writer->write(trigger_time, item.second);
  }
}

bool master::is_reactable(const event_ptr &event) { return not is_custom_event(event); }

} // namespace kungfu::practice
