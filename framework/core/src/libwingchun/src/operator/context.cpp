// SPDX-License-Identifier: Apache-2.0

//
// Created by Wei Jianan on 2022-12-12.
//

#include <fmt/format.h>

#include <kungfu/wingchun/operator/context.h>
#include <kungfu/yijinjing/log.h>
#include <kungfu/yijinjing/time.h>

using namespace kungfu::practice;
using namespace kungfu::rx;
using namespace kungfu::longfist;
using namespace kungfu::longfist::types;
using namespace kungfu::yijinjing;
using namespace kungfu::yijinjing::data;
using namespace kungfu::yijinjing::util;
using namespace kungfu::wingchun::orderbook;
using namespace kungfu::wingchun::factor;

namespace kungfu::wingchun::op {
Context::Context(apprentice &app, const rx::connectable_observable<event_ptr> &events) : app_(app), events_(events) {}

void Context::attach_orderbooks(Orderbooks &orderbooks) { orderbooks.on_start(events_); }

void Context::attach_factor_cache(factor::MultiCrossSectionalFactor &factor_cache) {
  set_runner(factor_cache, &app_);
  factor_cache.on_start(events_);
}

const std::string &Context::get_operator_dir() { return operator_dir_; }
} // namespace kungfu::wingchun::op
