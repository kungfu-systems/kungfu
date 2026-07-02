// SPDX-License-Identifier: Apache-2.0

//
// Created by Keren Dong on 2019-06-20.
//

#include <kungfu/wingchun/strategy/context.h>

using namespace kungfu::practice;
using namespace kungfu::rx;
using namespace kungfu::longfist;
using namespace kungfu::longfist::types;
using namespace kungfu::longfist::enums;
using namespace kungfu::yijinjing;
using namespace kungfu::yijinjing::data;
using namespace kungfu::yijinjing::util;
using namespace kungfu::wingchun::orderbook;
using namespace kungfu::wingchun::factor;

namespace kungfu::wingchun::strategy {
Context::Context(apprentice &app, const rx::connectable_observable<event_ptr> &events) : app_(app), events_(events) {
  bypass_accounting_ = std::getenv("KF_BYPASS_ACCOUNTING") != nullptr;
}

bool Context::is_book_held() const { return book_held_; }

bool Context::is_positions_held() const { return not positions_mirrored_; }

void Context::hold_book() { book_held_ = true; }

void Context::hold_positions() { positions_mirrored_ = false; }

void Context::bypass_accounting() { bypass_accounting_ = true; }

bool Context::is_bypass_accounting() const { return bypass_accounting_; }

void Context::attach_orderbooks(wingchun::orderbook::Orderbooks &orderbooks) { orderbooks.on_start(events_); }

void Context::attach_factor_cache(factor::MultiCrossSectionalFactor &factor_cache) {
  set_runner(factor_cache, &app_);
  factor_cache.on_start(events_);
}

const std::string &Context::get_strategy_dir() { return strategy_dir_; }

} // namespace kungfu::wingchun::strategy
