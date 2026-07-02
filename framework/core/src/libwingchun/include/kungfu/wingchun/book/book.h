// SPDX-License-Identifier: Apache-2.0

//
// Created by qlu on 2019-10-14.
//

#ifndef WINGCHUN_BOOK_H
#define WINGCHUN_BOOK_H

#include <kungfu/longfist/longfist.h>
#include <kungfu/wingchun/book/staticdata.h>
#include <kungfu/wingchun/common.h>

namespace kungfu::wingchun::book {

static constexpr int DEFAULT_INSTRUMENT_CONTRACT_MULTIPLIER = 1;
static constexpr double DEFAULT_INSTRUMENT_EXCHANGE_RATE = 1.0;
static constexpr double DEFAULT_FUTURE_LONG_MARGIN_RATIO = 1.0;
static constexpr double DEFAULT_FUTURE_SHORT_MARGIN_RATIO = 1.0;
static constexpr double DEFAULT_STOCK_LONG_MARGIN_RATIO = 1.0;
static constexpr double DEFAULT_STOCK_SHORT_MARGIN_RATIO = 0.6;
static constexpr double DEFAULT_STOCK_CONVERSION_RATE = 0.7;

FORWARD_DECLARE_STRUCT_PTR(Book)
FORWARD_DECLARE_CLASS_PTR(Bookkeeper)
FORWARD_DECLARE_CLASS_PTR(AccountingMethod)

typedef std::unordered_map<longfist::enums::InstrumentType, AccountingMethod_ptr> AccountingMethodMap;

struct Book {
  const map::CommissionMap &commissions;
  const map::InstrumentMap &instruments;
  const map::InstrumentFactorMap &instrument_factors;
  const AccountingMethodMap &accounting_methods;
  longfist::types::Asset asset = {};
  map::PositionMap long_positions = {};
  map::PositionMap short_positions = {};
  std::unordered_set<uint32_t> source_ids = {};
  map::OrderInputMap order_inputs = {};
  map::OrderMap orders = {};
  map::TradeMap trades = {};
  map::AlgoOrderInputMap algo_order_inputs = {};
  map::AlgoOrderMap algo_orders = {};
  yijinjing::data::location_ptr home;

  Book(const map::CommissionMap &commissions_ref, const map::InstrumentMap &instruments_ref,
       const map::InstrumentFactorMap &instrument_factors_ref, const AccountingMethodMap &accounting_methods_ref,
       yijinjing::data::location_ptr &home_location);

  double get_frozen_price(uint64_t order_id);

  void add_source_id(uint32_t source_id);

  void ensure_position_for(const longfist::types::InstrumentKey &instrument_key);

  template <typename ApplyMethod>
  void apply_position(uint32_t source_id, longfist::enums::Direction direction, const char *exchange_id,
                      const char *instrument_id, ApplyMethod method) {
    auto &position = get_position(source_id, direction, exchange_id, instrument_id);
    method(position);
  }

  template <typename ApplyMethod>
  void apply_position_pure(uint32_t source_id, longfist::enums::Direction direction, const char *exchange_id,
                           const char *instrument_id, ApplyMethod method) {
    map::PositionMap &positions = direction == longfist::enums::Direction::Long ? long_positions : short_positions;
    auto position_id = hash_instrument(source_id, exchange_id, instrument_id);
    if (positions.find(position_id) != positions.end()) {
      method(positions.at(position_id));
    }
  }

  template <typename ApplyMethod>
  void apply_opposite_position(uint32_t source_id, longfist::enums::Direction direction, const char *exchange_id,
                               const char *instrument_id, ApplyMethod method) {

    auto direction_opposite = direction == longfist::enums::Direction::Long ? longfist::enums::Direction::Short
                                                                            : longfist::enums::Direction::Long;
    auto &position = get_position(source_id, direction_opposite, exchange_id, instrument_id);
    method(position);
  }

