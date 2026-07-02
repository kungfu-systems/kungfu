// SPDX-License-Identifier: Apache-2.0

//
// Created by marsjliu on 2023/4/11.
//

#ifndef WINGCHUN_ACCOUNTING_STOCK_LONG_SHORT_H
#define WINGCHUN_ACCOUNTING_STOCK_LONG_SHORT_H

#include "../default/stock.hpp"
#include <exception>
#include <math.h>
#include <mutex>

using namespace kungfu::longfist::enums;
using namespace kungfu::longfist::types;
using namespace kungfu::wingchun;
using namespace kungfu::yijinjing;
using namespace kungfu::yijinjing::data;

namespace kungfu::wingchun::book {

class OtcStockAccountingMethod : public StockAccountingMethod {
public:
  OtcStockAccountingMethod() = default;

  void apply_trade(uint32_t account_id, uint32_t dest, Book_ptr &book, const Trade &trade) override {
    if (not guard_trade_accounting(account_id, dest, book, trade)) {
      return;
    }

    auto is_local = dest != location::PUBLIC and dest != location::SYNC;

    auto apply = [&](auto &position) {
      if (trade.side == Side::Sell) {
        apply_sell(book, position, trade, is_local);
      } else if (trade.side == Side::Buy) {
        apply_buy(book, position, trade, is_local);
      }
    };

    book->apply_position_for(account_id, trade, apply);
  }
};
} // namespace kungfu::wingchun::book
#endif // WINGCHUN_ACCOUNTING_STOCK_LONG_SHORT_H
