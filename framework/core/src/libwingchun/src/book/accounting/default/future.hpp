// SPDX-License-Identifier: Apache-2.0

//
// Created by Keren Dong on 2020/4/6.
//

#ifndef WINGCHUN_ACCOUNTING_FUTURE_H
#define WINGCHUN_ACCOUNTING_FUTURE_H

#include <kungfu/wingchun/book/accounting.h>

using namespace kungfu::longfist::enums;
using namespace kungfu::longfist::types;
using namespace kungfu::wingchun;
using namespace kungfu::yijinjing;
using namespace kungfu::yijinjing::data;

namespace kungfu::wingchun::book {

struct future_instrument_attribute {
  int32_t contract_multiplier;
  double margin_ratio;
  double exchange_rate;
};

class FutureAccountingMethod : public AccountingMethod {
public:
  FutureAccountingMethod() = default;

  void apply_quote(Book_ptr &book, const Quote &quote) override {
    auto apply = [&](Position &position) {
      if (position.volume <= 0) { // only calculate when greater than 0
        return;
      }

      auto future_i_a = get_future_instrument_attribute(book, position.source_id, position.direction,
                                                        position.exchange_id, position.instrument_id);

      // 此处仅计算结算价，但需要根据实时行情变化
      if (is_valid_price(quote.settlement_price)) {
        auto margin_pre = position.margin;
        position.settlement_price = quote.settlement_price;
        position.margin = future_i_a.contract_multiplier * position.settlement_price * future_i_a.exchange_rate *
                          position.volume * future_i_a.margin_ratio;
        book->asset.avail -= (position.direction == Direction::Long ? 1 : -1) * (position.margin - margin_pre);
      }

      if (is_valid_price(quote.last_price)) {
        if (is_valid_price(position.last_price)) {
          double price_change = quote.last_price - position.last_price;
          position.last_price = quote.last_price;
          double market_value_change = (position.direction == Direction::Long ? 1 : -1) * price_change *
                                       future_i_a.exchange_rate * position.volume * future_i_a.contract_multiplier;
          book->asset.market_value += market_value_change;
        }

        position.last_price = quote.last_price;
      }

      if (is_valid_price(quote.pre_settlement_price)) {
        position.pre_settlement_price = quote.pre_settlement_price;
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
        position.frozen_total += input.volume; // 平仓数量超过持仓数量时, 委托被柜台拒绝后会再扣回来
      }

      if (offset == Offset::Close or offset == Offset::CloseYesterday) {
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

    auto future_i_a = get_future_instrument_attribute(book, position.source_id, position.direction,
                                                      position.exchange_id, position.instrument_id);
    auto multiplier = future_i_a.contract_multiplier * (position.direction == Direction::Long ? 1 : -1);
    // 昨仓部分, 最新价 - 昨结算价
    auto price_diff_yesterday = position.last_price - position.pre_settlement_price; // 最新价 - 昨结算 表示今日的盈亏
    auto unrealized_pnl_yesterday = (price_diff_yesterday * position.yesterday_volume) * multiplier; // 昨仓部分的盈亏

    // 今仓部分, 最新价 - 今持仓平均价
    // 平仓时计算realized_pnl_today存在误差, 这里计算计算unrealized_pnl_today也存在误差,
    // 但是总值realized_pnl_today + unrealized_pnl_today 是正确的
    auto price_diff_today = position.last_price - position.avg_open_price_today; // 最新价 - 今仓均价, 今仓的差价,
    auto unrealized_pnl_today =
        (price_diff_today * (position.volume - position.yesterday_volume)) * multiplier; // 今仓的盈亏

    // 浮动盈亏
    position.unrealized_pnl = unrealized_pnl_yesterday + unrealized_pnl_today; // ctp盈亏不计算手续费
  }

  bool update_asset(const map::InstrumentMap &instruments, const map::InstrumentFactorMap &instrument_factors,
                    Asset &asset, const Position &position) override {
    auto future_i_a = get_future_instrument_attribute(instruments, instrument_factors, position.source_id,
                                                      position.direction, position.exchange_id, position.instrument_id);

    auto exchange_rate = future_i_a.exchange_rate;
    auto contract_multiplier = future_i_a.contract_multiplier;
    auto position_market_value = position.volume *
                                 (position.last_price > 0 ? position.last_price : position.avg_open_price) *
                                 exchange_rate * contract_multiplier;

    if (position.direction == Direction::Long) {
      asset.long_market_value += position_market_value;
    } else {
      asset.short_market_value += position_market_value;
    }

    asset.unrealized_pnl += position.unrealized_pnl * exchange_rate;
    asset.market_value += position_market_value;
    // 动态权益 = 初始资金 + 持仓盈亏 + 已实现盈亏 - 手续费
    // 已实现盈亏已经加在了asset.avail里, Position没有记录手续费, 交易过程中已经统一在avail扣掉了
    // 初始资金拆成了 可用资金 和 持仓占用保证金, 最终公式为
    // 动态权益 = asset.avail + position.margin + position.unrealized_pnl
    // 在外部调用该update_asset函数前, 已经将dynamic_equity设置成了avail, 故只需要统计margin和unrealized_pnl
    asset.dynamic_equity += (position.margin + position.unrealized_pnl) * exchange_rate;
    return true;
  }

public:
  void apply_open(Book_ptr &book, Position &position, const Trade &trade, bool is_local) {
    auto future_i_a = get_future_instrument_attribute(book, position.source_id, position.direction, trade.exchange_id,
                                                      trade.instrument_id);
    auto contract_multiplier = future_i_a.contract_multiplier;
    auto margin_ratio_by_pos = future_i_a.margin_ratio;
    auto margin = contract_multiplier * trade.price * future_i_a.exchange_rate * trade.volume * margin_ratio_by_pos;
    position.margin += margin;
    if (position.volume + trade.volume > 0 && trade.price > 0) { // only calculate when greater than 0
      position.avg_open_price = (position.avg_open_price * position.volume + trade.price * trade.volume) /
                                double(position.volume + trade.volume);
      auto today_volume = std::max<int64_t>(position.volume - position.yesterday_volume, 0); // 今仓数量
      position.avg_open_price_today = (position.avg_open_price_today * today_volume + trade.price * trade.volume) /
                                      (double(today_volume + trade.volume)); // 今开均价
    }
    position.volume += trade.volume;
    position.open_volume += trade.volume;
    position.last_price = position.last_price > 0 ? position.last_price : trade.price;
    update_position(book, position);

    if (is_local) {
      auto frozen_margin = contract_multiplier * book->get_frozen_price(trade.order_id) * future_i_a.exchange_rate *
                           trade.volume * margin_ratio_by_pos;
      book->asset.avail += frozen_margin;
      book->asset.frozen_cash -= frozen_margin;
      book->asset.frozen_margin -= frozen_margin;
    }

    auto commission = calculate_commission(book, trade, position, 0) * future_i_a.exchange_rate;
    book->asset.avail -= commission;
    book->asset.avail -= margin;
    book->asset.accumulated_fee += commission;
    book->asset.intraday_fee += commission;
    book->asset.margin += margin;
  }

  virtual void apply_close(Book_ptr &book, Position &position, const Trade &trade, bool is_local) {
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
      if (trade.offset != Offset::CloseToday) {
        position.frozen_yesterday = std::max(position.frozen_yesterday - trade.volume, VOLUME_ZERO);
      }
    }

    auto close_today_volume = 0.0;
    if (trade.offset != Offset::CloseToday) {
      close_today_volume = std::max(trade.volume - position.yesterday_volume, VOLUME_ZERO);
      position.yesterday_volume = std::max(position.yesterday_volume - trade.volume, VOLUME_ZERO);
    } else {
      close_today_volume = trade.volume;
    }

    // 昨仓部分, 平仓价 - 昨结算 表示今日的平仓盈亏
    auto realized_pnl_yesterday =
        (trade.price - position.pre_settlement_price) * (trade.volume - close_today_volume) * contract_multiplier;

    // 平今仓的时候, 计算盈利会根据先进先出的方式进行平仓, 最后根据剩下的未平的部分再计算今开仓均价,
    // 由于我们无法获取到今仓的每一笔成交的开仓价格和顺序, 只能使用今仓均价来计算盈亏, 存在一定误差
    // 今仓部分, 平仓价 - 今仓均价, 存在误差
    auto realized_pnl_today = (trade.price - position.avg_open_price_today) * close_today_volume * contract_multiplier;
    auto realized_pnl = realized_pnl_yesterday + realized_pnl_today;

    if (position.direction == Direction::Short) {
      realized_pnl = -realized_pnl;
    }
    position.realized_pnl += realized_pnl;
    update_position(book, position);

    auto commission = calculate_commission(book, trade, position, close_today_volume) * future_i_a.exchange_rate;
    book->asset.realized_pnl += realized_pnl * future_i_a.exchange_rate;
    book->asset.avail += delta_margin;
    book->asset.avail -= commission;
    book->asset.accumulated_fee += commission;
    book->asset.intraday_fee += commission;
    // add asset_margin realtime calc, refer to Book::update(int64_t, AccountingMethodType)
    book->asset.margin -= margin;
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
    auto future_i_a = get_future_instrument_attribute(book, position.source_id, position.direction, trade.exchange_id,
                                                      trade.instrument_id);

    auto contract_multiplier = future_i_a.contract_multiplier;
    uint32_t product_key = hash_product(trade.exchange_id, get_instrument_product(trade.instrument_id).c_str());
    if (book->commissions.find(product_key) == book->commissions.end()) {
      SPDLOG_WARN("commission information missing for {}@{}", trade.instrument_id, trade.exchange_id);
      return 0;
    }
    const auto &commission = book->commissions.at(product_key);
    if (commission.mode == CommissionRateMode::ByAmount) {
      if (trade.offset == Offset::Open) {
        return trade.price * future_i_a.exchange_rate * trade.volume * contract_multiplier * commission.open_ratio;
      } else {
        auto volume_left = double(trade.volume) - close_today_volume;
        return (trade.price * volume_left * contract_multiplier * commission.close_ratio) +
               (trade.price * close_today_volume * contract_multiplier * commission.close_today_ratio);
      }
    } else {
      if (trade.offset == Offset::Open) {
        return double(trade.volume) * commission.open_ratio;
      } else {
        auto volume_left = double(trade.volume - close_today_volume);
        return (volume_left * commission.close_ratio) + (close_today_volume * commission.close_today_ratio);
      }
    }
  }

  static future_instrument_attribute get_future_instrument_attribute(Book_ptr &book, uint32_t account_id,
                                                                     longfist::enums::Direction direction,
                                                                     const char *exchange_id,
                                                                     const char *instrument_id) {
    return get_future_instrument_attribute(book->instruments, book->instrument_factors, account_id, direction,
                                           exchange_id, instrument_id);
  }

  static future_instrument_attribute get_future_instrument_attribute(
      const map::InstrumentMap &instruments, const map::InstrumentFactorMap &instrument_factors, uint32_t account_id,
      longfist::enums::Direction direction, const char *exchange_id, const char *instrument_id) {

    auto hashed_instrument_key = hash_instrument(exchange_id, instrument_id);
    future_instrument_attribute future_i_a = {};
    if (instruments.find(hashed_instrument_key) == instruments.end()) {
      // TODO comment tempoorarly for backtest without commisions
      // SPDLOG_WARN("instrument information missing for {}@{}", instrument_id, exchange_id);
      future_i_a.contract_multiplier = DEFAULT_INSTRUMENT_CONTRACT_MULTIPLIER;
    } else {
      const auto &instrument = instruments.at(hashed_instrument_key);
      future_i_a.contract_multiplier = instrument.contract_multiplier;
    }

    auto hashed_instrument_factor_key = hash_instrument(exchange_id, instrument_id);
    if (instrument_factors.find(hashed_instrument_factor_key) == instrument_factors.end()) {
      future_i_a.exchange_rate = DEFAULT_INSTRUMENT_EXCHANGE_RATE;
      future_i_a.margin_ratio =
          direction == Direction::Long ? DEFAULT_FUTURE_LONG_MARGIN_RATIO : DEFAULT_FUTURE_SHORT_MARGIN_RATIO;
    } else {
      auto &factor = instrument_factors.at(hashed_instrument_factor_key);
      future_i_a.margin_ratio = direction == Direction::Long ? factor.long_margin_ratio : factor.short_margin_ratio;
      future_i_a.exchange_rate = is_equal(factor.exchange_rate, 0.0) ? 1.0 : factor.exchange_rate;
    }
    return future_i_a;
  }

  static bool able_long_short_position_merge(const char *exchange_id) {
    if (strcmp(exchange_id, EXCHANGE_US_FUTURE) == 0 || strcmp(exchange_id, EXCHANGE_HK_FUTURE) == 0 ||
        strcmp(exchange_id, EXCHANGE_SGX_FUTURE) == 0 || strcmp(exchange_id, EXCHANGE_LON_FUTURE) == 0 ||
        strcmp(exchange_id, EXCHANGE_AEX_FUTURE) == 0 || strcmp(exchange_id, EXCHANGE_AUX_FUTURE) == 0 ||
        strcmp(exchange_id, EXCHANGE_HEXS_FUTURE) == 0 || strcmp(exchange_id, EXCHANGE_IDX_FUTURE) == 0 ||
        strcmp(exchange_id, EXCHANGE_KORC) == 0 || strcmp(exchange_id, EXCHANGE_LME) == 0 ||
        strcmp(exchange_id, EXCHANGE_MYS_FUTURE) == 0 || strcmp(exchange_id, EXCHANGE_ABB) == 0 ||
        strcmp(exchange_id, EXCHANGE_PRX_FUTURE) == 0 || strcmp(exchange_id, EXCHANGE_SIX_FUTURE) == 0 ||
        strcmp(exchange_id, EXCHANGE_TAX_FUTURE) == 0 || strcmp(exchange_id, EXCHANGE_JP_FUTURE) == 0 ||
        strcmp(exchange_id, EXCHANGE_TSE_FUTURE) == 0 || strcmp(exchange_id, EXCHANGE_XETRA) == 0 ||
        strcmp(exchange_id, EXCHANGE_EUR_FUTURE) == 0) {
      return true;
    }

    return false;
  }
};
} // namespace kungfu::wingchun::book
#endif // WINGCHUN_ACCOUNTING_FUTURE_H
