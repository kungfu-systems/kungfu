// SPDX-License-Identifier: Apache-2.0

//
// Created by dkr on 5/1/2020.
//

#include "sconv.hpp"
#include <kungfu/wingchun/encoding.h>

namespace kungfu::wingchun {
std::string gbk2utf8(const std::string &str) { return sconv::GbkToUtf8(str); }
std::string utf82gbk(const std::string &str) { return sconv::Utf8ToGbk(str); }
} // namespace kungfu::wingchun