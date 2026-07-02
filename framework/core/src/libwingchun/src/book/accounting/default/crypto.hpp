// SPDX-License-Identifier: Apache-2.0

//
// Created by qianyong liu on 2021/7/27.
//

#ifndef WINGCHUN_ACCOUNTING_CRYPTO_H
#define WINGCHUN_ACCOUNTING_CRYPTO_H

#include <kungfu/wingchun/book/accounting.h>

using namespace kungfu::longfist::enums;
using namespace kungfu::longfist::types;
using namespace kungfu::wingchun;
using namespace kungfu::yijinjing;
using namespace kungfu::yijinjing::data;

namespace kungfu::wingchun::book {
class CryptoAccountingMethod : public AccountingMethod {
public:
  CryptoAccountingMethod() = default;

  virtual void apply_quote(Book_ptr &book, const Quote &quote) override {}

  virtual void apply_order_input(uint32_t account_id, uint32_t dest, Book_ptr &book, const OrderInput &input) override {

  }

  virtual void apply_order(uint32_t account_id, uint32_t dest, Book_ptr &book, const Order &order) override {}

  virtual void apply_trade(uint32_t account_id, uint32_t dest, Book_ptr &book, const Trade &trade) override {
    if (not guard_trade_accounting(account_id, dest, book, trade)) {
      return;
    }

    auto is_local = dest != location::PUBLIC and dest != location::SYNC;

    std::string buy_instrument_id;
    std::string sell_instrument_id;
    parser_instrument_id(trade.instrument_id, buy_instrument_id, sell_instrument_id);

    if (!buy_instrument_id.empty()) {
      auto offset = trade.offset;
      auto apply_buy = [&](auto &position) {
        if (offset == Offset::Open) {
          apply_open(book, position, trade, is_local);
        } else if (offset == Offset::Close or offset == Offset::CloseToday or offset == Offset::CloseYesterday) {
          apply_close(book, position, trade, is_local);
        }

        update_position(book, position);
      };

      auto direction = get_direction(trade.instrument_type, trade.side, offset);
      book->apply_position(account_id, direction, trade.exchange_id, buy_instrument_id.c_str(), apply_buy);
    }

    if (!sell_instrument_id.empty()) {
      auto offset = diff_offset(trade.offset);
      auto apply_sell = [&](auto &position) {
        if (offset == Offset::Open) {
          apply_open_sell(book, position, trade, is_local);
        } else if (offset == Offset::Close or offset == Offset::CloseToday or offset == Offset::CloseYesterday) {
          apply_close_sell(book, position, trade, is_local);
        }

        update_position(book, position);
      };

      auto direction = get_direction(trade.instrument_type, diff_side(trade.side), offset);
      book->apply_position(account_id, direction, trade.exchange_id, sell_instrument_id.c_str(), apply_sell);
    }
  }

  void update_position(Book_ptr &book, Position &position) override { position.update_time = time::now_in_nano(); }

  bool update_asset(const map::InstrumentMap &instruments, const map::InstrumentFactorMap &instrument_factors,
                    Asset &asset, const Position &position) override {
    return false;
  }

protected:
  void apply_open(Book_ptr &book, Position &position, const Trade &trade, bool is_local) {
    position.volume += trade.volume;
    position.open_volume += trade.volume;
  }

  void apply_close(Book_ptr &book, Position &position, const Trade &trade, bool is_local) {
    position.volume -= trade.volume;
  }

  void apply_open_sell(Book_ptr &book, Position &position, const Trade &trade, bool is_local) {
    position.volume += trade.volume * trade.price;
    position.open_volume += trade.volume * trade.price;
  }

  void apply_close_sell(Book_ptr &book, Position &position, const Trade &trade, bool is_local) {
    position.volume -= trade.volume * trade.price;
  }

  // LTC-USDT，下单现货时是币对，比如买入，计算是LTC数量增加，USDT减少，持仓需要计算两个资产的数量变动
  void parser_instrument_id(const std::string &instrument_id, std::string &buy_instrument_id,
                            std::string &sell_instrument_id) {
    int nPos = instrument_id.find("-");

    if (nPos != std::string::npos) {
      buy_instrument_id = instrument_id.substr(0, nPos);
      sell_instrument_id = instrument_id.substr(nPos + 1, instrument_id.length() - nPos - 1);
    } else {
      buy_instrument_id = instrument_id;
    }
  }

  longfist::enums::Side diff_side(longfist::enums::Side side) {
    if (side == Side::Buy) {
      return Side::Sell;
    } else if (side == Side::Sell) {
      return Side::Buy;
    }

    return side;
  }

  longfist::enums::Offset diff_offset(longfist::enums::Offset offset) {
    if (offset == Offset::Open) {
      return Offset::Close;
    } else if (offset == Offset::Close) {
      return Offset::Open;
    }

    return offset;
  }
};
} // namespace kungfu::wingchun::book
#endif // WINGCHUN_ACCOUNTING_CRYPTO_H