// SPDX-License-Identifier: Apache-2.0

#include <kungfu/common.h>
#include <kungfu/yijinjing/common.h>
#include <kungfu/yijinjing/journal/journal.h>
#include <kungfu/yijinjing/schema/core.h>
#include <utility>

namespace kungfu::yijinjing::journal {
using namespace yijinjing::types;

// ADR-0072 Phase 1: journal_frame_uid layout. The high 32 bits carry the full
// page_id and the low 32 bits carry the in-page frame number. Both are
// persistently monotonic on disk, so the pair is deterministically unique
// within one journal -- no probabilistic salt, no wrap. 32 bits for the frame
// number is far above any realistic per-page frame count (a 16 MB page caps at
// ~2^18 frames), so the low word never overflows into the page_id word.
constexpr unsigned FRAME_UID_PAGE_ID_SHIFT = 32u;
constexpr uint64_t FRAME_UID_FRAME_NB_MASK = 0x00000000FFFFFFFFull;

inline size_t verify_cpu_word_length(size_t length) {
  return ((length + (sizeof(uintptr_t) - 1)) & ~(sizeof(uintptr_t) - 1));
}

writer::writer(const data::location_ptr &location, uint32_t dest_id, publisher_ptr publisher,
               const journal_ptr &journal, int64_t begin_time)
    : writer_lease_(ownership::lease::acquire_stream_writer(location->locator->get_root(),
                                                            fmt::format("{:08x}.{:08x}", location->uid, dest_id))),
      journal_(journal), publisher_(std::move(publisher)), size_to_write_(0), last_gen_time_(0) {
  journal_->seek_to_time(begin_time);
}

writer::writer(const data::location_ptr &location, uint32_t dest_id, publisher_ptr publisher, bool low_latency,
               const bus_ptr &bus)
    : writer(location, dest_id, std::move(publisher),
             std::make_shared<journal>(location, dest_id, journal_open_policy::writer(), low_latency, bus,
                                       page::find_page_size(location, dest_id)),
             time::now_in_nano()) {}

writer::writer(const data::location_ptr &location, uint32_t dest_id, publisher_ptr publisher, bool low_latency,
               const bus_ptr &bus, uint64_t page_size)
    : writer(location, dest_id, std::move(publisher),
             std::make_shared<journal>(location, dest_id, journal_open_policy::writer(), low_latency, bus,
                                       page::find_page_size(location, dest_id, page_size)),
             time::now_in_nano()) {}

writer::writer(const data::location_ptr &location, uint32_t dest_id, publisher_ptr publisher, bool low_latency,
               const bus_ptr &bus, uint64_t page_size, int64_t begin_time)
    : writer(location, dest_id, std::move(publisher),
             std::make_shared<journal>(location, dest_id, journal_open_policy::writer(), low_latency, bus,
                                       page::find_page_size(location, dest_id, page_size)),
             begin_time) {}

uint64_t writer::current_frame_uid() {
  // ADR-0072 Phase 1: structural, journal-local identity. (page_id, frame_nb)
  // is deterministically unique within one journal because page_id is monotonic
  // across the journal and frame_nb is monotonic within a page. This replaces
  // the old encoding whose 8-bit page slot wrapped deterministically past 4 GB
  // (256 x 16 MB) and whose 32-bit session salt was only probabilistically
  // unique. Cross-journal / permanent identity is not this id's job (ADR-0072
  // layer 2: Episode content root + stream_position).
  const uint64_t page_id = journal_->page_->page_id_;
  const uint64_t frame_nb = journal_->page_frame_nb_ & FRAME_UID_FRAME_NB_MASK;
  return (page_id << FRAME_UID_PAGE_ID_SHIFT) | frame_nb;
}

writer::frame_transaction::frame_transaction(writer &owner, struct frame *frame, bool replay) noexcept
    : owner_(&owner), frame_(frame), replay_(replay) {}

writer::frame_transaction::frame_transaction(frame_transaction &&other) noexcept
    : owner_(std::exchange(other.owner_, nullptr)), frame_(std::exchange(other.frame_, nullptr)),
      replay_(other.replay_) {}

writer::frame_transaction &writer::frame_transaction::operator=(frame_transaction &&other) noexcept {
  if (this != &other) {
    abort();
    owner_ = std::exchange(other.owner_, nullptr);
    frame_ = std::exchange(other.frame_, nullptr);
    replay_ = other.replay_;
  }
  return *this;
}

writer::frame_transaction::~frame_transaction() {
  if (owner_ != nullptr) {
    abort();
  }
}

void writer::frame_transaction::abort() noexcept {
  if (owner_ != nullptr) {
    owner_->abort_frame_unserialized();
    owner_->writer_mtx_.unlock();
  }
  owner_ = nullptr;
  frame_ = nullptr;
}

void writer::frame_transaction::commit(size_t data_length, int64_t gen_time) {
  if (owner_ == nullptr) {
    throw journal_error("Can not commit an inactive frame transaction");
  }

  auto *owner = owner_;
  try {
    if (replay_) {
      owner->close_frame(data_length, gen_time);
    } else {
      owner->on_frame_closing(gen_time, frame_);
      owner->close_frame_unserialized(data_length, gen_time);
    }
  } catch (...) {
    abort();
    throw;
  }

  owner_ = nullptr;
  frame_ = nullptr;
  owner->writer_mtx_.unlock();
  owner->publisher_->notify();
}

writer::frame_transaction writer::reserve_frame(int64_t trigger_time, int32_t carrier_type, size_t data_length,
                                                uint64_t stream_id) {
  if (!writer_mtx_.try_lock_for(std::chrono::seconds(30))) {
    throw journal_error("Can not lock writer for " + journal_->location_->uname);
  }

  try {
    auto *frame = open_frame_unserialized(trigger_time, carrier_type, data_length, stream_id);
    on_frame_opened(trigger_time, frame);
    return frame_transaction(*this, frame);
  } catch (...) {
    abort_frame_unserialized();
    writer_mtx_.unlock();
    throw;
  }
}

struct frame *writer::open_frame_unserialized(int64_t trigger_time, int32_t carrier_type, size_t data_length,
                                              uint64_t stream_id) {
  data_length = verify_cpu_word_length(data_length);
  assert(sizeof(frame_header) + data_length + sizeof(frame_header) <= journal_->page_->get_page_size());
  if (journal_->current_frame()->address() + sizeof(frame_header) + data_length >= journal_->page_->address_border()) {
    close_page(trigger_time);
  }
  auto &frame = journal_->current_frame();
  frame->set_header_length();
  frame->set_trigger_time(trigger_time);
  frame->set_carrier_type(carrier_type);
  frame->set_source(journal_->location_->uid);
  frame->set_initial_source(journal_->location_->uid);
  frame->set_dest(journal_->dest_id_);
  frame->set_stream_id(stream_id);
  size_to_write_ = data_length;
  return frame.get();
}

frame_ptr writer::open_frame_lock_free(int64_t trigger_time, int32_t carrier_type, size_t data_length,
                                       uint64_t stream_id) {
  open_frame_unserialized(trigger_time, carrier_type, data_length, stream_id);
  return journal_->current_frame();
}

frame_ptr writer::open_frame(int64_t trigger_time, int32_t carrier_type, size_t data_length, uint64_t stream_id) {
  if (!writer_mtx_.try_lock_for(std::chrono::seconds(30))) {
    throw journal_error("Can not lock writer for " + journal_->location_->uname);
  }
  try {
    auto *frame = open_frame_unserialized(trigger_time, carrier_type, data_length, stream_id);
    on_frame_opened(trigger_time, frame);
    return journal_->current_frame();
  } catch (...) {
    abort_frame_unserialized();
    writer_mtx_.unlock();
    throw;
  }
}

void writer::close_frame_unserialized(size_t data_length, int64_t gen_time) {
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

void writer::close_frame_lock_free(size_t data_length, int64_t gen_time) {
  close_frame_unserialized(data_length, gen_time);
}

void writer::close_frame(size_t data_length, int64_t gen_time) {
  try {
    on_frame_closing(gen_time, journal_->current_frame().get());
    close_frame_unserialized(data_length, gen_time);
  } catch (...) {
    abort_frame_unserialized();
    writer_mtx_.unlock();
    throw;
  }
  writer_mtx_.unlock();
  publisher_->notify();
}

void writer::copy_frame(const frame_ptr &source) {
  std::unique_lock<std::timed_mutex> lock(writer_mtx_, std::defer_lock);
  if (!lock.try_lock_for(std::chrono::seconds(30))) {
    throw journal_error("Can not lock writer for " + journal_->location_->uname);
  }
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
  lock.unlock();
  publisher_->notify();
}

void writer::mark(int64_t trigger_time, int32_t carrier_type) {
  auto tx = reserve_frame(trigger_time, carrier_type, 0);
  tx.commit(0);
}

void writer::mark_at(int64_t gen_time, int64_t trigger_time, int32_t carrier_type) {
  auto tx = reserve_frame(trigger_time, carrier_type, 0);
  tx.commit(0, gen_time);
}

void writer::write_raw(int64_t trigger_time, int32_t carrier_type, uintptr_t data, uint32_t length) {
  auto tx = reserve_frame(trigger_time, carrier_type, length);
  memcpy(tx.data(), reinterpret_cast<void *>(data), length);
  tx.commit(length);
}

void writer::write_bytes(int64_t trigger_time, int32_t carrier_type, const std::vector<uint8_t> &data,
                         uint32_t length) {
  auto tx = reserve_frame(trigger_time, carrier_type, length);
  memcpy(tx.data(), data.data(), length);
  tx.commit(length);
}

void writer::write_raw_at_as(int64_t gen_time, int64_t trigger_time, uint32_t source, uint32_t dest,
                             int32_t carrier_type, uintptr_t data, uint32_t length) {
  auto tx = reserve_frame(trigger_time, carrier_type, length);
  tx.frame()->set_source(source);
  tx.frame()->set_dest(dest);
  memcpy(tx.data(), reinterpret_cast<void *>(data), length);
  tx.commit(length, gen_time);
}

void writer::close_data(int64_t gen_time) { close_frame(size_to_write_, gen_time); }

void writer::on_frame_opened(int64_t trigger_time, struct frame *frame) {
  (void)trigger_time;
  (void)frame;
}

void writer::on_frame_closing(int64_t gen_time, struct frame *frame) {
  (void)gen_time;
  (void)frame;
}

void writer::abort_frame_unserialized() noexcept { size_to_write_ = 0; }

void writer::close_page(int64_t trigger_time) { journal_->close_page(trigger_time, last_gen_time_); }

void writer::release_page() { journal_->release_page(); }

void writer::preload_next_page() { journal_->preload_next_page(); }

} // namespace kungfu::yijinjing::journal
