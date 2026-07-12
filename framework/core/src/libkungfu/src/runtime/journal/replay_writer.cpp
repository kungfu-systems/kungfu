// SPDX-License-Identifier: Apache-2.0

#include <kungfu/common.h>
#include <kungfu/yijinjing/common.h>
#include <kungfu/yijinjing/journal/journal.h>
#include <kungfu/yijinjing/schema/registry.h>

namespace kungfu::yijinjing::journal {

replay_writer::replay_writer(const data::location_ptr &location, uint32_t dest_id, publisher_ptr publisher,
                             const bus_ptr &bus, uint64_t page_size, int64_t begin_time)
    : writer(location, dest_id, true, publisher, false, bus, page_size, begin_time),
      reader_for_write_(std::make_shared<reader>(true, false, bus)) {
  if (page::check_page_existed(location, dest_id)) {
    reader_for_write_->join(location, dest_id, begin_time, page_size);
  } else {
    SPDLOG_ERROR("page not existed, location: {}, dest: {}", location->uname, dest_id);
    throw yijinjing_error("page not existed");
  }
}

frame_ptr replay_writer::open_frame(int64_t trigger_time, int32_t carrier_type, size_t length, uint64_t stream_id) {
  while (reader_for_write_->data_available()) {
    auto frame = reader_for_write_->current_frame();
    if (frame->carrier_type() == carrier_type) {
      break;
    }
    reader_for_write_->next();
  }

  if (not reader_for_write_->data_available()) {
    throw replay_exhausted(carrier_type, trigger_time, get_location()->uname, get_dest());
  }

  cloned_frame_->copy(*reader_for_write_->current_frame());
  return cloned_frame_;
}

void replay_writer::close_frame(size_t data_length, int64_t gen_time) {
  if (reader_for_write_->data_available()) {
    cloned_frame_->copy(*reader_for_write_->current_frame());
    reader_for_write_->next();
  }
}

uint64_t replay_writer::current_frame_uid() {
  uint64_t uid = 0;
  auto frame = reader_for_write_->current_frame();
  boost::hana::for_each(yijinjing::AllDataTypes, [&](auto it) {
    using DataType = typename decltype(+boost::hana::second(it))::type;
    if (frame->carrier_type() == DataType::tag) {
      uid = frame->data<DataType>().uid();
    }
  });
  return uid;
}

writer::frame_transaction replay_writer::reserve_frame(int64_t trigger_time, int32_t carrier_type, size_t length,
                                                       uint64_t stream_id) {
  if (!writer_mtx_.try_lock_for(std::chrono::seconds(30))) {
    throw journal_error("Can not lock replay writer for " + journal_->location_->uname);
  }
  try {
    auto frame = open_frame(trigger_time, carrier_type, length, stream_id);
    return frame_transaction(*this, frame.get(), true);
  } catch (...) {
    writer_mtx_.unlock();
    throw;
  }
}
} // namespace kungfu::yijinjing::journal
