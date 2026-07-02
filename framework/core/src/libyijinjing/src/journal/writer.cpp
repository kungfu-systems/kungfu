// SPDX-License-Identifier: Apache-2.0

#include <kungfu/common.h>
#include <kungfu/longfist/core.h>
#include <kungfu/yijinjing/common.h>
#include <kungfu/yijinjing/journal/journal.h>

namespace kungfu::yijinjing::journal {
using namespace longfist::types;

constexpr uint32_t PAGE_ID_TRANC = 0xFF000000;
constexpr uint32_t FRAME_ID_TRANC = 0x00FFFFFF;

inline size_t verify_cpu_word_length(size_t length) {
  return ((length + (sizeof(uintptr_t) - 1)) & ~(sizeof(uintptr_t) - 1));
}

writer::writer(const data::location_ptr &location, uint32_t dest_id, bool lazy, publisher_ptr publisher,
               bool low_latency, const bus_ptr &bus, const journal_ptr &journal, int64_t begin_time)
    : frame_id_base_(static_cast<uint64_t>(location->uid xor dest_id) << 32u), journal_(journal),
      publisher_(std::move(publisher)), size_to_write_(0), last_gen_time_(0),
      writer_start_time_32int_(time::nano_hashed(time::now_in_nano())) {
  journal_->seek_to_time(begin_time);
}

writer::writer(const data::location_ptr &location, uint32_t dest_id, bool lazy, publisher_ptr publisher,
               bool low_latency, const bus_ptr &bus)
    : writer(location, dest_id, lazy, std::move(publisher), low_latency, bus,
             std::make_shared<journal>(location, dest_id, true, lazy, low_latency, bus,
                                       page::find_page_size(location, dest_id)),
             time::now_in_nano()) {}

writer::writer(const data::location_ptr &location, uint32_t dest_id, bool lazy, publisher_ptr publisher,
               bool low_latency, const bus_ptr &bus, uint64_t page_size)
    : writer(location, dest_id, lazy, std::move(publisher), low_latency, bus,
             std::make_shared<journal>(location, dest_id, true, lazy, low_latency, bus,
                                       page::find_page_size(location, dest_id, page_size)),
             time::now_in_nano()) {}

writer::writer(const data::location_ptr &location, uint32_t dest_id, bool lazy, publisher_ptr publisher,
               bool low_latency, const bus_ptr &bus, uint64_t page_size, int64_t begin_time)
    : writer(location, dest_id, lazy, std::move(publisher), low_latency, bus,
             std::make_shared<journal>(location, dest_id, true, lazy, low_latency, bus,
                                       page::find_page_size(location, dest_id, page_size)),
             begin_time) {}

uint64_t writer::current_frame_uid() {
  uint32_t page_part = (journal_->page_->page_id_ << 24u) & PAGE_ID_TRANC;
  uint32_t frame_part = journal_->page_frame_nb_ & FRAME_ID_TRANC;
  // frame_id_base is used for get account id while canceling order
  return frame_id_base_ | ((page_part | frame_part) xor writer_start_time_32int_);
}

frame_ptr writer::open_frame_lock_free(int64_t trigger_time, int32_t msg_type, size_t data_length, uint64_t stream_id) {
  data_length = verify_cpu_word_length(data_length);
  int64_t start_time = time::now_in_nano();
  assert(sizeof(frame_header) + data_length + sizeof(frame_header) <= journal_->page_->get_page_size());
  if (journal_->current_frame()->address() + sizeof(frame_header) + data_length >= journal_->page_->address_border()) {
    close_page(trigger_time);
  }
  auto frame = journal_->current_frame();
  frame->set_header_length();
  frame->set_trigger_time(trigger_time);
  frame->set_msg_type(msg_type);
  frame->set_source(journal_->location_->uid);
  frame->set_initial_source(journal_->location_->uid);
  frame->set_dest(journal_->dest_id_);
  frame->set_stream_id(stream_id);
  size_to_write_ = data_length;
  return frame;
}

frame_ptr writer::open_frame(int64_t trigger_time, int32_t msg_type, size_t data_length, uint64_t stream_id) {
  int64_t start_time = time::now_in_nano();
  while (not writer_mtx_.try_lock()) {
    if (time::now_in_nano() - start_time > 30 * time_unit::NANOSECONDS_PER_SECOND) {
      throw journal_error("Can not lock writer for " + journal_->location_->uname);
    }
  }
  return open_frame_lock_free(trigger_time, msg_type, data_length, stream_id);
}

void writer::close_frame_lock_free(size_t data_length, int64_t gen_time) {
  data_length = verify_cpu_word_length(data_length);
  assert(size_to_write_ >= data_length);
  auto frame = journal_->current_frame();
  auto next_frame_address = frame->address() + frame->header_length() + data_length;
  assert(next_frame_address < journal_->page_->address_border());
  memset(reinterpret_cast<void *>(next_frame_address), 0, sizeof(frame_header));
  frame->set_gen_time(gen_time);
  last_gen_time_ = gen_time;
  frame->set_frame_uid(current_frame_uid());
  frame->set_trigger_frame_uid(journal_->bus_->get_trigger_frame_uid());
  size_to_write_ = 0;
  journal_->page_->set_last_frame_position(frame->address() - journal_->page_->address());
  // ADR-0001: publish the frame as the LAST step with a release store on `length`.
  // Every store above happens-before a reader's acquire-load of `length` in
  // frame::has_data(), so the frame is never observed with stale payload/header.
  frame->publish_data_length(data_length);
  journal_->next();
}

void writer::close_frame(size_t data_length, int64_t gen_time) {
  close_frame_lock_free(data_length, gen_time);
  writer_mtx_.unlock();
  publisher_->notify();
}

void writer::copy_frame(const frame_ptr &source) {
  assert(source->frame_length() + sizeof(frame_header) <= journal_->page_->get_page_size());
  if (journal_->current_frame()->address() + source->frame_length() >= journal_->page_->address_border()) {
    close_page(yijinjing::time::now_in_nano());
  }

  auto frame = journal_->current_frame();
  // ADR-0001: copy() leaves `length` unwritten; compute the next-frame address
  // from the source size, zero the next header, then publish `length` last.
  frame->copy(*source);

  auto next_frame_address = frame->address() + source->frame_length();
  memset(reinterpret_cast<void *>(next_frame_address), 0, sizeof(frame_header));
  journal_->page_->set_last_frame_position(frame->address() - journal_->page_->address());
  frame->publish_data_length(source->data_length());
  journal_->next();
  publisher_->notify();
}

void writer::mark(int64_t trigger_time, int32_t msg_type) {
  open_frame(trigger_time, msg_type, 0);
  close_frame(0);
}

void writer::mark_at(int64_t gen_time, int64_t trigger_time, int32_t msg_type) {
  open_frame(trigger_time, msg_type, 0);
  close_frame(0, gen_time);
}

void writer::write_raw(int64_t trigger_time, int32_t msg_type, uintptr_t data, uint32_t length) {
  auto frame = open_frame(trigger_time, msg_type, length);
  memcpy(const_cast<void *>(frame->data_address()), reinterpret_cast<void *>(data), length);
  close_frame(length);
}

void writer::write_bytes(int64_t trigger_time, int32_t msg_type, const std::vector<uint8_t> &data, uint32_t length) {
  auto frame = open_frame(trigger_time, msg_type, length);
  memcpy(const_cast<void *>(frame->data_address()), data.data(), length);
  close_frame(length);
}

void writer::write_raw_at_as(int64_t gen_time, int64_t trigger_time, uint32_t source, uint32_t dest, int32_t msg_type,
                             uintptr_t data, uint32_t length) {
  auto frame = open_frame(trigger_time, msg_type, length);
  frame->set_source(source);
  frame->set_dest(dest);
  memcpy(const_cast<void *>(frame->data_address()), reinterpret_cast<void *>(data), length);
  close_frame(length, gen_time);
}

void writer::close_data(int64_t gen_time) { close_frame(size_to_write_, gen_time); }

void writer::close_page(int64_t trigger_time) { journal_->close_page(trigger_time, last_gen_time_); }

void writer::release_page() { journal_->release_page(); }

void writer::preload_next_page() { journal_->preload_next_page(); }

} // namespace kungfu::yijinjing::journal
