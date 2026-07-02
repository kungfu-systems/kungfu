// SPDX-License-Identifier: Apache-2.0

#include <fmt/format.h>

#include <kungfu/longfist/fb/order_fb_builder.h>
#include <kungfu/longfist/fb/trade_fb_builder.h>
#include <kungfu/wingchun/strategy/matcher.h>
#include <kungfu/wingchun/strategy/runner.h>
#include <kungfu/yijinjing/log.h>
#include <kungfu/yijinjing/time.h>

#include <cstdlib>

// using namespace kungfu::practice;
using namespace kungfu::rx;
using namespace kungfu::longfist;
using namespace kungfu::longfist::types;
using namespace kungfu::longfist::enums;
using namespace kungfu::yijinjing;
using namespace kungfu::yijinjing::data;
using namespace kungfu::yijinjing::util;

namespace kungfu::wingchun::strategy {
void Matcher::update_order(const Order &order) {
  try {
    auto writer = app_->get_writer(location::PUBLIC);
    auto [source, dest] = get_source_dest(order.order_id);
    writer->write_raw_at_as(now(), now(), dest, source, order.tag, reinterpret_cast<uintptr_t>(&order), sizeof(order));
    // born-FB 写侧首切(仿真 Matcher,默认 OFF):仅当环境变量 KF_ORDER_BORN_FB 设定时,在 POD 写之外额外写一条
    // born-FB Order 帧(longfist::fb::ORDER_FB_TAG),与 POD Order(tag 202)并存;flag 未设=POD-only,实盘/仿真零变化。
    static const bool born_fb = std::getenv("KF_ORDER_BORN_FB") != nullptr;
    if (born_fb) {
      auto fb = longfist::fb::build_fb_order(order);
      writer->write_raw_at_as(now(), now(), dest, source, longfist::fb::ORDER_FB_TAG,
                              reinterpret_cast<uintptr_t>(fb.data()), static_cast<uint32_t>(fb.size()));
    }
  } catch (std::out_of_range &e) {
    throw std::out_of_range(
        fmt::format("order_id {} not found, it might already cancelled or filled.", order.order_id));
  }
}

void Matcher::update_trade(const Trade &trade) {
  try {
    auto writer = app_->get_writer(location::PUBLIC);
    auto [source, dest] = get_source_dest(trade.order_id);
    writer->write_raw_at_as(now(), now(), dest, source, trade.tag, reinterpret_cast<uintptr_t>(&trade), sizeof(trade));
    // born-FB 写侧(Order 同法第二类型,默认 OFF):仅当环境变量 KF_TRADE_BORN_FB 设定时,在 POD 写之外额外写一条
    // born-FB Trade 帧(longfist::fb::TRADE_FB_TAG),与 POD Trade(tag 203)并存;flag 未设=POD-only,实盘/仿真零变化。
    static const bool born_fb = std::getenv("KF_TRADE_BORN_FB") != nullptr;
    if (born_fb) {
      auto fb = longfist::fb::build_fb_trade(trade);
      writer->write_raw_at_as(now(), now(), dest, source, longfist::fb::TRADE_FB_TAG,
                              reinterpret_cast<uintptr_t>(fb.data()), static_cast<uint32_t>(fb.size()));
    }
  } catch (std::out_of_range &e) {
    throw std::out_of_range(
        fmt::format("order_id {} not found, it might already cancelled or filled.", trade.order_id));
  }
}

void Matcher::update_order_action_error(const OrderActionError &error) {
  try {
    auto writer = app_->get_writer(location::PUBLIC);
    auto [source, dest] = get_source_dest(error.order_id);
    writer->write_raw_at_as(now(), now(), dest, source, error.tag, reinterpret_cast<uintptr_t>(&error), sizeof(error));
  } catch (std::out_of_range &e) {
    throw std::out_of_range(
        fmt::format("order_id {} not found, it might already cancelled or filled.", error.order_id));
  }
}

void set_runner(Matcher &matcher, Runner *runner) { matcher.app_ = runner; }

void init_matcher(Matcher &matcher, book::Bookkeeper *bookkeeper, const std::string &matcher_config) {
  matcher.bookkeeper_ = bookkeeper;
  matcher.config_ = matcher_config;
}

void add_order_id(Matcher &matcher, uint64_t order_id, uint32_t source, uint32_t dest) {
  matcher.order_ids_.insert_or_assign(order_id, std::make_pair(source, dest));
};

void remove_order_id(Matcher &matcher, uint64_t order_id) { matcher.order_ids_.erase(order_id); };

void BasicMatcher::on_quote(const Quote &quote) {
  // InstrumentKey instrument_key{};
  // instrument_key.instrument_id = quote.instrument_id;
  // instrument_key.exchange_id = quote.exchange_id;
  // instrument_key.instrument_type = quote.instrument_type;
  quotes_[hash_instrument(quote.exchange_id, quote.instrument_id)] = quote;
  match();
};

void BasicMatcher::on_order_input(const OrderInput &order_input) {
  auto [stg_uid, td_uid] = get_source_dest(order_input.order_id);
  auto stg_book = get_bookkeeper()->get_book(stg_uid);
  auto td_book = get_bookkeeper()->get_book(td_uid);

  Order order{};
  order_from_input(order_input, order);
  if (order.price_type != PriceType::Limit) {
    order.status = OrderStatus::Error;
    order.error_id = 1;
    order.error_msg = "only limit order supported";
    update_order(order);
    return;
  } else {
    order.status = OrderStatus::Submitted;
    update_order(order);
  }
  auto side = order.side;
  if (quotes_.find(hash_instrument(order.exchange_id, order.instrument_id)) == quotes_.end()) {
    return;
  }
  const auto &quote = quotes_[hash_instrument(order.exchange_id, order.instrument_id)];
  if (side == Side::Buy and order.limit_price > quote.ask_price[0]) {
    Trade trade{};
    filled_order_trade(order, trade);
    trade.price = quote.ask_price[0];
    update_order(order);
    update_trade(trade);
  } else if (side == Side::Sell and order.limit_price < quote.bid_price[0]) {
    Trade trade{};
    filled_order_trade(order, trade);
    trade.price = quote.bid_price[0];
    update_order(order);
    update_trade(trade);
  } else {
    orders_[order.order_id] = order;
  }
}

void BasicMatcher::on_order_action(const OrderAction &order_action) {
  if (orders_.find(order_action.order_id) != orders_.end()) {
    Order order = orders_[order_action.order_id];
    order.status = OrderStatus::Cancelled;
    update_order(order);
    orders_.erase(order_action.order_id);
  } else {
    OrderActionError error{};
    error.order_id = order_action.order_id;
    error.error_id = 1;
    error.error_msg = fmt::format("order {} not found", order_action.order_id).c_str();
    // error.insert_time = order_action.insert_time;
    update_order_action_error(error);
  }
}

void BasicMatcher::filled_order_trade(Order &order, Trade &trade) {
  order.status = OrderStatus::Filled;
  order.update_time = now();
  order.volume_left = 0;
  // order.commision = 0;
  // order.tax = 0;
  trade.trade_id = order.order_id;
  trade.order_id = order.order_id;
  trade.trade_time = order.update_time;
  trade.instrument_id = order.instrument_id;
  trade.exchange_id = order.exchange_id;
  trade.instrument_type = order.instrument_type;
  trade.side = order.side;
  trade.offset = order.offset;
  trade.hedge_flag = order.hedge_flag;
  trade.price = order.limit_price;
  trade.volume = order.volume;
  // trade.tax = 0;
  // trade.commision = 0;
}

void BasicMatcher::match() {
  auto order_it = orders_.begin();
  while (order_it != orders_.end()) {
    auto &order = order_it->second;
    auto side = order.side;
    if (quotes_.find(hash_instrument(order.exchange_id, order.instrument_id)) == quotes_.end()) {
      order_it++;
      continue;
    }
    const auto &quote = quotes_[hash_instrument(order.exchange_id, order.instrument_id)];

    if ((side == Side::Buy and order.limit_price > quote.ask_price[0]) or
        (side == Side::Sell and order.limit_price < quote.bid_price[0])) {
      Trade trade{};
      filled_order_trade(order, trade);
      update_order(order);
      update_trade(trade);
      order_it = orders_.erase(order_it);
      continue;
    }
    order_it++;
  }
}
} // namespace kungfu::wingchun::strategy
