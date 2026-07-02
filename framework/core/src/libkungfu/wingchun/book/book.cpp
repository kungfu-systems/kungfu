// SPDX-License-Identifier: Apache-2.0

//
// Created by qlu on 2019-10-14.
//

#include <kungfu/wingchun/book/accounting.h>
#include <kungfu/wingchun/book/book.h>

#include <utility>

using namespace kungfu::rx;
using namespace kungfu::longfist::types;
using namespace kungfu::longfist::enums;
using namespace kungfu::practice;
using namespace kungfu::yijinjing;
using namespace kungfu::yijinjing::data;
using namespace kungfu::wingchun::map;

namespace kungfu::wingchun::book {
Book::Book(const CommissionMap &commissions_ref, const InstrumentMap &instruments_ref,
           const InstrumentFactorMap &instrument_factors_ref, const AccountingMethodMap &accounting_methods_ref,
           yijinjing::data::location_ptr &home_location)
    : commissions(commissions_ref), instruments(instruments_ref), instrument_factors(instrument_factors_ref),
      accounting_methods(accounting_methods_ref), home(home_location) {}

double Book::get_frozen_price(uint64_t order_id) {
  if (order_inputs.find(order_id) != order_inputs.end()) {
    return order_inputs.at(order_id).frozen_price;
  }
  return 0;
}

void Book::add_source_id(uint32_t source_id) { source_ids.insert(source_id); }

void Book::ensure_position_for(const InstrumentKey &instrument_key) {
  auto apply = [&](auto &position) { return; };
  apply_short_position_for(instrument_key, apply);
  apply_long_position_for(instrument_key, apply);
}

bool Book::has_long_position(uint32_t source_id, const char *exchange_id, const char *instrument_id) const {
  auto position_id = hash_instrument(source_id, exchange_id, instrument_id);
  return long_positions.find(position_id) != long_positions.end();
}

bool Book::has_long_position(const std::string &source, const std::string &account, const char *exchange_id,
                             const char *instrument_id) const {
  auto location = location::make_shared(home->mode, category::TD, source, account, home->locator);
  return has_long_position(location->uid, exchange_id, instrument_id);
}

bool Book::has_short_position(uint32_t source_id, const char *exchange_id, const char *instrument_id) const {
  auto position_id = hash_instrument(source_id, exchange_id, instrument_id);
  return short_positions.find(position_id) != short_positions.end();
}

bool Book::has_short_position(const std::string &source, const std::string &account, const char *exchange_id,
                              const char *instrument_id) const {
  auto location = location::make_shared(home->mode, category::TD, source, account, home->locator);
  return has_short_position(location->uid, exchange_id, instrument_id);
}

bool Book::has_position_for(uint32_t source_id, const char *exchange_id, const char *instrument_id) const {
  return has_long_position(source_id, exchange_id, instrument_id) or
         has_short_position(source_id, exchange_id, instrument_id);
}

bool Book::has_position_for(const Position &position) const {
  return has_position(position.source_id, position.direction, position.exchange_id, position.instrument_id);
}

bool Book::has_position(uint32_t source_id, longfist::enums::Direction direction, const char *exchange_id,
                        const char *instrument_id) const {
  const map::PositionMap &positions = direction == Direction::Long ? long_positions : short_positions;
  auto position_id = hash_instrument(source_id, exchange_id, instrument_id);
  if (positions.find(position_id) == positions.end()) {
    return false;
  }

  return true;
}

Position &Book::get_long_position(uint32_t source_id, const char *exchange_id, const char *instrument_id) {
  return get_position(source_id, Direction::Long, exchange_id, instrument_id);
}

Position &Book::get_long_position(const std::string &source, const std::string &account, const char *exchange_id,
                                  const char *instrument_id) {
  auto location = location::make_shared(home->mode, category::TD, source, account, home->locator);
  return get_long_position(location->uid, exchange_id, instrument_id);
}

Position &Book::get_short_position(uint32_t source_id, const char *exchange_id, const char *instrument_id) {
  return get_position(source_id, Direction::Short, exchange_id, instrument_id);
}

Position &Book::get_short_position(const std::string &source, const std::string &account, const char *exchange_id,
                                   const char *instrument_id) {
  auto location = location::make_shared(home->mode, category::TD, source, account, home->locator);
  return get_short_position(location->uid, exchange_id, instrument_id);
}

Position &Book::get_position_for(const longfist::types::Position &position) {
  return get_position(position.source_id, position.direction, position.exchange_id, position.instrument_id);
}

Position &Book::get_position(uint32_t source_id, Direction direction, const char *exchange_id,
                             const char *instrument_id) {
  assert(asset.holder_uid != 0);
  map::PositionMap &positions = direction == Direction::Long ? long_positions : short_positions;
  auto position_id = hash_instrument(source_id, exchange_id, instrument_id);
  auto pair = positions.try_emplace(position_id);
  auto &position = pair.first->second;
  if (pair.second) {
    position.instrument_id = instrument_id;
    position.exchange_id = exchange_id;
    position.instrument_type = get_instrument_type(position.exchange_id, position.instrument_id);
    position.holder_uid = asset.holder_uid;
    position.ledger_category = asset.ledger_category;
    position.direction = direction;
    position.source_id = source_id;
    position.source_op_id = get_source_op_id(asset.holder_uid, source_id);
  }
  add_source_id(source_id);
  return position;
}

void Book::update(int64_t update_time) {

  /* IMPORTANT:
   * remove assign and reassign of asset.margin
   * this function will be called when ledger sync asset and position from TD  every minute
   * margin will recalculate by this function, but margin of asset is not equal to sum of all positions margin,
   * different exchange may have different margin discount
   */

  Asset tmp_asset{};
  tmp_asset.dynamic_equity = asset.avail;
  bool asset_changed = false;

  auto update_position = [&](const Position &position) {
    if (accounting_methods.find(position.instrument_type) == accounting_methods.end()) {
      SPDLOG_WARN("accounting method not found for position {}", position.to_string());
      return;
    }

    AccountingMethod_ptr accounting_method = accounting_methods.at(position.instrument_type);
    asset_changed |= accounting_method->update_asset(instruments, instrument_factors, tmp_asset, position);
  };

  apply_long_positions(update_position);
  apply_short_positions(update_position);

  if (asset_changed) {
    asset.market_value = tmp_asset.market_value;
    asset.long_market_value = tmp_asset.long_market_value;
    asset.short_market_value = tmp_asset.short_market_value;
    asset.unrealized_pnl = tmp_asset.unrealized_pnl;
    asset.dynamic_equity = tmp_asset.dynamic_equity;
    asset.update_time = update_time;
  }
}

void Book::replace(const OrderInput &input) { order_inputs.insert_or_assign(input.order_id, input); }

void Book::replace(const Order &order) { orders.insert_or_assign(order.order_id, order); }

void Book::replace(const Trade &trade) { trades.insert_or_assign(trade.trade_id, trade); }

void Book::replace(const AlgoOrderInput &input) { algo_order_inputs.insert_or_assign(input.order_id, input); }

void Book::replace(const AlgoOrder &order) { algo_orders.insert_or_assign(order.order_id, order); }

void Book::mirror_position_from(const Book &book) {
  auto mirror_position = [&](const PositionMap &source_map) {
    for (auto &source_pair : source_map) {
      longfist::copy(get_position(source_pair.second.source_id, source_pair.second.direction,
                                  source_pair.second.exchange_id, source_pair.second.instrument_id),
                     source_pair.second);
    }
  };

  long_positions.clear();
  short_positions.clear();
  mirror_position(book.long_positions);
  mirror_position(book.short_positions);
}

} // namespace kungfu::wingchun::book
