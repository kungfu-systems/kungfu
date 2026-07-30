// SPDX-License-Identifier: Apache-2.0

#include <kungfu/common.h>
#include <kungfu/yijinjing/common.h>
#include <kungfu/yijinjing/journal/journal.h>
#include <kungfu/yijinjing/schema/core.h>

namespace kungfu::yijinjing::journal {

void hookable_writer::on_frame_opened(int64_t trigger_time, struct frame *frame) {
  (void)frame;
  hook_->on_open_frame(trigger_time, journal_->current_frame());
}

void hookable_writer::on_frame_closing(int64_t gen_time, struct frame *frame) {
  (void)frame;
  hook_->on_close_frame(gen_time, journal_->current_frame());
}

} // namespace kungfu::yijinjing::journal
