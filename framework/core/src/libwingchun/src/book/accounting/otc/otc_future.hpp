// SPDX-License-Identifier: Apache-2.0

//
// Created by Keren Dong on 2020/4/6.
//

#ifndef WINGCHUN_OTC_ACCOUNTING_FUTURE_H
#define WINGCHUN_OTC_ACCOUNTING_FUTURE_H

#include "../default/future.hpp"

using namespace kungfu::longfist::enums;
using namespace kungfu::longfist::types;
using namespace kungfu::wingchun;
using namespace kungfu::yijinjing;
using namespace kungfu::yijinjing::data;

namespace kungfu::wingchun::book {

class OtcFutureAccountingMethod : public FutureAccountingMethod {
public:
  OtcFutureAccountingMethod() = default;

  void apply_order_input(uint32_t account_id, uint32_t dest, Book_ptr &book, const OrderInput &input) override {
    if (dest == location::SYNC or dest == location::PUBLIC) {
      return;
    }

    auto offset = get_offset(book, account_id, input);

    auto apply = [&](auto &position) {
      auto future_i_a = get_future_instrument_attribute(book, position.source_id, position.direction, input.exchange_id,
                                                        input.instrument_id);

      if (offset == Offset::Open) {
        auto frozen_margin = future_i_a.contract_multiplier * input.frozen_price * future_i_a.exchange_rate *
                             input.volume * future_i_a.margin_ratio;

        book->asset.avail -= frozen_margin;
        book->asset.frozen_cash += frozen_margin;
        book->asset.frozen_margin += frozen_margin;
      } else {
        position.frozen_total += input.volume;
      }

      if (offset != Offset::Open) {
        position.frozen_yesterday += input.volume; // 平仓数量超过持仓数量时, 委托被柜台拒绝后会再扣回来
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
      auto future_i_a = get_future_instrument_attribute(book, position.source_id, position.direction, order.exchange_id,
                                                        order.instrument_id);

      if (offset == Offset::Open) {
        auto frozen_margin = future_i_a.contract_multiplier * order.frozen_price * future_i_a.exchange_rate *
                             order.volume_left * future_i_a.margin_ratio;

        book->asset.avail += frozen_margin;
        book->asset.frozen_cash -= frozen_margin;
        book->asset.frozen_margin -= frozen_margin;
      } else {
        position.frozen_total = std::max(position.frozen_total - order.volume_left, VOLUME_ZERO);
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

  void apply_close(Book_ptr &book, Position &position, const Trade &trade, bool is_local) override {
    auto future_i_a = get_future_instrument_attribute(book, position.source_id, position.direction, trade.exchange_id,
                                                      trade.instrument_id);
    auto contract_multiplier = future_i_a.contract_multiplier;
    auto margin = contract_multiplier * trade.price * future_i_a.exchange_rate * trade.volume * future_i_a.margin_ratio;
    auto delta_margin = std::min(position.margin, margin);
    position.margin -= delta_margin;
    position.volume -= trade.volume;
    position.last_price = position.last_price > 0 ? position.last_price : trade.price;

    if (is_local) {
      position.frozen_total = std::max(position.frozen_total - trade.volume, VOLUME_ZERO);
      position.frozen_yesterday = std::max(position.frozen_yesterday - trade.volume, VOLUME_ZERO);
    }

    position.yesterday_volume = std::max(position.yesterday_volume - trade.volume, VOLUME_ZERO);

    auto realized_pnl = (trade.price - position.avg_open_price) * trade.volume * contract_multiplier;
    if (position.direction == Direction::Short) {
      realized_pnl = -realized_pnl;
    }
    position.realized_pnl += realized_pnl;
    update_position(book, position);

    book->asset.realized_pnl += realized_pnl * future_i_a.exchange_rate;
    book->asset.avail += delta_margin;
    book->asset.margin -= margin;
  }
};
} // namespace kungfu::wingchun::book
#endif // WINGCHUN_ACCOUNTING_FUTURE_H
