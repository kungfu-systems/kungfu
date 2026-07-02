// SPDX-License-Identifier: Apache-2.0

//
// Created by Keren Dong on 2019-06-04.
//

#ifndef KUNGFU_YIJINJING_JOURNAL_COMMON_H
#define KUNGFU_YIJINJING_JOURNAL_COMMON_H

#include <kungfu/yijinjing/common.h>

#define __JOURNAL_VERSION__ 4

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
  explicit journal_error(const std::string &message) : runtime_error(message) { SPDLOG_CRITICAL(message); }
};
} // namespace kungfu::yijinjing::journal

#endif // KUNGFU_YIJINJING_JOURNAL_COMMON_H