  template <typename ApplyMethod>
  void apply_opposite_position_pure(uint32_t source_id, longfist::enums::Direction direction, const char *exchange_id,
                                    const char *instrument_id, ApplyMethod method) {

    map::PositionMap &positions = direction == longfist::enums::Direction::Long ? short_positions : long_positions;
    auto position_id = hash_instrument(source_id, exchange_id, instrument_id);
    if (positions.find(position_id) != positions.end()) {
      method(positions.at(position_id));
    }
  }

  template <typename TradingData, typename ApplyMethod>
  std::enable_if_t<std::is_same_v<TradingData, longfist::types::Quote>> apply_long_position_for(const TradingData &data,
                                                                                                ApplyMethod method) {
    for (const auto &source_id : source_ids) {
      apply_position_pure(source_id, longfist::enums::Direction::Long, data.exchange_id, data.instrument_id, method);
    }
  }

  template <typename TradingData, typename ApplyMethod>
  std::enable_if_t<not std::is_same_v<TradingData, longfist::types::Quote>>
  apply_long_position_for(const TradingData &data, ApplyMethod method) {
    for (const auto &source_id : source_ids) {
      apply_position(source_id, longfist::enums::Direction::Long, data.exchange_id, data.instrument_id, method);
    }
  }

  template <typename ApplyMethod> void apply_long_positions(ApplyMethod method) {
    for (auto &iter : long_positions) {
      auto &position = iter.second;
      method(position);
    }
  }

  template <typename TradingData, typename ApplyMethod>
  std::enable_if_t<std::is_same_v<TradingData, longfist::types::Quote>>
  apply_short_position_for(const TradingData &data, ApplyMethod method) {
    for (const auto &source_id : source_ids) {
      apply_position_pure(source_id, longfist::enums::Direction::Short, data.exchange_id, data.instrument_id, method);
    }
  }

  template <typename TradingData, typename ApplyMethod>
  std::enable_if_t<not std::is_same_v<TradingData, longfist::types::Quote>>
  apply_short_position_for(const TradingData &data, ApplyMethod method) {
    for (const auto &source_id : source_ids) {
      apply_position(source_id, longfist::enums::Direction::Short, data.exchange_id, data.instrument_id, method);
    }
  }

  template <typename ApplyMethod> void apply_short_positions(ApplyMethod method) {
    for (auto &iter : short_positions) {
      auto &position = iter.second;
      method(position);
    }
  }

  template <typename TradingData, typename ApplyMethod>
  void apply_position_for(longfist::enums::Direction direction, const TradingData &data, ApplyMethod method) {
    for (const auto &source_id : source_ids) {
      apply_position(source_id, direction, data.exchange_id, data.instrument_id, method);
    }
  }

  template <typename TradingData, typename ApplyMethod>
  void apply_position_for(const TradingData &data, ApplyMethod method) {
    auto direction = get_direction(data.instrument_type, data.side, data.offset);
    for (const auto &source_id : source_ids) {
      apply_position(source_id, direction, data.exchange_id, data.instrument_id, method);
    }
  }

  template <typename TradingData, typename ApplyMethod>
  void apply_position_for(uint32_t source_id, const TradingData &data, ApplyMethod method) {
    auto direction = get_direction(data.instrument_type, data.side, data.offset);
    apply_position(source_id, direction, data.exchange_id, data.instrument_id, method);
  }

  template <typename TradingData, typename ApplyMethod>
  void apply_opposite_position_for(longfist::enums::Direction direction, const TradingData &data, ApplyMethod method) {
    for (const auto &source_id : source_ids) {
      apply_opposite_position(source_id, direction, data.exchange_id, data.instrument_id, method);
    }
  }

  template <typename TradingData, typename ApplyMethod>
  void apply_opposite_position_for(const TradingData &data, ApplyMethod method) {
    auto direction = get_direction(data.instrument_type, data.side, data.offset);
    for (const auto &source_id : source_ids) {
      apply_opposite_position(source_id, direction, data.exchange_id, data.instrument_id, method);
    }
  }

