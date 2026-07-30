// SPDX-License-Identifier: Apache-2.0

#ifndef KUNGFU_RUNTIME_UTIL_TERMINAL_H
#define KUNGFU_RUNTIME_UTIL_TERMINAL_H

#include <kungfu/common.h>

namespace kungfu::runtime::util {
void color_print(const std::string &level, const std::string &log);

bool in_color_terminal();

size_t get_thread_id();
} // namespace kungfu::runtime::util

#endif // KUNGFU_RUNTIME_UTIL_TERMINAL_H
