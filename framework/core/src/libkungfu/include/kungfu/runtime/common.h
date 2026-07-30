// SPDX-License-Identifier: Apache-2.0

#ifndef KUNGFU_RUNTIME_COMMON_H
#define KUNGFU_RUNTIME_COMMON_H

#include <kungfu/runtime/os.h>
#include <kungfu/runtime/util/terminal.h>
#include <kungfu/yijinjing/common.h>
#include <kungfu/yijinjing/journal/journal.h>
#include <kungfu/yijinjing/log.h>
#include <kungfu/yijinjing/storage.h>
#include <kungfu/yijinjing/time.h>

namespace kungfu::runtime {

using yijinjing::KB;
using yijinjing::MB;
using yijinjing::observer;
using yijinjing::observer_ptr;
using yijinjing::PUBLISH_NONBLOCK;
using yijinjing::publisher;
using yijinjing::publisher_ptr;
using yijinjing::resource;
using yijinjing::time;
using yijinjing::time_point_info;
using yijinjing::time_unit;
using yijinjing::yijinjing_error;

namespace data = yijinjing::data;
namespace log = yijinjing::log;
namespace storage = yijinjing::storage;

namespace journal {
using namespace yijinjing::journal;
}

namespace os {
using namespace ::kungfu::runtime::os;
}

namespace util {
using namespace ::kungfu::runtime::util;
}

} // namespace kungfu::runtime

#endif // KUNGFU_RUNTIME_COMMON_H