  template <typename TradingData, typename ApplyMethod>
  void apply_opposite_position_for(uint32_t source_id, const TradingData &data, ApplyMethod method) {
    auto direction = get_direction(data.instrument_type, data.side, data.offset);
    apply_opposite_position(source_id, direction, data.exchange_id, data.instrument_id, method);
  }

  [[nodiscard]] bool has_long_position(uint32_t source_id, const char *exchange_id, const char *instrument_id) const;

  [[nodiscard]] bool has_long_position(const std::string &source, const std::string &account, const char *exchange_id,
                                       const char *instrument_id) const;

  [[nodiscard]] bool has_short_position(uint32_t source_id, const char *exchange_id, const char *instrument_id) const;

  [[nodiscard]] bool has_short_position(const std::string &source, const std::string &account, const char *exchange_id,
                                        const char *instrument_id) const;

  [[nodiscard]] bool has_position_for(uint32_t source_id, const char *exchange_id, const char *instrument_id) const;

  [[nodiscard]] bool has_position_for(const longfist::types::Position &position) const;

  template <typename TradingData> [[nodiscard]] bool has_long_position_for(const TradingData &data) const {
    auto result = false;
    for (const auto &source_id : source_ids) {
      result |= has_position(source_id, longfist::enums::Direction::Long, data.exchange_id, data.instrument_id);
    }
    return result;
  }

  template <typename TradingData> [[nodiscard]] bool has_short_position_for(const TradingData &data) const {
    auto result = false;
    for (const auto &source_id : source_ids) {
      result |= has_position(source_id, longfist::enums::Direction::Short, data.exchange_id, data.instrument_id);
    }
    return result;
  }

  [[nodiscard]] bool has_position(uint32_t source_id, longfist::enums::Direction direction, const char *exchange_id,
                                  const char *instrument_id) const;

  [[nodiscard]] longfist::types::Position &get_long_position(uint32_t source_id, const char *exchange_id,
                                                             const char *instrument_id);

  [[nodiscard]] longfist::types::Position &get_long_position(const std::string &source, const std::string &account,
                                                             const char *exchange_id, const char *instrument_id);

  [[nodiscard]] longfist::types::Position &get_short_position(uint32_t source_id, const char *exchange_id,
                                                              const char *instrument_id);

  [[nodiscard]] longfist::types::Position &get_short_position(const std::string &source, const std::string &account,
                                                              const char *exchange_id, const char *instrument_id);

  [[nodiscard]] longfist::types::Position &get_position(uint32_t source_id, longfist::enums::Direction direction,
                                                        const char *exchange_id, const char *instrument_id);

  [[nodiscard]] longfist::types::Position &get_position_for(const longfist::types::Position &position);

  template <typename TradingData>
  [[nodiscard]] longfist::types::Position &get_position_for(uint32_t source_id, const TradingData &data) {
    auto direction = get_direction(data.instrument_type, data.side, data.offset);
    return get_position(source_id, direction, data.exchange_id, data.instrument_id);
  }

  template <typename TradingData>
  [[nodiscard]] longfist::types::Position &get_opposite_position_for(uint32_t source_id, const TradingData &data) {
    auto direction = get_opposite_direction(data.instrument_type, data.side, data.offset);
    return get_position(source_id, direction, data.exchange_id, data.instrument_id);
  }

  void update(int64_t update_time);

  void replace(const longfist::types::OrderInput &input);

  void replace(const longfist::types::Order &order);

  void replace(const longfist::types::Trade &trade);

  void replace(const longfist::types::AlgoOrderInput &input);

  void replace(const longfist::types::AlgoOrder &order);

  void mirror_position_from(const Book &book);

  [[nodiscard]] const map::InstrumentMap &get_instruments() const { return instruments; }

  [[nodiscard]] const map::InstrumentFactorMap &get_instrument_factors() const { return instrument_factors; }

  [[nodiscard]] const map::CommissionMap &get_commissions() const { return commissions; }

  Book &operator=(const Book &book) { return *this; }
};
} // namespace kungfu::wingchun::book

#endif // WINGCHUN_BOOK_H
