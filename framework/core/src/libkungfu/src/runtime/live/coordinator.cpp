// SPDX-License-Identifier: Apache-2.0

//
// Created by Keren Dong on 2019-06-15.
//

#include <kungfu/common.h>
#include <kungfu/runtime/live/coordinator.h>
#include <kungfu/runtime/os.h>
#include <kungfu/runtime/typed_state_projection.h>
#include <kungfu/view/action_envelope.h>
#include <kungfu/yijinjing/journal/frame.h>
#include <kungfu/yijinjing/schema/registry.h>
#include <kungfu/yijinjing/time.h>

#include <span>
#include <utility>

using namespace kungfu::rx;
using namespace kungfu::yijinjing;
using namespace kungfu::yijinjing::types;
using namespace kungfu::yijinjing::enums;
using namespace kungfu::yijinjing::data;
using namespace kungfu::runtime::journal;

namespace kungfu::runtime::live {

coordinator::coordinator(const location_ptr &home, bool low_latency,
                         state_service::durability_candidate_config durability_candidate,
                         state_service::projection_candidate_config projection_candidate,
                         coordinator_authority continuity_authority)
    : coordinator(std::make_shared<kungfu::runtime::io_device_coordinator>(home, low_latency),
                  std::move(durability_candidate), std::move(projection_candidate), continuity_authority) {}

coordinator::coordinator(const kungfu::runtime::io_device_ptr &io_device,
                         state_service::durability_candidate_config durability_candidate,
                         state_service::projection_candidate_config projection_candidate,
                         coordinator_authority continuity_authority)
    : reactor(io_device), last_check_(0),
      state_service_(io_device, std::move(durability_candidate), std::move(projection_candidate)),
      continuity_authority_(continuity_authority.valid() ? continuity_authority : coordinator_authority{1, 1}) {}

void coordinator::pre_setup() {
  reactor::pre_setup();
  for (const auto &peer_location : state_service_.locations()) {
    add_location(begin_time_, location::make_shared(peer_location, get_locator()));
  }
  for (const auto &config : state_service_.configs()) {
    try_add_location(begin_time_, location::make_shared(config, get_locator()));
  }

  auto public_writer = get_io_device()->open_writer(location::PUBLIC);
  {
    std::lock_guard<std::mutex> lock(writers_mtx_);
    writers_.insert_or_assign(location::PUBLIC, std::move(public_writer));
  }
  state_service_.start();
}

void coordinator::on_exit() {
  state_service_.stop();
  notify_deregister_on_exit();
  notify_coordinator_deregister_on_exit();
  on_notify();
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

  try {
    const auto observation = parse_peer_continuity_observation(request_data);
    const auto continuity = admit_peer_observation(observation, continuity_authority_);
    if (!continuity.accepted()) {
      SPDLOG_ERROR("rejecting peer continuity: {}", continuity.reason);
      return;
    }
  } catch (const std::exception &error) {
    SPDLOG_ERROR("rejecting peer with invalid continuity observation: {}", error.what());
    return;
  }

  auto peer_location = location::make_shared(register_data, home->locator);
  auto already_registered = is_location_live(peer_location->uid);
  if (already_registered) {
    const auto &current = get_registry().at(peer_location->uid);
    if (current.pid != register_data.pid || current.uid64 != register_data.uid64) {
      if (os::is_process_alive(current.pid)) {
        SPDLOG_ERROR("location {} is already owned by a different live peer", peer_location->uname);
        return;
      }
      SPDLOG_WARN("replacing dead peer owner for location {} old pid {} new pid {}", peer_location->uname, current.pid,
                  register_data.pid);
      deregister_peer(event->gen_time(), peer_location->uid);
      remove_location(event->gen_time(), peer_location->uid);
      already_registered = false;
    } else {
      SPDLOG_WARN("replaying continuity bootstrap for live peer {}", peer_location->uname);
    }
  }

  state_service::peer_projection_declaration projection_declaration;
  state_service::projection_candidate_result projection_candidate;
  try {
    projection_declaration = state_service::parse_peer_projection_declaration(request_data);
    projection_candidate = state_service_.bootstrap_projection_candidate(projection_declaration);
    state_cache::bank validated_candidate;
    state_service::hydrate_projection_candidate(projection_candidate, validated_candidate);
  } catch (const std::exception &error) {
    SPDLOG_ERROR("rejecting peer {} with invalid projection declaration: {}", peer_location->uname, error.what());
    return;
  }
  if (projection_declaration.candidate &&
      projection_candidate.bootstrap.outcome == state_service::bootstrap_outcome::Refused) {
    SPDLOG_ERROR("rejecting required-state peer {}: {}", peer_location->uname, projection_candidate.bootstrap.message);
    return;
  }

  register_location(event->gen_time(), register_data);
  if (!already_registered) {
    try_add_location(event->gen_time(), peer_location);
  }

  auto now = yijinjing::time::now_in_nano();
  auto uid_str = fmt::format("{:08x}", peer_location->uid);
  auto coordinator_cmd_location = location::make_shared(mode::LIVE, location_role::SYSTEM, COORDINATOR_WIRE_NAMESPACE,
                                                        uid_str, home->locator, peer_location->seed);
  SPDLOG_INFO("registering location {} uname {} uid {}, coordinator_cmd_location {} uid {}", uid_str,
              peer_location->uname, peer_location->uid, coordinator_cmd_location->uname, coordinator_cmd_location->uid);
  if (!already_registered) {
    try_add_location(event->gen_time(), coordinator_cmd_location);
  }

  yijinjing::journal::writer_ptr peer_cmd_writer;
  if (already_registered) {
    if (!has_writer(peer_location->uid)) {
      SPDLOG_ERROR("live peer {} has no coordinator command writer", peer_location->uname);
      return;
    }
    peer_cmd_writer = get_writer(peer_location->uid);
  } else {
    peer_cmd_writer = get_io_device()->open_writer_at(coordinator_cmd_location, peer_location->uid);
    {
      std::lock_guard<std::mutex> lock(writers_mtx_);
      writers_.insert_or_assign(peer_location->uid, peer_cmd_writer);
    }
    if (!projection_declaration.candidate) {
      reader_->join(peer_location, location::PUBLIC, now);
      reader_->join(peer_location, location::SYNC, now); // create sync journal
      disjoin_channel(peer_location, location::SYNC);    // no need to deal feed from sync
    }
    reader_->join(peer_location, coordinator_cmd_location->uid, now, 0, Priority::High);
  }

  auto public_writer = get_writer(location::PUBLIC);
  if (!already_registered) {
    public_writer->write(event->gen_time(), *std::dynamic_pointer_cast<Location>(peer_location));
  }
  const auto published_register =
      attach_coordinator_authority(state_service::attach_projection_candidate_status(
                                       request_data, state_service::projection_candidate_status(projection_candidate)),
                                   continuity_authority_);
  public_writer->write_bytes(event->gen_time(), Register::tag, std::as_bytes(std::span{published_register}));

  // hava to be put after register sent, because coordinator cmd journal only be joined after register;
  require_write_to(event->gen_time(), peer_location->uid, location::PUBLIC);
  require_write_to(event->gen_time(), peer_location->uid, location::SYNC);
  require_write_to(event->gen_time(), peer_location->uid, coordinator_cmd_location->uid);

  if (projection_declaration.candidate) {
    state_service::emit_projection_candidate(projection_candidate, peer_cmd_writer);
  } else {
    state_service_.reset_cache_shift(peer_location);
    state_service_.ensure_storage(peer_location, location::PUBLIC);
    state_service_.restore(peer_location, peer_cmd_writer);
  }

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
  deregister_outlet(peer_location_uid);
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

void coordinator::on_react() {}

bool coordinator::dest_is_coordinator_wire(const event_ptr &event) const {
  auto dest = event->dest();
  if (has_location(dest)) {
    auto dest_location = get_location(dest);
    if (dest_location->role == location_role::SYSTEM and is_coordinator_wire_namespace(dest_location->namespace_)) {
      return true;
    }
  }
  return false;
}

void coordinator::react() {
  // React hook first, so a subclass (e.g. the Python coordinator hosting the
  // lock arbiter) can install observe() subscriptions before the wired routes
  // below and before events_ is connected. Those land in route_phase::extend.
  on_react();

  // Ordinary handlers. Each selects a distinct carrier type, so at most one of
  // them fires for any frame and their relative order carries no meaning.
  declare<RequestWriteTo>(route_phase::handle, "on_request_write_to", $R(on_request_write_to(event)));
  declare<RequestWriteToOutlet>(route_phase::handle, "on_request_write_to_outlet",
                                $R(on_request_write_to_outlet(event)));
  declare<RequestReadFrom>(route_phase::handle, "on_request_read_from", $R(on_request_read_from(event)));
  declare<RequestReadFromPublic>(route_phase::handle, "on_request_read_from_public",
                                 $R(on_request_read_from_public(event)));
  declare<RequestReadFromSync>(route_phase::handle, "on_request_read_from_sync", $R(on_request_read_from_sync(event)));
  declare<RequestReadFromOthers>(route_phase::handle, "on_request_read_from_others",
                                 $R(on_request_read_from_others(event)));
  declare<RequestStop>(route_phase::handle, "signal_stop", $R(signal_stop()))
      .guard("dest_is_coordinator_wire", [&](const event_ptr &event) { return dest_is_coordinator_wire(event); })
      .why("only a SYSTEM location on the coordinator wire may stop the coordinator; a watcher uses this on Windows");
  declare<ChannelRequest>(route_phase::handle, "on_channel_request", $R(on_channel_request(event)))
      .writes(route_state::channels);
  declare<TimeRequest>(route_phase::handle, "on_time_request", $R(on_time_request(event)));
  declare<Location>(route_phase::handle, "on_new_location", $R(on_new_location(event))).writes(route_state::locations);
  declare<Register>(route_phase::handle, "register_peer", $R(register_peer(event)))
      .writes(route_state::registry, route_state::locations, route_state::writers)
      .why("registers the peer before feed observes the frame, so feed still sees the source as live");
  declare<Ping>(route_phase::handle, "pong", $R(pong(event)));
  declare<CacheReset>(route_phase::handle, "cache_reset", $R(state_service_.cache_reset(event)));
  declare<CachedPause>(route_phase::handle, "pause_projection", $R(state_service_.pause_projection(true)));
  declare<CachedResume>(route_phase::handle, "resume_projection", $R(state_service_.pause_projection(false)));

  // Catch-all: an RTTI predicate over journal frames, so it consumes every
  // carrier type while naming none. It reads the registry through
  // is_location_live(), which brackets it between register_peer and
  // on_request_deregister; route_table::validate() proves that ordering rather
  // than leaving it to the order of these lines.
  declare_frames(route_phase::observe, "feed", $R(feed(event)))
      .reads(route_state::registry, route_state::locations)
      .why("state projection must observe the frame while its source location is still live");

  declare<RequestDeregister>(route_phase::teardown, "on_request_deregister", $R(on_request_deregister(event)))
      .writes(route_state::registry, route_state::locations, route_state::writers)
      .why("tears the peer down last, so every route that needs its location has already run");

  wire_routes();
}

void coordinator::on_active() {
  auto now = yijinjing::time::now_in_nano();
  if (last_check_ + COORDINATOR_HEARTBEAT_INTERVAL_NS < now) {
    const auto heartbeat = attach_coordinator_authority("{}", continuity_authority_);
    get_writer(location::PUBLIC)->write_bytes(now, Ping::tag, std::as_bytes(std::span{heartbeat}));
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
    state_service_.record_location(dynamic_cast<Location &>(*peer_location));
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

  state_service_.ingest(event);
}

void coordinator::pong(const event_ptr &) { get_io_device()->get_publisher()->publish("{}"); }

void coordinator::on_request_write_to_outlet(const event_ptr &event) {
  const RequestWriteToOutlet &request = event->data<RequestWriteToOutlet>();
  auto trigger_time = event->gen_time();
  auto peer_uid = event->source();
  auto home = get_io_device()->get_home();
  auto target_location = location::make_shared(request, home->locator);
  auto page_size = request.page_size;

  // layout have to be journal, for locator::list_locations
  auto dirname = home->locator->layout_dir(target_location, enums::layout::JOURNAL);
  reader_->join(target_location, location::PUBLIC, trigger_time, 1);
  disjoin(target_location);

  // notify others outlet location, but it represents a simulation location, no register, only location
  try_add_location(now(), target_location);
  get_writer(location::PUBLIC)->write(now(), dynamic_cast<Location &>(*target_location));

  SPDLOG_DEBUG("on_request_write_to_outlet for {} to {}, dirname {}", get_location_uname(peer_uid), request.name,
               dirname);
  if (not is_location_live(peer_uid)) {
    return;
  }

  // State storage must be ready before the channel/outlet request is published.
  // slowly
  state_service_.ensure_storage(get_location(peer_uid), request.location_uid);
  reader_->join(get_location(peer_uid), request.location_uid, trigger_time, page_size);
  require_write_to_outlet(trigger_time, peer_uid, target_location, page_size);
  Outlet outlet = {};
  outlet.source_id = peer_uid;
  outlet.dest_id = target_location->location_uid;
  register_outlet(trigger_time, outlet);
  get_writer(location::PUBLIC)->write(trigger_time, outlet);
}

void coordinator::on_request_write_to(const event_ptr &event) {
  const RequestWriteTo &request = event->data<RequestWriteTo>();
  auto trigger_time = event->gen_time();
  auto peer_uid = event->source();
  SPDLOG_DEBUG("on_request_write_to for {} to {}", get_location_uname(peer_uid), get_location_uname(request.dest_id));
  if (not is_location_live(peer_uid)) {
    return;
  }

  // State storage must be ready before the channel/outlet request is published.
  // slowly
  state_service_.ensure_storage(get_location(peer_uid), request.dest_id);
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

  // State storage must be ready before the channel/outlet request is published.
  // slowly
  state_service_.ensure_storage(get_location(request.source_id), peer_uid);
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
    state_service_.ensure_storage(get_location(channel.source_id), channel.dest_id);
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
  TimeReset time_reset{};
  time_reset.system_clock_count = time_base.system_clock_count;
  time_reset.steady_clock_count = time_base.steady_clock_count;
  writer->write(0, time_reset);
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
  for (const auto &item : get_outlets()) {
    writer->write(trigger_time, item.second);
  }
}

bool coordinator::is_reactable(const event_ptr &event) {
  // Custom carriers are normally not reacted to by the coordinator, except the
  // lock-coordination action envelope: the coordinator now hosts the lock
  // arbiter, so it must see coordination.lock.request/release frames (a subclass
  // observe() subscription handles them). All other custom events stay filtered.
  return not is_custom_event(event) or event->carrier_type() == kungfu::view::action::ACTION_ENVELOPE_CARRIER_TYPE;
}

} // namespace kungfu::runtime::live
