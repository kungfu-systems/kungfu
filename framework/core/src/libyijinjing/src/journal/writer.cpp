// SPDX-License-Identifier: Apache-2.0

#include <algorithm>
#include <kungfu/common.h>
#include <kungfu/yijinjing/common.h>
#include <kungfu/yijinjing/journal/journal.h>
#include <kungfu/yijinjing/schema/core.h>
#include <limits>
#include <span>
#include <utility>

namespace kungfu::yijinjing::journal {
using namespace yijinjing::types;

// KF-ADR-019f86da-4f90-7650-bb2d-932dce8ae16a Phase 1: journal_frame_uid layout. The high 32 bits carry the full
// page_id and the low 32 bits carry the in-page frame number. Both are
// persistently monotonic on disk, so the pair is deterministically unique
// within one journal -- no probabilistic salt, no wrap. 32 bits for the frame
// number is far above any realistic per-page frame count (a 16 MB page caps at
// ~2^18 frames), so the low word never overflows into the page_id word.
constexpr unsigned FRAME_UID_PAGE_ID_SHIFT = 32u;
constexpr uint64_t FRAME_UID_FRAME_NB_MASK = 0x00000000FFFFFFFFull;

inline size_t checked_cpu_word_length(size_t length) {
  constexpr size_t mask = sizeof(uintptr_t) - 1;
  if (length > std::numeric_limits<size_t>::max() - mask) {
    throw journal_error("Frame payload length overflows CPU-word alignment");
  }
  return (length + mask) & ~mask;
}

inline void validate_cpu_word_alignment_input(size_t length) {
  constexpr size_t mask = sizeof(uintptr_t) - 1;
  if (length > std::numeric_limits<size_t>::max() - mask) {
    throw journal_error("Frame payload length overflows CPU-word alignment");
  }
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
  // KF-ADR-019f86da-4f90-7650-bb2d-932dce8ae16a Phase 1: structural, journal-local identity. (page_id, frame_nb)
  // is deterministically unique within one journal because page_id is monotonic
  // across the journal and frame_nb is monotonic within a page. This replaces
  // the old encoding whose 8-bit page slot wrapped deterministically past 4 GB
  // (256 x 16 MB) and whose 32-bit session salt was only probabilistically
  // unique. Cross-journal / permanent identity is not this id's job (KF-ADR-019f86da-4f90-7650-bb2d-932dce8ae16a
  // layer 2: Episode content root + stream_position).
  const uint64_t page_id = journal_->page_->page_id_;
  const uint64_t frame_nb = journal_->page_frame_nb_ & FRAME_UID_FRAME_NB_MASK;
  return (page_id << FRAME_UID_PAGE_ID_SHIFT) | frame_nb;
}

writer::frame_transaction::frame_transaction(writer &owner, struct frame *frame) noexcept
    : owner_(&owner), frame_(frame) {}

writer::frame_transaction::frame_transaction(frame_transaction &&other) noexcept
    : owner_(std::exchange(other.owner_, nullptr)), frame_(std::exchange(other.frame_, nullptr)) {}

writer::frame_transaction &writer::frame_transaction::operator=(frame_transaction &&other) noexcept {
  if (this != &other) {
    abort();
    owner_ = std::exchange(other.owner_, nullptr);
    frame_ = std::exchange(other.frame_, nullptr);
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
    owner_->abort_transaction_unserialized();
    owner_->writer_mtx_.unlock();
  }
  owner_ = nullptr;
  frame_ = nullptr;
}

void writer::frame_transaction::require_capacity(size_t length) const {
  if (owner_ == nullptr) {
    throw journal_error("Can not write to an inactive frame transaction");
  }
  if (length > owner_->size_to_write_) {
    throw journal_error(fmt::format("Frame payload of {} bytes exceeds the {} bytes reserved for {}", length,
                                    owner_->size_to_write_, owner_->journal_->location_->uname));
  }
}

void writer::frame_transaction::commit(size_t data_length, int64_t gen_time) {
  if (owner_ == nullptr) {
    throw journal_error("Can not commit an inactive frame transaction");
  }

  auto *owner = owner_;
  try {
    require_capacity(data_length);
    owner->commit_transaction_unserialized(data_length, gen_time, frame_);
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
  // The overflow check is independent of journal state and can run before the
  // lock. Page-capacity validation stays inside the lock in
  // prepare_frame_unserialized(), so concurrent callers never race page rollover.
  validate_cpu_word_alignment_input(data_length);
  if (!writer_mtx_.try_lock_for(std::chrono::seconds(30))) {
    throw journal_error("Can not lock writer for " + journal_->location_->uname);
  }

  try {
    auto *frame = prepare_frame_unserialized(trigger_time, carrier_type, data_length, stream_id);
    on_reservation_started(trigger_time, frame);
    return frame_transaction(*this, frame);
  } catch (...) {
    abort_transaction_unserialized();
    writer_mtx_.unlock();
    throw;
  }
}

struct frame *writer::prepare_frame_unserialized(int64_t trigger_time, int32_t carrier_type, size_t data_length,
                                                 uint64_t stream_id) {
  const auto requested_length = data_length;
  constexpr size_t mask = sizeof(uintptr_t) - 1;
  const auto aligned_length = (requested_length + mask) & ~mask;
  auto page_border = journal_->page_->address_border();
  if (!current_frame_has_capacity(aligned_length, page_border)) {
    // Keep the common path to one overflow-safe capacity comparison. Only a
    // page rollover (or an oversized request) needs the page-wide maximum.
    (void)validate_payload_length(requested_length);
    close_page(trigger_time);
    page_border = journal_->page_->address_border();
    if (!current_frame_has_capacity(aligned_length, page_border)) {
      throw journal_error("Frame payload does not fit on an empty journal page for " + journal_->location_->uname);
    }
  }
  auto &frame = journal_->current_frame();
  frame->set_header_length();
  frame->set_trigger_time(trigger_time);
  frame->set_carrier_type(carrier_type);
  frame->set_source(journal_->location_->uid);
  frame->set_initial_source(journal_->location_->uid);
  frame->set_dest(journal_->dest_id_);
  frame->set_stream_id(stream_id);
  size_to_write_ = requested_length;
  return frame.get();
}

size_t writer::validate_payload_length(size_t length) const {
  const auto aligned_length = checked_cpu_word_length(length);
  const auto body_size = journal_->page_->get_body_size();
  constexpr size_t publication_headers = 2 * sizeof(frame_header);
  if (body_size < publication_headers) {
    throw journal_error("Journal page is too small for frame and publication headers for " +
                        journal_->location_->uname);
  }
  const auto page_capacity = static_cast<size_t>(body_size - publication_headers);
  const auto wire_capacity = static_cast<size_t>(std::numeric_limits<uint32_t>::max() - sizeof(frame_header));
  const auto maximum = std::min(page_capacity, wire_capacity);
  if (aligned_length > maximum) {
    throw journal_error(fmt::format("Frame payload of {} bytes exceeds the {} byte page capacity for {}", length,
                                    maximum, journal_->location_->uname));
  }
  return aligned_length;
}

bool writer::current_frame_has_capacity(size_t aligned_payload_length, uintptr_t border) const {
  const auto frame_address = journal_->current_frame()->address();
  if (frame_address == 0 || frame_address > border) {
    throw journal_error("Current frame address is outside the journal page for " + journal_->location_->uname);
  }
  const auto available = static_cast<size_t>(border - frame_address);
  // page::address_border() already reserves the trailing next-frame header.
  return sizeof(frame_header) <= available && aligned_payload_length <= available - sizeof(frame_header);
}

size_t writer::validate_frame_commit(size_t data_length) const {
  if (data_length > size_to_write_) [[unlikely]] {
    throw journal_error(fmt::format("Frame commit of {} bytes exceeds the {} bytes reserved for {}", data_length,
                                    size_to_write_, journal_->location_->uname));
  }
  // The writer lock remains held from reservation through commit. Since the
  // committed length is no greater than the already-qualified reservation,
  // its aligned extent cannot exceed the page capacity proven at reservation.
  constexpr size_t mask = sizeof(uintptr_t) - 1;
  return (data_length + mask) & ~mask;
}

void writer::publish_frame_unserialized(size_t aligned_data_length, int64_t gen_time) {
  auto frame = journal_->current_frame();
  auto next_frame_address = frame->address() + frame->header_length() + aligned_data_length;
  memset(reinterpret_cast<void *>(next_frame_address), 0, sizeof(frame_header));
  frame->set_gen_time(gen_time);
  last_gen_time_ = gen_time;
  frame->set_frame_uid(current_frame_uid());
  frame->set_trigger_frame_uid(journal_->bus_->get_trigger_frame_uid());
  size_to_write_ = 0;
  journal_->page_->set_last_frame_position(frame->address() - journal_->page_->address());
  // KF-ADR-019f86da-4f90-7179-a900-c40bdb498910: publish the frame as the LAST step with a release store on `length`.
  // Every store above happens-before a reader's acquire-load of `length` in
  // frame::has_data(), so the frame is never observed with stale payload/header.
  frame->publish_data_length(aligned_data_length);
  journal_->next();
}

void writer::commit_transaction_unserialized(size_t data_length, int64_t gen_time, struct frame *frame) {
  const auto aligned_length = validate_frame_commit(data_length);
  on_transaction_committing(gen_time, frame);
  publish_frame_unserialized(aligned_length, gen_time);
}

void writer::copy_frame(const frame_ptr &source) {
  if (source == nullptr || source->address() == 0) {
    throw journal_error("Can not copy a null frame");
  }
  const auto source_frame_length = source->frame_length();
  const auto source_header_length = source->header_length();
  if (source_header_length != sizeof(frame_header) || source_frame_length < source_header_length) {
    throw journal_error("Can not copy a frame with an invalid source length");
  }
  const auto source_data_length = static_cast<size_t>(source_frame_length - source_header_length);
  const auto aligned_length = checked_cpu_word_length(source_data_length);
  if (aligned_length != source_data_length || sizeof(frame_header) + aligned_length != source_frame_length) {
    throw journal_error("Can not copy a frame with an inconsistent aligned length");
  }
  std::unique_lock<std::timed_mutex> lock(writer_mtx_, std::defer_lock);
  if (!lock.try_lock_for(std::chrono::seconds(30))) {
    throw journal_error("Can not lock writer for " + journal_->location_->uname);
  }
  (void)validate_payload_length(source_data_length);
  auto page_border = journal_->page_->address_border();
  if (!current_frame_has_capacity(aligned_length, page_border)) {
    close_page(yijinjing::time::now_in_nano());
    page_border = journal_->page_->address_border();
    if (!current_frame_has_capacity(aligned_length, page_border)) {
      throw journal_error("Source frame does not fit on an empty journal page for " + journal_->location_->uname);
    }
  }

  auto frame = journal_->current_frame();
  // KF-ADR-019f86da-4f90-7179-a900-c40bdb498910: copy() leaves `length` unwritten; compute the next-frame address
  // from the source size, zero the next header, then publish `length` last.
  frame->copy(*source);

  auto next_frame_address = frame->address() + source_frame_length;
  memset(reinterpret_cast<void *>(next_frame_address), 0, sizeof(frame_header));
  journal_->page_->set_last_frame_position(frame->address() - journal_->page_->address());
  frame->publish_data_length(source_data_length);
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

void writer::write_bytes(int64_t trigger_time, int32_t carrier_type, std::span<const std::byte> data) {
  auto tx = reserve_frame(trigger_time, carrier_type, data.size());
  tx.copy_bytes(data.data(), data.size());
  tx.commit(data.size());
}

void writer::on_reservation_started(int64_t trigger_time, struct frame *frame) {
  (void)trigger_time;
  (void)frame;
}

void writer::on_transaction_committing(int64_t gen_time, struct frame *frame) {
  (void)gen_time;
  (void)frame;
}

void writer::abort_transaction_unserialized() noexcept { size_to_write_ = 0; }

void writer::close_page(int64_t trigger_time) { journal_->close_page(trigger_time, last_gen_time_); }

void writer::release_page() { journal_->release_page(); }

void writer::preload_next_page() { journal_->preload_next_page(); }

} // namespace kungfu::yijinjing::journal
