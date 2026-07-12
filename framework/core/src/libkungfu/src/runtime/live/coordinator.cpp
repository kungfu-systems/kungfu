// SPDX-License-Identifier: Apache-2.0

//
// Created by Keren Dong on 2019-06-15.
//

#include <kungfu/common.h>
#include <kungfu/runtime/live/coordinator.h>
#include <kungfu/runtime/os.h>
#include <kungfu/yijinjing/journal/frame.h>
#include <kungfu/yijinjing/schema/registry.h>
#include <kungfu/yijinjing/time.h>

using namespace kungfu::rx;
using namespace kungfu::yijinjing;
using namespace kungfu::yijinjing::types;
using namespace kungfu::yijinjing::enums;
using namespace kungfu::runtime::state_cache;
using namespace kungfu::yijinjing::data;
using namespace kungfu::runtime::journal;

namespace kungfu::runtime::live {

coordinator::coordinator(const location_ptr &home, bool low_latency)
    : coordinator(std::make_shared<kungfu::runtime::io_device_coordinator>(home, low_latency)) {}

coordinator::coordinator(const kungfu::runtime::io_device_ptr &io_device)
    : reactor(io_device), last_check_(0), state_cache_(io_device) {}

void coordinator::pre_setup() {
  reactor::pre_setup();
  for (const auto &peer_location : state_cache_.get_all(Location{})) {
    add_location(begin_time_, location::make_shared(peer_location, get_locator()));
  }
  for (const auto &config : state_cache_.get_all(Config{})) {
    try_add_location(begin_time_, location::make_shared(config, get_locator()));
  }

  auto public_writer = get_io_device()->open_writer(location::PUBLIC);
  {
    std::lock_guard<std::mutex> lock(writers_mtx_);
    writers_.insert_or_assign(location::PUBLIC, std::move(public_writer));
  }
  state_cache_.run_store_workers();
}

void coordinator::on_exit() {
  notify_deregister_on_exit();
  notify_coordinator_deregister_on_exit();
}

void coordinator::notify_deregister_on_exit() {
  for (const auto &[location_uid, registration] : get_registry()) {
    if (location_uid != coordinator_home_location_->uid) {
      const auto live_location = location::make_shared(registration, get_locator());
      get_writer(location::PUBLIC)->write(yijinjing::time::now_in_nano(), live_location->to<Deregister>());
    }
  }
}

// after finished sending deregisters of other processes, then tell everyone coordinator down
void coordinator::notify_coordinator_deregister_on_exit() {
  for (const auto &[location_uid, registration] : get_registry()) {
    if (location_uid == coordinator_home_location_->uid) {
      continue;
    }
    if (has_writer(location_uid)) {
      auto writer = get_writer(location_uid);
      writer->write(yijinjing::time::now_in_nano(), coordinator_home_location_->to<Deregister>());
    } else {
      SPDLOG_WARN("no writer {} {}", location_uid, get_location_uname(location_uid));
    }
  }
}

void coordinator::on_notify() { get_io_device()->get_publisher()->notify(); }

void coordinator::register_peer(const event_ptr &event) {
  auto home = get_io_device()->get_home();

  auto request_data = event->data_as_string();
  Register register_data(request_data.c_str(), request_data.length());
  if (not check_register(event->gen_time(), register_data)) {
    return;
  }

  auto peer_location = location::make_shared(register_data, home->locator);
  if (is_location_live(peer_location->uid)) {
    SPDLOG_ERROR("location {} has already been registered live", peer_location->uname);
    return;
  }
  register_location(event->gen_time(), register_data);
  try_add_location(event->gen_time(), peer_location);

  auto now = yijinjing::time::now_in_nano();
  auto uid_str = fmt::format("{:08x}", peer_location->uid);
  auto coordinator_cmd_location = location::make_shared(mode::LIVE, location_role::SYSTEM, COORDINATOR_WIRE_NAMESPACE,
                                                        uid_str, home->locator, peer_location->seed);
  SPDLOG_INFO("registering location {} uname {} uid {}, coordinator_cmd_location {} uid {}", uid_str,
              peer_location->uname, peer_location->uid, coordinator_cmd_location->uname, coordinator_cmd_location->uid);
  try_add_location(event->gen_time(), coordinator_cmd_location);

  auto peer_cmd_writer = get_io_device()->open_writer_at(coordinator_cmd_location, peer_location->uid);
  {
    std::lock_guard<std::mutex> lock(writers_mtx_);
    writers_.insert_or_assign(peer_location->uid, peer_cmd_writer);
  }
  reader_->join(peer_location, location::PUBLIC, now);
  reader_->join(peer_location, location::SYNC, now); // create sync journal
  disjoin_channel(peer_location, location::SYNC);    // no need to deal feed from sync
  reader_->join(peer_location, coordinator_cmd_location->uid, now, 0, Priority::High);

  auto public_writer = get_writer(location::PUBLIC);
  public_writer->write(event->gen_time(), *std::dynamic_pointer_cast<Location>(peer_location));
  public_writer->write(event->gen_time(), register_data);

  // hava to be put after register sent, because coordinator cmd journal only be joined after register;
  require_write_to(event->gen_time(), peer_location->uid, location::PUBLIC);
  require_write_to(event->gen_time(), peer_location->uid, location::SYNC);
  require_write_to(event->gen_time(), peer_location->uid, coordinator_cmd_location->uid);

  state_cache_.reset_cache_shift(peer_location);
  state_cache_.try_ensure_cached_storage(peer_location, location::PUBLIC);
  state_cache_.restore(peer_location, peer_cmd_writer);

  write_time_reset(event->gen_time(), peer_cmd_writer);
  peer_cmd_writer->mark(yijinjing::time::now_in_nano(), RequestStart::tag);

  // have to be at this position, for triggering strategy(other) prepare
  write_locations(event->gen_time(), peer_cmd_writer);
  write_registries(event->gen_time(), peer_cmd_writer);
  write_channels(event->gen_time(), peer_cmd_writer);
  write_bands(event->gen_time(), peer_cmd_writer);

  on_register(event->gen_time(), register_data);
}

void coordinator::deregister_peer(int64_t trigger_time, uint32_t peer_location_uid) {
  if (not is_location_live(peer_location_uid)) {
    SPDLOG_ERROR("location {} has already been deregistered", get_location_uname(peer_location_uid));
    return;
  }

  auto location = get_location(peer_location_uid);
  SPDLOG_DEBUG("location: {}", location->to_string());
  SPDLOG_INFO("peer {} gone", location->uname);
  deregister_channel(peer_location_uid);
  deregister_band(peer_location_uid);
  deregister_location(trigger_time, peer_location_uid);
  disjoin(location);
  {
    std::lock_guard<std::mutex> lock(writers_mtx_);
    writers_.erase(peer_location_uid);
  }
  timer_tasks_.erase(peer_location_uid);
  const Deregister deregister = location->to<Deregister>();
  SPDLOG_DEBUG("Deregister: {}", deregister.to_string());
  get_writer(location::PUBLIC)->write(trigger_time, deregister);
}

void coordinator::on_request_deregister(const event_ptr &event) {
  auto dest = event->dest();
  auto source = event->source();
  SPDLOG_INFO("deregister_peer from {} to {}", get_location_uname(source), get_location_uname(dest));
  deregister_peer(event->trigger_time(), source);
}

void coordinator::react() {
  events_ | is(RequestWriteTo::tag) | $$(on_request_write_to(event));
  events_ | is(RequestWriteToBand::tag) | $$(on_request_write_to_band(event));
  events_ | is(RequestReadFrom::tag) | $$(on_request_read_from(event));
  events_ | is(RequestReadFromPublic::tag) | $$(on_request_read_from_public(event));
  events_ | is(RequestReadFromSync::tag) | $$(on_request_read_from_sync(event));
  events_ | is(RequestReadFromOthers::tag) | $$(on_request_read_from_others(event));
  // for watcher request stop coordinator in widnows
  events_ | is(RequestStop::tag) | filter([&](const event_ptr &event) {
    auto dest = event->dest();
    if (has_location(dest)) {
      auto dest_location = get_location(dest);
      if (dest_location->role == location_role::SYSTEM and is_coordinator_wire_namespace(dest_location->namespace_)) {
        return true;
      }
    }
    return false;
  }) | $$(signal_stop());
  events_ | is(ChannelRequest::tag) | $$(on_channel_request(event));
  events_ | is(TimeRequest::tag) | $$(on_time_request(event));
  events_ | is(Location::tag) | $$(on_new_location(event));
  events_ | is(Register::tag) | $$(register_peer(event));
  events_ | is(Ping::tag) | $$(pong(event));
  events_ | is(CacheReset::tag) | $([&](const event_ptr &event) { state_cache_.cache_reset(event); });
  events_ | is(CachedPause::tag) | $$(state_cache_.switch_feed_storage(true));
  events_ | is(CachedResume::tag) | $$(state_cache_.switch_feed_storage(false));
  events_ | instanceof<yijinjing::journal::frame>() | $$(feed(event));

  // have to be at bottom of react, for avoid event still required after reader disjoin
  events_ | is(RequestDeregister::tag) | $$(on_request_deregister(event));
}

void coordinator::on_active() {
  auto now = yijinjing::time::now_in_nano();
  if (last_check_ + yijinjing::time_unit::NANOSECONDS_PER_SECOND < now) {
    on_interval_check(now);
    last_check_ = now;
  }
  on_frame();
}

void coordinator::on_frame() { handle_timer_tasks(); }

void coordinator::handle_timer_tasks() {
  auto now = yijinjing::time::now_in_nano();
  for (auto &peer_entry : timer_tasks_) {
    uint32_t peer_id = peer_entry.first;
    auto &peer_tasks = peer_entry.second;
    for (auto it = peer_tasks.begin(); it != peer_tasks.end();) {
      auto &task = it->second;
      if (task.checkpoint <= now && has_writer(peer_id)) {
        get_writer(peer_id)->mark(0, Time::tag);
        task.checkpoint += task.duration;
        task.repeat_count++;
        if (task.repeat_count >= task.repeat_limit) {
          it = peer_tasks.erase(it);
          continue;
        }
      }
      it++;
    }
  }
}

void coordinator::try_add_location(int64_t trigger_time, const location_ptr &peer_location) {
  if (not has_location(peer_location->uid)) {
    add_location(trigger_time, peer_location);
    state_cache_.feed_profile(dynamic_cast<Location &>(*peer_location));
  }
}

void coordinator::feed(const event_ptr &event) {
  handle_timer_tasks();

  if (!is_location_live(event->source())) {
    return;
  }

  if (event->dest() == location::SYNC) {
    return;
  }

  if (get_location(event->source())->role == location_role::SERVICE) {
    return;
  }

  if (get_location(event->source())->role == location_role::SOURCE) {
    return;
  }

  state_cache_.feed(event);
}

void coordinator::pong(const event_ptr &) { get_io_device()->get_publisher()->publish("{}"); }

void coordinator::on_request_write_to_band(const event_ptr &event) {
  const RequestWriteToBand &request = event->data<RequestWriteToBand>();
  auto trigger_time = event->gen_time();
  auto peer_uid = event->source();
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

  SPDLOG_DEBUG("on_request_write_to_band for {} to {}, dirname {}", get_location_uname(peer_uid), request.name,
               dirname);
  if (not is_location_live(peer_uid)) {
    return;
  }

  // State storage must be ready before the channel/band request is published.
  // slowly
  state_cache_.try_ensure_cached_storage(get_location(peer_uid), request.location_uid);
  reader_->join(get_location(peer_uid), request.location_uid, trigger_time, page_size);
  require_write_to_band(trigger_time, peer_uid, target_location, page_size);
  Band band = {};
  band.source_id = peer_uid;
  band.dest_id = target_location->location_uid;
  register_band(trigger_time, band);
  get_writer(location::PUBLIC)->write(trigger_time, band);
}

void coordinator::on_request_write_to(const event_ptr &event) {
  const RequestWriteTo &request = event->data<RequestWriteTo>();
  auto trigger_time = event->gen_time();
  auto peer_uid = event->source();
  SPDLOG_DEBUG("on_request_write_to for {} to {}", get_location_uname(peer_uid), get_location_uname(request.dest_id));
  if (not is_location_live(peer_uid)) {
    return;
  }

  // State storage must be ready before the channel/band request is published.
  // slowly
  state_cache_.try_ensure_cached_storage(get_location(peer_uid), request.dest_id);
  reader_->join(get_location(peer_uid), request.dest_id, trigger_time, request.page_size);
  require_write_to(trigger_time, peer_uid, request.dest_id, request.page_size);

  if (is_location_live(request.dest_id) and has_writer(request.dest_id)) {
    require_read_from(0, request.dest_id, peer_uid, trigger_time);
  }
  Channel channel = {};
  channel.source_id = peer_uid;
  channel.dest_id = request.dest_id;
  register_channel(trigger_time, channel);
  get_writer(location::PUBLIC)->write(trigger_time, channel);
}

void coordinator::on_request_read_from(const event_ptr &event) {
  const RequestReadFrom &request = event->data<RequestReadFrom>();
  auto trigger_time = event->gen_time();
  auto peer_uid = event->source();
  SPDLOG_DEBUG("on_request_read_from for {} to {}", get_location_uname(peer_uid),
               get_location_uname(request.source_id));
  if (not check_location_live(request.source_id, peer_uid)) {
    return;
  }

  // State storage must be ready before the channel/band request is published.
  // slowly
  state_cache_.try_ensure_cached_storage(get_location(request.source_id), peer_uid);
  reader_->join(get_location(request.source_id), peer_uid, trigger_time, request.page_size);
  require_write_to(trigger_time, request.source_id, peer_uid, request.page_size);
  require_read_from(trigger_time, peer_uid, request.source_id, request.from_time, request.page_size);

  Channel channel = {};
  channel.source_id = request.source_id;
  channel.dest_id = peer_uid;
  register_channel(trigger_time, channel);
  get_writer(location::PUBLIC)->write(trigger_time, channel);
}

void coordinator::on_request_read_from_public(const event_ptr &event) {
  const RequestReadFromPublic &request = event->data<RequestReadFromPublic>();
  require_read_from_public(event->gen_time(), event->source(), request.source_id, request.from_time, request.page_size);
}

void coordinator::on_request_read_from_sync(const event_ptr &event) {
  const RequestReadFromSync &request = event->data<RequestReadFromSync>();
  require_read_from_sync(event->gen_time(), event->source(), request.source_id, request.from_time, request.page_size);
}

void coordinator::on_request_read_from_others(const event_ptr &event) {
  const RequestReadFromOthers request = event->data<RequestReadFromOthers>();
  auto source = event->source();
  if (has_writer(source)) {
    get_writer(source)->write(now(), request);
  }
}

void coordinator::on_channel_request(const event_ptr &event) {
  const Channel &channel = event->data<Channel>();
  auto trigger_time = event->gen_time();
  if (is_location_live(channel.source_id) and not has_channel(channel.source_id, channel.dest_id)) {
    state_cache_.try_ensure_cached_storage(get_location(channel.source_id), channel.dest_id);
    reader_->join(get_location(channel.source_id), channel.dest_id, trigger_time);
    require_write_to(trigger_time, channel.source_id, channel.dest_id);
    register_channel(trigger_time, channel);
    get_writer(location::PUBLIC)->write(trigger_time, channel);
  }
}

void coordinator::on_time_request(const event_ptr &event) {
  if (not is_location_live(event->source())) {
    return;
  }
  const TimeRequest &request = event->data<TimeRequest>();
  auto &peer_tasks = timer_tasks_.try_emplace(event->source()).first->second;
  auto &task = peer_tasks.try_emplace(request.id).first->second;
  task.checkpoint = request.base_time + request.duration;
  task.duration = request.duration;
  task.repeat_count = 0;
  task.repeat_limit = request.repeat;
}

void coordinator::on_new_location(const event_ptr &event) {
  const Location &location = event->data<Location>();
  try_add_location(event->gen_time(), yijinjing::data::location::make_shared(location, get_locator()));
  get_writer(location::PUBLIC)->write(event->gen_time(), location);
}

void coordinator::write_time_reset(int64_t, const writer_ptr &writer) {
  auto time_base = yijinjing::time::get_base();
  TimeReset &time_reset = writer->open_data<TimeReset>();
  time_reset.system_clock_count = time_base.system_clock_count;
  time_reset.steady_clock_count = time_base.steady_clock_count;
  writer->close_data();
}

void coordinator::write_registries(int64_t trigger_time, const writer_ptr &writer) {
  for (const auto &item : get_registry()) {
    writer->write(trigger_time, item.second);
  }
}

void coordinator::write_locations(int64_t trigger_time, const writer_ptr &writer) {
  for (const auto &item : get_locations()) {
    writer->write(trigger_time, dynamic_cast<Location &>(*item.second));
  }
}

void coordinator::write_channels(int64_t trigger_time, const writer_ptr &writer) {
  for (const auto &item : get_channels()) {
    writer->write(trigger_time, item.second);
  }
}

void coordinator::write_bands(int64_t trigger_time, const writer_ptr &writer) {
  for (const auto &item : get_bands()) {
    writer->write(trigger_time, item.second);
  }
}

bool coordinator::is_reactable(const event_ptr &event) { return not is_custom_event(event); }

} // namespace kungfu::runtime::live
