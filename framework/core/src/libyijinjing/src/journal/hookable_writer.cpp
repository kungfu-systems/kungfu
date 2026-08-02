// SPDX-License-Identifier: Apache-2.0

#include <kungfu/common.h>
#include <kungfu/yijinjing/common.h>
#include <kungfu/yijinjing/journal/journal.h>
#include <kungfu/yijinjing/schema/core.h>

namespace kungfu::yijinjing::journal {

void hookable_writer::on_reservation_started(int64_t trigger_time, struct frame *frame) {
  (void)frame;
  hook_->on_reservation_started(trigger_time, journal_->current_frame());
}

void hookable_writer::on_transaction_committing(int64_t gen_time, struct frame *frame) {
  (void)frame;
  hook_->on_transaction_committing(gen_time, journal_->current_frame());
}

} // namespace kungfu::yijinjing::journal
