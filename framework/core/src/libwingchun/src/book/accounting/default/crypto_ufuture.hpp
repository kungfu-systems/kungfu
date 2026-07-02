// SPDX-License-Identifier: Apache-2.0

//
// Created by marsjliu on 2024/3/28.
//

#ifndef WINGCHUN_ACCOUNTING_CRYPTO_UFUTURE_H
#define WINGCHUN_ACCOUNTING_CRYPTO_UFUTURE_H

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

  virtual void apply_quote(Book_ptr &book, const Quote &quote) override {}

  void apply_order_input(uint32_t account_id, uint32_t dest, Book_ptr &book, const OrderInput &input) override {
    if (dest == location::SYNC or dest == location::PUBLIC) {
      return;
    }
  }

  void apply_order(uint32_t account_id, uint32_t dest, Book_ptr &book, const Order &order) override {
    if (not guard_order_accounting(account_id, dest, book, order)) {
      return;
    }
  }

  void apply_trade(uint32_t account_id, uint32_t dest, Book_ptr &book, const Trade &trade) override {
    if (not guard_trade_accounting(account_id, dest, book, trade)) {
      return;
    }

    auto is_local = dest != location::PUBLIC and dest != location::SYNC;
    auto offset = trade.offset;
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
  }

  bool update_asset(const map::InstrumentMap &instruments, const map::InstrumentFactorMap &instrument_factors,
                    Asset &asset, const Position &position) override {
    return false;
  }

private:
  void apply_open(Book_ptr &book, Position &position, const Trade &trade, bool is_local) {
    if (position.volume + trade.volume > 0 && trade.price > 0) { // only calculate when greater than 0
      position.avg_open_price = (position.avg_open_price * position.volume + trade.price * trade.volume) /
                                double(position.volume + trade.volume);
    }
    position.volume += trade.volume;
    position.open_volume += trade.volume;
    position.last_price = position.last_price > 0 ? position.last_price : trade.price;
    update_position(book, position);
  }

  void apply_close(Book_ptr &book, Position &position, const Trade &trade, bool is_local) {
    position.volume -= trade.volume;
    position.last_price = position.last_price > 0 ? position.last_price : trade.price;
  }
};
} // namespace kungfu::wingchun::book
#endif // WINGCHUN_ACCOUNTING_CRYPTO_UFUTURE_H
