// SPDX-License-Identifier: Apache-2.0

#include <kungfu/common.h>
#include <kungfu/longfist/core.h>
#include <kungfu/yijinjing/common.h>
#include <kungfu/yijinjing/journal/journal.h>

namespace kungfu::yijinjing::journal {

frame_ptr hookable_writer::open_frame(int64_t trigger_time, int32_t msg_type, size_t length, uint64_t stream_id) {
  frame_ptr frame = writer::open_frame(trigger_time, msg_type, length, stream_id);
  hook_->on_open_frame(trigger_time, frame);
  return frame;
}

void hookable_writer::close_frame(size_t data_length, int64_t gen_time) {
  hook_->on_close_frame(gen_time, journal_->current_frame());
  writer::close_frame(data_length, gen_time);
}

} // namespace kungfu::yijinjing::journal