// SPDX-License-Identifier: Apache-2.0

//
// Created by Keren Dong on 2019-06-04.
//

#ifndef KUNGFU_YIJINJING_JOURNAL_COMMON_H
#define KUNGFU_YIJINJING_JOURNAL_COMMON_H

#include <kungfu/yijinjing/common.h>

// ADR-0062: the journal container format epoch is no longer a hand-maintained
// integer. It is derived from the page_header/frame_header layout in
// <kungfu/yijinjing/journal/layout_fingerprint.h> as `journal_format_epoch`.

namespace kungfu::yijinjing::journal {

FORWARD_DECLARE_STRUCT_PTR(frame)

FORWARD_DECLARE_STRUCT_PTR(cloned_frame)

FORWARD_DECLARE_CLASS_PTR(page)

FORWARD_DECLARE_CLASS_PTR(journal)

FORWARD_DECLARE_CLASS_PTR(reader)

FORWARD_DECLARE_CLASS_PTR(writer)

FORWARD_DECLARE_CLASS_PTR(writer_hook)

FORWARD_DECLARE_CLASS_PTR(hookable_writer)

FORWARD_DECLARE_CLASS_PTR(replay_writer)

class journal_error : public std::runtime_error {
public:
  explicit journal_error(const std::string &message) : journal_error(message, true) {}

protected:
  journal_error(const std::string &message, bool log) : runtime_error(message) {
    if (log) {
      SPDLOG_CRITICAL(message);
    }
  }
};

class replay_exhausted : public journal_error {
public:
  replay_exhausted(int32_t carrier_type, int64_t trigger_time, const std::string &location, uint32_t dest)
      : journal_error(fmt::format("replay exhausted for carrier_type {} trigger_time {}, from {} to {}", carrier_type,
                                  trigger_time, location, dest),
                      false),
        carrier_type_(carrier_type), trigger_time_(trigger_time) {}

  [[nodiscard]] int32_t carrier_type() const noexcept { return carrier_type_; }
  [[nodiscard]] int64_t trigger_time() const noexcept { return trigger_time_; }

private:
  int32_t carrier_type_;
  int64_t trigger_time_;
};
} // namespace kungfu::yijinjing::journal

#endif // KUNGFU_YIJINJING_JOURNAL_COMMON_H
