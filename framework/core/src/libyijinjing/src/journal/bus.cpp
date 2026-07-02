#include <kungfu/yijinjing/journal/bus.h>
#include <kungfu/yijinjing/log.h>
#include <kungfu/yijinjing/time.h>

namespace kungfu::yijinjing::journal {

void bus::on_load_page() {
  SPDLOG_TRACE("on_load_page notify all");
  notify_all();
}

void bus::notify_all() {
  while (not cv_mutex_.try_lock()) {
  }
  ready_ = true;
  cv_mutex_.unlock();
  cv_.notify_all();
}

void bus::wait() {
  std::unique_lock lk(cv_mutex_);
  if (not ready_) {
    cv_.wait(lk, [&]() { return ready_; });
  }
  ready_ = false;
}

void bus::set_trigger_frame_uid(uint64_t frame_uid) { trigger_frame_uid_ = frame_uid; }

void bus::set_trigger_initial_source_id(uint32_t initial_source_id) { trigger_initial_source_id_ = initial_source_id; }

void bus::set_trigger_source_id(uint32_t source_id) { trigger_source_id_ = source_id; }

void bus::set_trigger_dest_id(uint32_t dest_id) { trigger_dest_id_ = dest_id; }

void bus::set_trigger_msg_type(int32_t msg_type) { trigger_msg_type_ = msg_type; }

uint64_t bus::get_trigger_frame_uid() { return trigger_frame_uid_; }

uint32_t bus::get_trigger_initial_source_id() { return trigger_initial_source_id_; }

uint32_t bus::get_trigger_source_id() { return trigger_source_id_; }

uint32_t bus::get_trigger_dest_id() { return trigger_dest_id_; }

int32_t bus::get_trigger_msg_type() { return trigger_msg_type_; }

void bus::set_trigger_frame(const event_ptr &event) {
  bus::set_trigger_frame_uid(event->frame_uid());
  bus::set_trigger_initial_source_id(event->initial_source());
  bus::set_trigger_source_id(event->source());
  bus::set_trigger_dest_id(event->dest());
  bus::set_trigger_msg_type(event->msg_type());
  log::set_trigger_frame_uid(event->frame_uid());
  log::set_trigger_initial_source_id(event->initial_source());
  log::set_trigger_source_id(event->source());
  log::set_trigger_dest_id(event->dest());
  log::set_trigger_msg_type(event->msg_type());
}

} // namespace kungfu::yijinjing::journal