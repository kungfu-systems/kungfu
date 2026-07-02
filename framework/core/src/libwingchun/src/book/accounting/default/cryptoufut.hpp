// SPDX-License-Identifier: Apache-2.0

//
// Created by Keren Dong on 2020/4/6.
//

#ifndef WINGCHUN_ACCOUNTING_CRYPTOUFUTURE_H
#define WINGCHUN_ACCOUNTING_CRYPTOUFUTURE_H

#include "kungfu/wingchun/common.h"
#include <kungfu/wingchun/book/accounting.h>

using namespace kungfu::longfist::enums;
using namespace kungfu::longfist::types;
using namespace kungfu::wingchun;
using namespace kungfu::yijinjing;
using namespace kungfu::yijinjing::data;

namespace kungfu::wingchun::book {

class CryptoUFutureAccountingMethod : public AccountingMethod {
public:
  CryptoUFutureAccountingMethod() = default;

  void apply_quote(Book_ptr &book, const Quote &quote) override {
    auto apply = [&](Position &position) {
      if (position.volume <= 0) { // only calculate when greater than 0
        return;
      }
      // 使用bid1 ask1
      auto mid_price = (quote.ask_price[0] + quote.bid_price[0]) / 2;
      // crypto合约杠杆为自己设置, accounting中不考虑, margin不计算
      // auto margin_pre = position.margin;
      // position.settlement_price = mid_price;
      // position.margin = position.volume * mid_price;
      // book->asset.avail -= (position.direction == Direction::Long ? 1 : -1) * (position.margin - margin_pre);

      double price_change = mid_price - position.last_price;
      double market_value_change = (position.direction == Direction::Long ? 1 : -1) * price_change * position.volume;
      book->asset.market_value += market_value_change;

      position.last_price = mid_price;
      position.pre_settlement_price = mid_price;

      update_position(book, position);
    };

    book->apply_long_position_for(quote, apply);
    book->apply_short_position_for(quote, apply);
  }

  void apply_order_input(uint32_t account_id, uint32_t dest, Book_ptr &book, const OrderInput &input) override {
    if (dest == location::SYNC or dest == location::PUBLIC) {
      return;
    }

    auto offset = get_offset(book, account_id, input);

    auto apply = [&](auto &position) {
      if (offset == Offset::Open) {
        // 开仓不处理保证金
      } else {
        position.frozen_total += input.volume; // 平仓数量超过持仓数量时, 委托被柜台拒绝后会再扣回来
      }

      update_position(book, position);
    };

    auto direction = get_direction(input.instrument_type, input.side, offset);
    book->apply_position(account_id, direction, input.exchange_id, input.instrument_id, apply);
  }

  void apply_order(uint32_t account_id, uint32_t dest, Book_ptr &book, const Order &order) override {
    if (not guard_order_accounting(account_id, dest, book, order)) {
      return;
    }

    auto offset = get_offset(book, account_id, order);
    auto apply = [&](auto &position) {
      if (offset == Offset::Open) {
        // 开仓不处理保证金
      } else {
        position.frozen_total = std::max(position.frozen_total - order.volume_left, VOLUME_ZERO);
      }

      if (offset == Offset::Close or offset == Offset::CloseYesterday) {
        position.frozen_yesterday = std::max(position.frozen_yesterday - order.volume_left, VOLUME_ZERO);
      }

      update_position(book, position);
    };

    auto direction = get_direction(order.instrument_type, order.side, offset);
    book->apply_position(account_id, direction, order.exchange_id, order.instrument_id, apply);
  }

  void apply_trade(uint32_t account_id, uint32_t dest, Book_ptr &book, const Trade &trade) override {
    if (not guard_trade_accounting(account_id, dest, book, trade)) {
      return;
    }

    auto is_local = dest != location::PUBLIC and dest != location::SYNC;
    auto offset = get_offset(book, account_id, trade);
    auto apply = [&](auto &position) {
      if (offset == Offset::Open) {
        apply_open(book, position, trade, is_local);
      }
      if (offset == Offset::Close or offset == Offset::CloseToday or offset == Offset::CloseYesterday) {
        apply_close(book, position, trade, is_local);
      }
    };

    auto direction = get_direction(trade.instrument_type, trade.side, offset);
    book->apply_position(account_id, direction, trade.exchange_id, trade.instrument_id, apply);
  }

