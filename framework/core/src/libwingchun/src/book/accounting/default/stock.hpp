// SPDX-License-Identifier: Apache-2.0

//
// Created by Keren Dong on 2020/4/6.
// Updated for Margin Account on 2022/6/6
//

#ifndef WINGCHUN_ACCOUNTING_STOCK_H
#define WINGCHUN_ACCOUNTING_STOCK_H

#include <exception>
#include <kungfu/wingchun/book/accounting.h>
#include <math.h>
#include <mutex>

using namespace kungfu::longfist::enums;
using namespace kungfu::longfist::types;
using namespace kungfu::wingchun;
using namespace kungfu::yijinjing;
using namespace kungfu::yijinjing::data;

namespace kungfu::wingchun::book {

struct stock_instrument_attribute {
  int32_t contract_multiplier;
  double margin_ratio;
  double conversion_rate; // For collateral/avail_margin calculation
  double exchange_rate;   // 汇率
};

class StockAccountingMethod : public AccountingMethod {
public:
  StockAccountingMethod() = default;

  virtual void apply_quote(Book_ptr &book, const Quote &quote) override {
    auto apply = [&](Position &position) {
      if (not is_valid_price(quote.last_price) or not position.volume) {
        return;
      }

      if (not position.last_price) {
        position.last_price = quote.last_price;
      }
      double price_change = quote.last_price - position.last_price;
      position.last_price = quote.last_price;

      auto stock_i_a = get_stock_instrument_attribute(book, position.source_id, position.direction,
                                                      position.exchange_id, position.instrument_id);
      double market_value_change = price_change * stock_i_a.exchange_rate * position.volume;

      if (position.direction == Direction::Long) {
        book->asset.market_value += market_value_change; // Asset.market_value means Long positions only.
        book->asset.unrealized_pnl += market_value_change;
        book->asset.total_asset += market_value_change;
      } else {
        double short_margin_change = (quote.last_price < position.avg_open_price)
                                         ? stock_i_a.margin_ratio * market_value_change
                                         : market_value_change;
        position.margin += short_margin_change;

        book->asset.short_margin += short_margin_change;
        book->asset.short_market_value += market_value_change;
        book->asset.margin += short_margin_change;

        double avail_margin_change = (price_change && position.direction == Direction::Short)
                                         ? (-stock_i_a.conversion_rate * market_value_change - short_margin_change)
                                         : 0;
        book->asset.avail_margin += avail_margin_change;
        book->asset.unrealized_pnl -= market_value_change;
      }

      update_position(book, position);
    };

    book->apply_long_position_for(quote, apply);
    book->apply_short_position_for(quote, apply);
  }

