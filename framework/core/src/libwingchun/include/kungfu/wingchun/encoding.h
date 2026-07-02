// SPDX-License-Identifier: Apache-2.0

//
// Created by PolarAir on 2019-08-24.
//

#ifndef KUNGFU_ENCODING_H
#define KUNGFU_ENCODING_H

#include <string>

namespace kungfu::wingchun {
std::string gbk2utf8(const std::string &str);

std::string utf82gbk(const std::string &str);
} // namespace kungfu::wingchun

#endif // KUNGFU_ENCODING_H