  void update_position(Book_ptr &book, Position &position) override {
    if (position.last_price <= 0) {
      return;
    }
    // 浮动盈亏计算
    auto multiplier = position.direction == Direction::Long ? 1 : -1;
    position.unrealized_pnl = (position.last_price - position.avg_open_price) * position.volume * multiplier;
  }

  bool update_asset(const map::InstrumentMap &instruments, const map::InstrumentFactorMap &instrument_factors,
                    Asset &asset, const Position &position) override {

    auto position_market_value =
        position.volume * (position.last_price > 0 ? position.last_price : position.avg_open_price);

    if (position.direction == Direction::Long) {
      asset.long_market_value += position_market_value;
    } else {
      asset.short_market_value += position_market_value;
    }

    asset.unrealized_pnl += position.unrealized_pnl;
    asset.market_value += position_market_value;
    asset.dynamic_equity += position.unrealized_pnl;
    return true;
  }

public:
  void apply_open(Book_ptr &book, Position &position, const Trade &trade, bool is_local) {
    if (position.volume + trade.volume > 0 && trade.price > 0) { // only calculate when greater than 0
      position.avg_open_price = (position.avg_open_price * position.volume + trade.price * trade.volume) /
                                double(position.volume + trade.volume);
      auto today_volume = position.volume;
    }
    position.volume += trade.volume;
    position.open_volume += trade.volume;
    position.last_price = position.last_price > 0 ? position.last_price : trade.price;
    update_position(book, position);

    auto commission = trade.commission;
    book->asset.avail -= commission;
    book->asset.accumulated_fee += commission;
    book->asset.intraday_fee += commission;
  }

  virtual void apply_close(Book_ptr &book, Position &position, const Trade &trade, bool is_local) {
    position.volume -= trade.volume;
    position.last_price = position.last_price > 0 ? position.last_price : trade.price;

    if (is_local) {
      position.frozen_total = std::max(position.frozen_total - trade.volume, VOLUME_ZERO);
      if (trade.offset != Offset::CloseToday) {
        position.frozen_yesterday = std::max(position.frozen_yesterday - trade.volume, VOLUME_ZERO);
      }
    }

    // 实现盈亏
    auto realized_pnl = (trade.price - position.avg_open_price) * trade.volume;

    if (position.direction == Direction::Short) {
      realized_pnl = -realized_pnl;
    }

    position.realized_pnl += realized_pnl;
    update_position(book, position);

    auto commission = trade.commission;
    book->asset.realized_pnl += realized_pnl;
    book->asset.avail -= commission;
    book->asset.accumulated_fee += commission;
    book->asset.intraday_fee += commission;
  }

  template <typename TradingData>
  [[nodiscard]] bool need_to_merge_long_short_positions(Book_ptr &book, uint32_t account_id,
                                                        const TradingData &trading_data) const {
    if (not able_long_short_position_merge(trading_data.exchange_id))
      return false;

    auto &position = book->get_opposite_position_for(account_id, trading_data);
    return position.volume > 0;
  }

  template <typename TradingData>
  [[nodiscard]] bool need_to_open_opposite(Book_ptr &book, uint32_t account_id, const TradingData &trading_data) const {
    if (not able_long_short_position_merge(trading_data.exchange_id))
      return false;

    auto &position = book->get_position_for(account_id, trading_data);
    return position.volume <= 0 && trading_data.offset != Offset::Open;
  }

  template <typename TradingData>
  [[nodiscard]] longfist::enums::Offset get_offset(Book_ptr &book, uint32_t account_id,
                                                   const TradingData &trading_data) const {
    auto offset = trading_data.offset;
    if (need_to_merge_long_short_positions(book, account_id, trading_data) && offset == Offset::Open) {
      return Offset::Close;
    }

    if (need_to_open_opposite(book, account_id, trading_data) && offset != Offset::Open) {
      return Offset::Open;
    }

    return offset;
  }

  static double calculate_commission(Book_ptr &book, const Trade &trade, const Position &position,
                                     double close_today_volume) {
    return 0.0;
  }

  static bool able_long_short_position_merge(const char *exchange_id) {
    // if (strcmp(exchange_id, EXCHANGE_BINANCE_USD_FUTURE) == 0 || strcmp(exchange_id, EXCHANGE_OKX_USD_FUTURE) == 0) {
    //   return true;
    // }

    return false;
  }
};
} // namespace kungfu::wingchun::book
#endif // WINGCHUN_ACCOUNTING_CRYPTOUFUTURE_H
