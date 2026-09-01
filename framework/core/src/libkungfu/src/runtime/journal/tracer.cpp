// SPDX-License-Identifier: Apache-2.0

#include <kungfu/runtime/journal/tracer.h>
#include <kungfu/runtime/live/identity.h>
#include <kungfu/yijinjing/journal/page.h>
#include <kungfu/yijinjing/schema/registry.h>

using namespace kungfu::yijinjing::types;
using namespace kungfu::yijinjing::enums;
using namespace kungfu::runtime;
using namespace kungfu::runtime::journal;
using namespace kungfu::yijinjing::data;

namespace kungfu::runtime::journal {

constexpr auto PEER_POLICY = reader_policy::peer();

tracer::tracer(const location_ptr location, bool in, bool out, int64_t begin, int64_t end)
    : home_(location), reader_(std::make_shared<reader>(PEER_POLICY, false, std::make_shared<bus>(false))),
      reader_for_in_(std::make_shared<reader>(PEER_POLICY, false, std::make_shared<bus>(false))), in_(in), out_(out),
      begin_time_(begin), end_time_(end == 0 ? INT64_MAX : end) {
  auto coordinator_home_location = location::make_shared(
      mode::LIVE, location_role::SYSTEM, live::COORDINATOR_WIRE_NAMESPACE, live::COORDINATOR_WIRE_NAME, get_locator());
  auto is_coordinator = coordinator_home_location->uid == home_->uid;
  if (in) {
    if (not is_coordinator) {
      auto uid_str = fmt::format("{:08x}", home_->uid);
      auto coordinator_cmd_location = location::make_shared(mode::LIVE, location_role::SYSTEM,
                                                            live::COORDINATOR_WIRE_NAMESPACE, uid_str, get_locator());
      if (page::check_page_existed(coordinator_cmd_location, home_->uid)) {
        reader_->join(coordinator_cmd_location, home_->uid, begin_time_);
        reader_for_in_->join(coordinator_cmd_location, home_->uid, begin_time_);
      } else {
        SPDLOG_WARN("page not existed, home_ {}, source_location: {}, dest: {}", home_->uname,
                    coordinator_cmd_location->uname, (uint32_t)home_->uid);
      }
    } else {
      for (auto target_location : get_locator()->list_locations("*", "*", "*", "*")) {
        if (target_location->role == location_role::SYSTEM and
            live::is_coordinator_wire_namespace(target_location->namespace_)) {
          continue;
        }
        for (auto dest_id : get_locator()->list_location_dest(target_location)) {
          auto uid_str = fmt::format("{:08x}", target_location->uid);
          auto coordinator_cmd_location = location::make_shared(
              mode::LIVE, location_role::SYSTEM, live::COORDINATOR_WIRE_NAMESPACE, uid_str, get_locator());
          if (dest_id == coordinator_cmd_location->uid) {
            if (page::check_page_existed(target_location, dest_id)) {
              reader_->join(target_location, dest_id, begin_time_);
              reader_for_in_->join(target_location, dest_id, begin_time_);
            } else {
              SPDLOG_WARN("page not existed, source_location: {}, dest: {}", target_location->uname, (uint32_t)dest_id);
            }
          }
        }
      }
    }

    if (page::check_page_existed(coordinator_home_location, location::PUBLIC)) {
      reader_->join(coordinator_home_location, location::PUBLIC, begin_time_);
      reader_for_in_->join(coordinator_home_location, location::PUBLIC, begin_time_);
    } else {
      SPDLOG_WARN("page not existed, source_location: {}, dest: {}", coordinator_home_location->uname,
                  location::PUBLIC);
    }
  }

  if (out) {
    for (auto dest_id : get_locator()->list_location_dest(home_)) {
      if (page::check_page_existed(home_, dest_id)) {
        reader_->join(home_, dest_id, begin_time_);
      } else {
        SPDLOG_WARN("page not existed, source_location: {}, dest: {}", home_->uname, (uint32_t)dest_id);
      }
    }

    if (is_coordinator) {
      for (auto coordinator_cmd_location :
           get_locator()->list_locations("system", live::COORDINATOR_WIRE_NAMESPACE, "*", "*")) {
        SPDLOG_INFO("coordinator_cmd_location: {}", coordinator_cmd_location->uname);
        for (auto dest_id : get_locator()->list_location_dest(coordinator_cmd_location)) {
          if (page::check_page_existed(coordinator_cmd_location, dest_id)) {
            reader_->join(coordinator_cmd_location, dest_id, begin_time_);
          } else {
            SPDLOG_WARN("page not existed, source_location: {}, dest: {}", coordinator_cmd_location->uname,
                        (uint32_t)dest_id);
          }
        }
      }
    }
  }

  // init `````````````````````````````````;
  for (auto location : get_locator()->list_locations(".*", ".*", ".*", ".*")) {
    locations_.emplace(location->uid, location);
  }
};

tracer::~tracer() { reader_.reset(); }

void tracer::seek_to_time(int64_t nano_time) {
  if (in_) {
    reader_for_in_->seek_to_time(begin_time_);
    while (reader_for_in_->data_available() and reader_for_in_->current_frame()->gen_time() < nano_time and
           reader_for_in_->current_frame()->gen_time() < end_time_) {
      join_for_in(reader_for_in_->current_frame());
      reader_for_in_->next();
    }
  }

  reader_->seek_to_time(nano_time);
}

frame_ptr tracer::current_frame() const {
  auto frame = reader_->current_frame();
  join_for_in(frame);
  return frame;
}

void tracer::join_for_in(const yijinjing::journal::frame_ptr &frame) const {
  if (frame->dest() == home_->uid and frame->carrier_type() == RequestReadFrom::tag) {
    auto request = frame->data<RequestReadFrom>();
    if (locations_.find(request.source_id) == locations_.end()) {
      SPDLOG_WARN("RequestReadFrom no location {}", (uint32_t)request.source_id);
      return;
    }
    auto source_location = locations_.at(request.source_id);
    if (page::check_page_existed(source_location, home_->uid)) {
      reader_->join(source_location, home_->uid, request.from_time);
    } else {
      SPDLOG_WARN("page not existed, source_location: {}, dest: {}", source_location->uname, (uint32_t)home_->uid);
    }
  }
  if (frame->dest() == home_->uid and frame->carrier_type() == RequestReadFromPublic::tag) {
    auto request = frame->data<RequestReadFromPublic>();
    if (locations_.find(request.source_id) == locations_.end()) {
      SPDLOG_WARN("RequestReadFromPublic no location {}", (uint32_t)request.source_id);
      return;
    }
    auto source_location = locations_.at(request.source_id);
    if (page::check_page_existed(source_location, location::PUBLIC)) {
      reader_->join(source_location, location::PUBLIC, request.from_time);
    } else {
      SPDLOG_WARN("page not existed, source_location: {}, dest: {}", source_location->uname, location::PUBLIC);
    }
  }
  if (frame->dest() == home_->uid and frame->carrier_type() == RequestReadFromSync::tag) {
    auto request = frame->data<RequestReadFromSync>();
    if (locations_.find(request.source_id) == locations_.end()) {
      SPDLOG_WARN("RequestReadFromSync no location {}", (uint32_t)request.source_id);
      return;
    }
    auto source_location = locations_.at(request.source_id);
    if (page::check_page_existed(source_location, location::SYNC)) {
      reader_->join(source_location, location::SYNC, request.from_time);
    } else {
      SPDLOG_WARN("page not existed, source_location: {}, dest: {}", source_location->uname, location::SYNC);
    }
  }

  // This step is quite special because "RequestReadFromOthers" is sent after joining the journal. To leave a trace, it
  // should be processed at send time, not while waiting for the coordinator.
  if ((frame->dest() == home_->uid or frame->source() == home_->uid) and
      frame->carrier_type() == RequestReadFromOthers::tag) {
    auto request = frame->data<RequestReadFromOthers>();
    if (locations_.find(request.source_id) == locations_.end()) {
      SPDLOG_WARN("RequestReadFromOthers no location {}", (uint32_t)request.source_id);
      return;
    }
    auto source_location = locations_.at(request.source_id);
    if (page::check_page_existed(source_location, request.dest_id)) {
      reader_->join(source_location, request.dest_id, request.from_time);
    } else {
      SPDLOG_WARN("page not existed, source_location: {}, dest: {}", source_location->uname, (uint32_t)request.dest_id);
    }
  }
  if (frame->dest() == home_->uid and frame->carrier_type() == Deregister::tag) {
    reader_->disjoin(location::make_shared(frame->data<Deregister>(), get_locator()));
  }
};

} // namespace kungfu::runtime::journal
