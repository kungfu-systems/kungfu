// SPDX-License-Identifier: Apache-2.0

#ifndef WINGCHUN_ACCOUNTING_REPO_H
#define WINGCHUN_ACCOUNTING_REPO_H

#include "stock.hpp"

namespace kungfu::wingchun::book {
class RepoAccountingMethod : public StockAccountingMethod {
public:
  RepoAccountingMethod() = default;

  void apply_quote(Book_ptr &book, const Quote &quote) override {}

  void apply_order_input(uint32_t account_id, uint32_t dest, Book_ptr &book, const OrderInput &input) override {
    if (dest == location::SYNC or dest == location::PUBLIC) {
      return;
    }

    auto apply = [&](auto &position) {
      auto stock_i_a = get_stock_instrument_attribute(book, position.source_id, position.direction,
                                                      position.exchange_id, position.instrument_id);
      if (input.side == Side::Sell) {
        book->asset.frozen_cash += input.volume * stock_i_a.exchange_rate;
        book->asset.avail -= input.volume * stock_i_a.exchange_rate;
        update_position(book, position);
      }
    };

    book->apply_position_for(account_id, input, apply);
  }

  void apply_order(uint32_t account_id, uint32_t dest, Book_ptr &book, const Order &order) override {
    if (not guard_order_accounting(account_id, dest, book, order)) {
      return;
    }

    auto apply = [&](auto &position) {
      auto stock_i_a = get_stock_instrument_attribute(book, position.source_id, position.direction,
                                                      position.exchange_id, position.instrument_id);
      if (order.side == Side::Sell) {
        book->asset.frozen_cash -= order.volume_left * stock_i_a.exchange_rate;
        book->asset.avail += order.volume_left * stock_i_a.exchange_rate;
      }
      update_position(book, position);
    };

    book->apply_position_for(account_id, order, apply);
  }

  void update_position(Book_ptr &book, Position &position) override {
    // 无需计算逆回购的收益，逆回购收益在买入时就固定了
  }

  void apply_sell(Book_ptr &book, longfist::types::Position &position, const Trade &trade, bool is_local) override {
    if (position.volume + trade.volume > 0 && trade.price > 0) {
      position.avg_open_price = (position.avg_open_price * position.volume + trade.price * trade.volume) /
                                (double)(position.volume + trade.volume);
    }
    auto stock_i_a = get_stock_instrument_attribute(book, position.source_id, position.direction, position.exchange_id,
                                                    position.instrument_id);
    position.avg_open_price = 1;
    auto commission = calculate_commission(book, position, trade);
    auto tax = calculate_tax(trade);
    position.volume += trade.volume;
    update_position(book, position);

    if (is_local) {
      book->asset.frozen_cash -= trade.volume * stock_i_a.exchange_rate;
    }

    book->asset.avail -= commission + tax;
    book->asset.intraday_fee += commission + tax;
    book->asset.accumulated_fee += commission + tax;
  }

  double calculate_commission(Book_ptr &book, longfist::types::Position &position, const Trade &trade) {
    auto stock_i_a = get_stock_instrument_attribute(book, position.source_id, position.direction, position.exchange_id,
                                                    position.instrument_id);
    auto rate = get_repo_commission_rate(trade.instrument_id);
    return trade.volume * rate * stock_i_a.exchange_rate;
  }

  double calculate_tax(const Trade &trade) override { return 0.0; }
};
} // namespace kungfu::wingchun::book

#endif