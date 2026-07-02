// SPDX-License-Identifier: Apache-2.0

#include <csignal>

#include <kungfu/common.h>
#include <kungfu/longfist/longfist.h>
#include <kungfu/yijinjing/common.h>
#include <kungfu/yijinjing/journal/journal.h>

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

frame_ptr replay_writer::open_frame(int64_t trigger_time, int32_t msg_type, size_t length, uint64_t stream_id) {
  while (reader_for_write_->data_available()) {
    auto frame = reader_for_write_->current_frame();
    if (frame->msg_type() == msg_type) {
      break;
    }
    reader_for_write_->next();
  }

  if (not reader_for_write_->data_available()) {
    SPDLOG_WARN("no more data available for msg_type {} trigger_time {}, from {} to {}", msg_type,
                time::strftime(trigger_time), get_location()->uname, get_dest());
    raise(SIGINT);
    cloned_frame_->open(length);
    cloned_frame_->set_header_length();
    cloned_frame_->set_trigger_time(trigger_time);
    cloned_frame_->set_msg_type(msg_type);
    cloned_frame_->set_source(journal_->location_->uid);
    cloned_frame_->set_initial_source(journal_->location_->uid);
    cloned_frame_->set_dest(journal_->dest_id_);
    cloned_frame_->set_stream_id(stream_id);
    return cloned_frame_;
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
  boost::hana::for_each(longfist::AllDataTypes, [&](auto it) {
    using DataType = typename decltype(+boost::hana::second(it))::type;
    if (frame->msg_type() == DataType::tag) {
      uid = frame->data<DataType>().uid();
    }
  });
  return uid;
}
} // namespace kungfu::yijinjing::journal