  void apply_order_input(uint32_t account_id, uint32_t dest, Book_ptr &book, const OrderInput &input) override {
    if (dest == location::SYNC or dest == location::PUBLIC) {
      return;
    }

    auto apply = [&](auto &position) {
      auto stock_i_a = get_stock_instrument_attribute(book, position.source_id, position.direction,
                                                      position.exchange_id, position.instrument_id);
      double frozen_fee = 0;

      if (input.side == Side::Sell || input.side == Side::GuaranteeStockSell || input.side == Side::RepayMargin ||
          input.side == Side::StockRepayStock) { // Offset: Close
        position.frozen_total += input.volume;
        position.frozen_yesterday += input.volume;
      } else if (input.side == Side::Buy || input.side == Side::GuaranteeStockBuy ||
                 input.side == Side::RepayStock) { // Offset: Open
        double frozen_cash = input.volume * input.frozen_price * stock_i_a.exchange_rate * stock_i_a.margin_ratio;
        book->asset.frozen_cash += frozen_cash;
        book->asset.avail -= frozen_cash;
      } else if (input.side == Side::CashRepayMargin) {
        book->asset.avail -= input.limit_price;
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
      auto &asset = book->asset;
      if (order.side == Side::Buy || order.side == Side::GuaranteeStockBuy || order.side == Side::RepayStock) {
        auto frozen = book->get_frozen_price(order.order_id) * order.volume_left * stock_i_a.exchange_rate *
                      stock_i_a.margin_ratio;
        book->asset.frozen_cash -= frozen;
        book->asset.avail += frozen;
      } else if (order.side == Side::Sell || order.side == Side::GuaranteeStockSell ||
                 order.side == Side::RepayMargin) {
        position.frozen_total = std::max(position.frozen_total - order.volume_left, VOLUME_ZERO);
        position.frozen_yesterday = std::max(position.frozen_yesterday - order.volume_left, VOLUME_ZERO);
      } else if (order.side == Side::StockRepayStock) {
        if (order.status != OrderStatus::PendingSettlement) {
          position.frozen_total = std::max(position.frozen_total - order.volume_left, VOLUME_ZERO);
          position.frozen_yesterday = std::max(position.frozen_yesterday - order.volume_left, VOLUME_ZERO);
        }
      }
      // it assumes position.volume is changed already(apply_trade), otherwise position.volume would be inconsistant.
      update_position(book, position);
    };

    book->apply_position_for(account_id, order, apply);
  }

  virtual void apply_trade(uint32_t account_id, uint32_t dest, Book_ptr &book, const Trade &trade) override {
    if (not guard_trade_accounting(account_id, dest, book, trade)) {
      return;
    }

    auto is_local = dest != location::PUBLIC and dest != location::SYNC;

    auto apply = [&](auto &position) {
      if (trade.side == Side::Sell || trade.side == Side::GuaranteeStockSell) {
        apply_sell(book, position, trade, is_local);
      } else if (trade.side == Side::Buy || trade.side == Side::GuaranteeStockBuy) {
        apply_buy(book, position, trade, is_local);
      }

      if (trade.side == Side::MarginTrade) {
        apply_margintrade(book, position, trade);
      } else if (trade.side == Side::ShortSell) {
        apply_shortsell(book, position, trade);
      } else if (trade.side == Side::RepayMargin) {
        apply_repaymargin(book, position, trade);
      } else if (trade.side == Side::RepayStock) {
        apply_repaystock(book, position, trade, is_local);
      }

      if (trade.side == Side::Purchase || trade.side == Side::Redemption) {
        apply_purchase_redemption(book, position, trade);
      }
    };

    book->apply_position_for(account_id, trade, apply);
  }

  virtual void update_position(Book_ptr &book, Position &position) override {
    if (position.last_price <= 0) {
      return;
    }
    double price_change = position.last_price - position.avg_open_price;
    position.unrealized_pnl = (position.direction == Direction::Long ? price_change : -price_change) * position.volume;
  }

  bool update_asset(const map::InstrumentMap &instruments, const map::InstrumentFactorMap &instrument_factors,
                    Asset &asset, const Position &position) override {
    auto stock_i_a = get_stock_instrument_attribute(instruments, instrument_factors, position.source_id,
                                                    position.direction, position.exchange_id, position.instrument_id);

    auto exchange_rate = stock_i_a.exchange_rate;
    auto contract_multiplier = stock_i_a.contract_multiplier;
    auto position_market_value = position.volume *
                                 (position.last_price > 0 ? position.last_price : position.avg_open_price) *
                                 exchange_rate * contract_multiplier;

    if (position.direction == Direction::Long) {
      asset.market_value += position_market_value;
      asset.long_market_value += position_market_value;
    } else {
      asset.short_market_value += position_market_value;
    }

    asset.unrealized_pnl += position.unrealized_pnl * exchange_rate;
    asset.dynamic_equity += position_market_value;
    return true;
  }

protected:
  virtual void apply_sell(Book_ptr &book, Position &position, const Trade &trade, bool is_local) {
    auto stock_i_a = get_stock_instrument_attribute(book, position.source_id, position.direction, position.exchange_id,
                                                    position.instrument_id);
    double commission = calculate_commission(trade);
    double tax = calculate_tax(trade);

    if (is_local) {
      position.frozen_total = std::max(position.frozen_total - trade.volume, VOLUME_ZERO);
      position.frozen_yesterday = std::max(position.frozen_yesterday - trade.volume, VOLUME_ZERO);
    }

    position.yesterday_volume = position.yesterday_volume - trade.volume;
    position.volume = position.volume - trade.volume;
    double realized_pnl = (trade.price - position.avg_open_price) * trade.volume;
    position.realized_pnl += realized_pnl;
    update_position(book, position);

    auto &asset = book->asset;
    double trade_amt = trade.price * stock_i_a.exchange_rate * trade.volume;
    double repay_cash_debt = std::min(position.margin, (trade_amt * stock_i_a.margin_ratio - (commission + tax)));
    double cash_delivery = trade_amt * stock_i_a.margin_ratio - repay_cash_debt - (commission + tax);
    asset.realized_pnl += realized_pnl * stock_i_a.exchange_rate;
    asset.avail += cash_delivery;
    asset.intraday_fee += commission + tax;
    asset.accumulated_fee += commission + tax;
  }

  virtual void apply_buy(Book_ptr &book, longfist::types::Position &position, const Trade &trade, bool is_local) {
    auto stock_i_a = get_stock_instrument_attribute(book, position.source_id, position.direction, position.exchange_id,
                                                    position.instrument_id);
    double trade_amt = trade.price * trade.volume * stock_i_a.exchange_rate;
    double commission = calculate_commission(trade);
    double tax = calculate_tax(trade);
    position.last_price = position.last_price > 0 ? position.last_price : trade.price;
    if (position.volume + trade.volume > 0 && trade.price > 0) {
      position.avg_open_price = (position.avg_open_price * position.volume + trade_amt / stock_i_a.exchange_rate) /
                                (double)(position.volume + trade.volume);
      position.position_cost_price =
          (position.position_cost_price * position.volume + trade_amt / stock_i_a.exchange_rate + commission + tax) /
          (double)(position.volume + trade.volume);
    }
    position.volume += trade.volume;
    position.open_volume += trade.volume;
    update_position(book, position);

    auto &asset = book->asset;

    if (is_local) {
      double frozen_cash_to_release =
          book->get_frozen_price(trade.order_id) * stock_i_a.exchange_rate * trade.volume * stock_i_a.margin_ratio;
      asset.frozen_cash -= frozen_cash_to_release;
      double avail_cash_change = frozen_cash_to_release - trade_amt * stock_i_a.margin_ratio - (commission + tax);
      asset.avail += avail_cash_change;
    }

    asset.intraday_fee += commission + tax;
    asset.accumulated_fee += commission + tax;
  }

  virtual void apply_purchase_redemption(Book_ptr &book, longfist::types::Position &position, const Trade &trade) {
    auto stock_i_a = get_stock_instrument_attribute(book, position.source_id, position.direction, position.exchange_id,
                                                    position.instrument_id);
    // During the purchase, the ETF fund is open and the constituent stocks are close.
    // During the redemption, the ETF fund is close and the constituent stocks are open.
    if (trade.offset == Offset::Open) {
      position.volume += trade.volume;
    } else {
      position.volume -= trade.volume;
    }
    update_position(book, position);
  }

  virtual void apply_margintrade(Book_ptr &book, longfist::types::Position &position, const Trade &trade) {
    auto stock_i_a = get_stock_instrument_attribute(book, position.source_id, position.direction, position.exchange_id,
                                                    position.instrument_id);

    double trade_amt = trade.price /** stock_i_a.exchange_rate*/ * trade.volume;
    double original_volume = position.volume;
    if (position.volume + trade.volume > 0 && trade.price > 0) {
      position.avg_open_price =
          (position.avg_open_price * original_volume + trade_amt) / (double)(original_volume + trade.volume);
    }

    position.volume += trade.volume;
    update_position(book, position);
  }

  virtual void apply_shortsell(Book_ptr &book, longfist::types::Position &position, const Trade &trade) {
    auto stock_i_a = get_stock_instrument_attribute(book, position.source_id, position.direction, position.exchange_id,
                                                    position.instrument_id);
    double trade_amt = trade.price * trade.volume /** stock_i_a.exchange_rate*/;
    if (position.volume + trade.volume > 0 && trade.price > 0) {
      position.avg_open_price =
          (position.volume + trade.volume == 0)
              ? 0
              : (position.avg_open_price * position.volume + trade_amt / stock_i_a.exchange_rate) /
                    (double)(position.volume + trade.volume);
    }
    position.volume += trade.volume;
    update_position(book, position);
  }

  virtual void apply_repaymargin(Book_ptr &book, longfist::types::Position &position, const Trade &trade) {
    auto stock_i_a = get_stock_instrument_attribute(book, position.source_id, position.direction, position.exchange_id,
                                                    position.instrument_id);
    position.frozen_total = std::max(position.frozen_total - trade.volume, VOLUME_ZERO);
    position.frozen_yesterday = std::max(position.frozen_yesterday - trade.volume, VOLUME_ZERO);
    position.yesterday_volume = position.yesterday_volume - trade.volume;
    position.volume = position.volume - trade.volume;
    update_position(book, position);
  }

  virtual void apply_repaystock(Book_ptr &book, longfist::types::Position &position, const Trade &trade,
                                bool is_local) {
    auto stock_i_a = get_stock_instrument_attribute(book, position.source_id, position.direction, position.exchange_id,
                                                    position.instrument_id);
    double commission = calculate_commission(trade);
    auto tax = calculate_tax(trade);
    double trade_amt = trade.price * trade.volume * stock_i_a.exchange_rate;
    position.yesterday_volume = std::max(position.yesterday_volume - trade.volume, VOLUME_ZERO);
    position.volume = position.volume - trade.volume;
    update_position(book, position);

    auto &asset = book->asset;

    if (is_local) {
      double frozen_cash_to_release =
          book->get_frozen_price(trade.order_id) * stock_i_a.exchange_rate * trade.volume * stock_i_a.margin_ratio;
      asset.frozen_cash -= frozen_cash_to_release;
      double avail_cash_change = frozen_cash_to_release - trade_amt * stock_i_a.margin_ratio - (commission + tax);
      asset.avail += avail_cash_change;
    }
    asset.intraday_fee += commission + tax;
    asset.accumulated_fee += commission + tax;
  }

  virtual double calculate_commission(const Trade &trade) { return trade.commission; }

  virtual double calculate_tax(const Trade &trade) { return trade.tax; }

  static stock_instrument_attribute get_stock_instrument_attribute(Book_ptr &book, uint32_t account_id,
                                                                   longfist::enums::Direction direction,
                                                                   const char *exchange_id, const char *instrument_id) {
    return get_stock_instrument_attribute(book->instruments, book->instrument_factors, account_id, direction,
                                          exchange_id, instrument_id);
  }

  static stock_instrument_attribute get_stock_instrument_attribute(const map::InstrumentMap &instruments,
                                                                   const map::InstrumentFactorMap &instrument_factors,
                                                                   uint32_t account_id,
                                                                   longfist::enums::Direction direction,
                                                                   const char *exchange_id, const char *instrument_id) {

    uint32_t hashed_instrument_key = hash_instrument(exchange_id, instrument_id);
    stock_instrument_attribute stock_i_a = {};

    if (instruments.find(hashed_instrument_key) == instruments.end()) {
      stock_i_a.contract_multiplier = DEFAULT_INSTRUMENT_CONTRACT_MULTIPLIER;
    } else {
      const auto &instrument = instruments.at(hashed_instrument_key);
      stock_i_a.contract_multiplier =
          instrument.contract_multiplier == 0 ? DEFAULT_INSTRUMENT_CONTRACT_MULTIPLIER : instrument.contract_multiplier;
    }

    auto hashed_instrument_factor_key = hash_instrument(exchange_id, instrument_id);
    if (instrument_factors.find(hashed_instrument_factor_key) == instrument_factors.end()) {
      stock_i_a.margin_ratio =
          direction == Direction::Long ? DEFAULT_STOCK_LONG_MARGIN_RATIO : DEFAULT_STOCK_SHORT_MARGIN_RATIO;
      stock_i_a.conversion_rate = DEFAULT_STOCK_CONVERSION_RATE;
      stock_i_a.exchange_rate = DEFAULT_INSTRUMENT_EXCHANGE_RATE;
    } else {
      auto &factor = instrument_factors.at(hashed_instrument_factor_key);
      stock_i_a.margin_ratio = margin_ratio(factor, direction);
      stock_i_a.conversion_rate =
          is_equal(factor.conversion_rate, 0.0) ? DEFAULT_STOCK_CONVERSION_RATE : factor.conversion_rate;
      stock_i_a.exchange_rate =
          is_equal(factor.exchange_rate, 0.0) ? DEFAULT_INSTRUMENT_EXCHANGE_RATE : factor.exchange_rate;
    }

    return stock_i_a;
  }

  static double margin_ratio(const InstrumentFactor &factor, Direction direction) {
    auto long_margin_ratio =
        is_equal(factor.long_margin_ratio, 0.0) ? DEFAULT_STOCK_LONG_MARGIN_RATIO : factor.long_margin_ratio;
    auto short_margin_ratio =
        is_equal(factor.short_margin_ratio, 0.0) ? DEFAULT_STOCK_SHORT_MARGIN_RATIO : factor.short_margin_ratio;
    return direction == Direction::Long ? long_margin_ratio : short_margin_ratio;
  }
};
} // namespace kungfu::wingchun::book
#endif // WINGCHUN_ACCOUNTING_STOCK_H
