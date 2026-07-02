// SPDX-License-Identifier: Apache-2.0

//
// Created by Keren Dong on 2020/4/6.
//

#include <kungfu/wingchun/book/bookkeeper.h>

using namespace kungfu::rx;
using namespace kungfu::longfist::enums;
using namespace kungfu::longfist::types;
using namespace kungfu::wingchun::broker;
using namespace kungfu::wingchun::map;
using namespace kungfu::practice;
using namespace kungfu::yijinjing;
using namespace kungfu::yijinjing::data;
using namespace kungfu::yijinjing::util;

namespace kungfu::wingchun::book {
Bookkeeper::Bookkeeper(apprentice &app, broker::Client &broker_client, bool bypass_quote,
                       bool bypass_replace_trading_data)
    : app_(app), broker_client_(broker_client), static_data_(app), bypass_quote_(bypass_quote),
      bypass_replace_trading_data_(bypass_replace_trading_data),
      account_method_type_(book::get_accounting_method_type()) {
  book::AccountingMethod::setup_defaults(*this, account_method_type_);
}

bool Bookkeeper::has_book(uint32_t location_uid) { return books_.find(location_uid) != books_.end(); }

void Bookkeeper::drop_book(uint32_t uid) { books_.erase(uid); }

Book_ptr Bookkeeper::get_book(uint32_t location_uid) {
  if (books_.find(location_uid) == books_.end()) {
    books_.emplace(location_uid, make_book(location_uid));
  }
  return books_.at(location_uid);
}

const BookMap &Bookkeeper::get_books() const { return books_; }

void Bookkeeper::set_accounting_method(InstrumentType instrument_type, const AccountingMethod_ptr &accounting_method) {
  accounting_methods_.emplace(instrument_type, accounting_method);
}

void Bookkeeper::on_start(const rx::connectable_observable<event_ptr> &events) {
  static_data_.on_start(events);
  restore(app_.get_state_bank());

  events | fork<PositionEnd>(location::SYNC, &Bookkeeper::try_sync_position_end, &Bookkeeper::try_update_position_end);
  events | fork<Asset>(location::SYNC, &Bookkeeper::try_sync_asset, &Bookkeeper::try_update_asset);
  events | fork<Position>(location::SYNC, &Bookkeeper::try_sync_position, &Bookkeeper::try_update_position);
  events | is_own<Quote>(broker_client_) | $$(try_update_book(event, event->data<Quote>()));
  events | is(InstrumentKey::tag) | $$(update_book(event, event->data<InstrumentKey>()));
  events | is(OrderInput::tag) |
      $$(on_order_input(event->gen_time(), event->source(), event->dest(), event->data<OrderInput>()));
  events | is(Order::tag) | $$(update_book<Order>(event, &AccountingMethod::apply_order));
  events | is(Trade::tag) | $$(update_book<Trade>(event, &AccountingMethod::apply_trade));
  events | is(AlgoOrderInput::tag) |
      $$(on_algo_order_input(event->gen_time(), event->source(), event->dest(), event->data<AlgoOrderInput>()));
  events | is(AlgoOrder::tag) | $$(update_book<AlgoOrder>(event));
  events | is(Asset::tag) | $$(update_book(event, event->data<Asset>()));
  events | is(ResetBookRequest::tag) | $$(drop_book(event->source()));
  events | is(OutputKey::tag) | $$(on_output_key(event));
  events | is(BrokerStateUpdate::tag) | $$(on_broker_state(event->data<BrokerStateUpdate>()));
  events | is(Register::tag) | $$(on_register(event->data<Register>()));
  events | is(Deregister::tag) | $$(on_deregister(event->data<Deregister>()));

  if (bypass_quote_) {
    app_.add_time_interval(yijinjing::time_unit::NANOSECONDS_PER_SECOND * 15,
                           [&](auto e) { batch_update_book_by_quote(); });
  }
}

void Bookkeeper::batch_update_book_by_quote() {
  SPDLOG_DEBUG("batch_update_book_by_quote");

  for (const auto &iter : quotes_) {
    const auto &state_quote = iter.second;
    update_book(state_quote.update_time, state_quote.data);
  }
  quotes_.clear();
}

std::mutex &Bookkeeper::get_update_book_mutex() { return update_book_mutex_; }

void Bookkeeper::try_update_position_end(const PositionEnd &position_end) {
  get_book(position_end.holder_uid)->update(app_.now());
}

void Bookkeeper::on_order_input(int64_t update_time, uint32_t source, uint32_t dest, const OrderInput &input) {
  update_book<OrderInput>(update_time, dest, source, input, &AccountingMethod::apply_order_input);
}

void Bookkeeper::on_algo_order_input(int64_t update_time, uint32_t source, uint32_t dest,
                                     const longfist::types::AlgoOrderInput &input) {
  update_book<AlgoOrderInput>(update_time, dest, source, input);
}

void Bookkeeper::restore(const cache::bank &state_bank) {
  for (auto &pair : state_bank[boost::hana::type_c<Position>]) {
    auto &state = pair.second;
    auto &position = state.data;
    if (not app_.has_location(position.holder_uid) or not app_.has_location(position.source_id)) {
      continue;
    }
    auto book = get_book(position.holder_uid);
    auto is_long = position.direction == longfist::enums::Direction::Long;
    auto &positions = is_long ? book->long_positions : book->short_positions;
    positions[hash_instrument(position.source_id, position.exchange_id, position.instrument_id)] = position;
    positions[hash_instrument(position.source_id, position.exchange_id, position.instrument_id)].source_op_id =
        get_source_op_id(position.holder_uid, position.source_id);
    book->add_source_id(position.source_id);
  }

  for (auto &pair : state_bank[boost::hana::type_c<Asset>]) {
    auto &state = pair.second;
    auto &asset = state.data;
    if (not app_.has_location(asset.holder_uid)) {
      continue;
    }
    auto book = get_book(asset.holder_uid);
    book->asset = asset;
    book->update(app_.now());
  }

  if (not bypass_replace_trading_data_) {
    for (auto &pair : state_bank[boost::hana::type_c<OrderInput>]) {
      auto &order_input_state = pair.second;
      auto source_book = get_book(order_input_state.source);
      source_book->replace(order_input_state.data);
      auto dest_book = get_book(order_input_state.dest);
      dest_book->replace(order_input_state.data);
    }

    for (auto &pair : state_bank[boost::hana::type_c<Order>]) {
      auto &order_state = pair.second;
      auto source_book = get_book(order_state.source);
      source_book->replace(order_state.data);
      if (order_state.dest == location::PUBLIC) {
        continue;
      }
      auto dest_book = get_book(order_state.dest);
      dest_book->replace(order_state.data);
    }

    for (auto &pair : state_bank[boost::hana::type_c<Trade>]) {
      auto &trade_state = pair.second;
      auto source_book = get_book(trade_state.source);
      source_book->replace(trade_state.data);
      if (trade_state.dest == location::PUBLIC) {
        continue;
      }
      auto dest_book = get_book(trade_state.dest);
      dest_book->replace(trade_state.data);
    }

    for (auto &pair : state_bank[boost::hana::type_c<AlgoOrderInput>]) {
      auto &algo_order_input_state = pair.second;
      auto source_book = get_book(algo_order_input_state.source);
      source_book->replace(algo_order_input_state.data);
      auto dest_book = get_book(algo_order_input_state.dest);
      dest_book->replace(algo_order_input_state.data);
    }

    for (auto &pair : state_bank[boost::hana::type_c<AlgoOrder>]) {
      auto &algo_order_state = pair.second;
      auto source_book = get_book(algo_order_state.source);
      source_book->replace(algo_order_state.data);
      if (algo_order_state.dest == location::PUBLIC) {
        continue;
      }
      auto dest_book = get_book(algo_order_state.dest);
      dest_book->replace(algo_order_state.data);
    }
  }
}

void Bookkeeper::guard_positions() { positions_guarded_ = true; }

Book_ptr Bookkeeper::make_book(uint32_t location_uid) {
  auto location = app_.get_location(location_uid);
  auto book = std::make_shared<Book>(static_data_.get_commissions(), static_data_.get_instruments(),
                                     static_data_.get_instrument_factors(), accounting_methods_, location);
  auto &asset = book->asset;
  asset.holder_uid = location_uid;
  asset.ledger_category = location->category == category::TD ? LedgerCategory::Account : LedgerCategory::Strategy;
  return book;
}

void Bookkeeper::update_book(const event_ptr &event, const InstrumentKey &instrument_key) {
  std::lock_guard<std::mutex> lock(update_book_mutex_);
  SPDLOG_DEBUG("update_book by instrument_key {}, from {} to {}", instrument_key.to_string(),
               app_.get_location_uname(event->source()), app_.get_location_uname(event->dest()));
  broker_client_.subscribe(instrument_key);
  get_book(event->source())->ensure_position_for(instrument_key);
}

void Bookkeeper::try_update_book(const event_ptr &event, const Quote &quote) {
  if (bypass_quote_) {
    state<Quote> state_quote(event->source(), event->dest(), event->gen_time(), quote);
    auto hashed_instrument_key = hash_instrument(quote.exchange_id, quote.instrument_id);
    quotes_.insert_or_assign(hashed_instrument_key, state_quote);
    return;
  }

  update_book(event->gen_time(), quote);
}

void Bookkeeper::update_book(int64_t trigger_time, const Quote &quote) {
  std::lock_guard<std::mutex> lock(update_book_mutex_);
  if (accounting_methods_.find(quote.instrument_type) == accounting_methods_.end()) {
    return;
  }
  auto accounting_method = accounting_methods_.at(quote.instrument_type);
  auto apply = [&](auto &position) { position.update_time = trigger_time; };

  for (auto &item : books_) {
    auto &book = item.second;
    if (book->has_short_position_for(quote) or book->has_long_position_for(quote)) {
      accounting_method->apply_quote(book, quote);
      book->update(trigger_time);
    }
    book->apply_long_position_for(quote, apply);
    book->apply_short_position_for(quote, apply);
  }
}

void Bookkeeper::update_book(const event_ptr &event, const Asset &asset) {
  if (app_.has_location(asset.holder_uid)) {
    get_book(asset.holder_uid)->update(event->gen_time());
  }
}

void Bookkeeper::try_update_asset(const Asset &asset) {
  if (app_.has_location(asset.holder_uid)) {
    get_book(asset.holder_uid)->asset = asset;
  }
}

void Bookkeeper::try_update_position(const Position &position) {
  if (not app_.has_location(position.holder_uid)) {
    return;
  }

  auto book = get_book(position.holder_uid);
  auto apply = [&](auto &target_position) {
    if (positions_guarded_ and target_position.update_time >= position.update_time) {
      return;
    }
    auto last_price = std::max(position.last_price, target_position.last_price);
    target_position = position;
    target_position.last_price = last_price;
    if (accounting_methods_.find(target_position.instrument_type) == accounting_methods_.end()) {
      return;
    }
    accounting_methods_.at(target_position.instrument_type)->update_position(book, target_position);
  };

  book->apply_position(position.source_id, position.direction, position.exchange_id, position.instrument_id, apply);
}

void Bookkeeper::try_sync_asset(const longfist::types::Asset &asset) {
  if (not app_.has_location(asset.holder_uid)) {
    return;
  }

  get_book_replica(asset.holder_uid)->asset = asset;
  auto old_book = get_book(asset.holder_uid);
  bool asset_changed = old_book->asset.avail != asset.avail || // 可用资金
                       old_book->asset.margin != asset.margin; // 保证金(期货)

  if (asset_changed) {
    for (auto &book_listener : book_listeners_) {
      book_listener->on_asset_sync_reset(old_book->asset, asset);
    }
    longfist::copy(old_book->asset, asset);
  }
}

void Bookkeeper::try_sync_position(const longfist::types::Position &position) {
  if (not app_.has_location(position.holder_uid)) {
    return;
  }
  auto book = get_book_replica(position.holder_uid);
  auto apply = [&](auto &target_position) { target_position = position; };
  book->apply_position(position.source_id, position.direction, position.exchange_id, position.instrument_id, apply);
}

Book_ptr Bookkeeper::get_book_replica(uint32_t location_uid) {
  if (books_replica_.find(location_uid) == books_replica_.end()) {
    books_replica_.emplace(location_uid, make_book(location_uid));
  }
  return books_replica_.at(location_uid);
}

void Bookkeeper::try_sync_position_end(const PositionEnd &position_end) {
  if (not app_.has_location(position_end.holder_uid)) {
    return;
  }

  auto old_book = get_book(position_end.holder_uid);
  auto new_book = get_book_replica(position_end.holder_uid);

  auto position_compare = [](const PositionMap &source_map, Book_ptr &target_book) {
    bool changed = false;
    for (auto &source_pair : source_map) {
      auto &source_position = source_pair.second;
      const auto &target_position =
          target_book->get_position(source_position.source_id, source_position.direction, source_position.exchange_id,
                                    source_position.instrument_id);
      changed |= source_position.volume != target_position.volume ||                   // 数量
                 source_position.open_volume != target_position.open_volume ||         // 今开
                 source_position.yesterday_volume != target_position.yesterday_volume; // 昨仓数量
    }
    return changed;
  };

  bool position_changed =
      position_compare(new_book->long_positions, old_book) | position_compare(new_book->short_positions, old_book) |
      position_compare(old_book->long_positions, new_book) | position_compare(old_book->short_positions, new_book);
  if (position_changed) {
    for (auto &book_listener : book_listeners_) {
      book_listener->on_position_sync_reset(*old_book, *new_book);
    }
    SPDLOG_DEBUG("local position volume of {} is different from TD server",
                 app_.get_location_uname(position_end.holder_uid));
    old_book->mirror_position_from(*new_book);
    old_book->update(app_.now());
  }
  books_replica_.erase(position_end.holder_uid); // delete replica every time
}

void Bookkeeper::add_book_listener(const BookListener_ptr &book_listener) { book_listeners_.push_back(book_listener); }

void Bookkeeper::mirror_positions(int64_t trigger_time, uint32_t strategy_uid) {
  auto strategy_book = get_book(strategy_uid);
  auto reset_positions = [trigger_time](auto &position) {
    position.volume = 0;
    position.yesterday_volume = 0;
    position.frozen_total = 0;
    position.frozen_yesterday = 0;
    position.open_volume = 0;
    position.static_yesterday = 0;
    position.avg_open_price = 0;
    position.position_cost_price = 0;
    position.update_time = trigger_time;
  };
  strategy_book->apply_short_positions(reset_positions);
  strategy_book->apply_long_positions(reset_positions);

  auto copy_positions = [&](const auto &position) {
    if (strategy_book->has_position_for(position)) {
      auto &strategy_position = strategy_book->get_position_for(position);
      longfist::copy(strategy_position, position);
      strategy_position.holder_uid = strategy_uid;
      strategy_position.ledger_category = LedgerCategory::Strategy;
      strategy_position.update_time = trigger_time;
      strategy_position.source_id = position.source_id;
      strategy_position.source_op_id = get_source_op_id(strategy_uid, position.source_id);
    }
  };

  for (const auto &pair : get_books()) {
    auto &book = pair.second;
    auto holder_uid = book->asset.holder_uid;
    if (book->asset.ledger_category == LedgerCategory::Account and app_.has_channel(strategy_uid, holder_uid)) {
      book->apply_long_positions(copy_positions);
      book->apply_short_positions(copy_positions);
    }
  }
  strategy_book->update(trigger_time);
}

void Bookkeeper::on_output_key(const event_ptr &event) {
  const OutputKey &key = event->data<OutputKey>();
  get_book(event->source())->add_source_id(key.location_uid);
}

void Bookkeeper::on_broker_state(const longfist::types::BrokerStateUpdate &state_update) {
  ready_tds_.insert_or_assign(state_update.location_uid, state_update.state == BrokerState::Ready);
}

void Bookkeeper::on_deregister(const longfist::types::Deregister &deregister) {
  if (deregister.category == category::TD) {
    ready_tds_.insert_or_assign(deregister.location_uid, false);
  }
}

void Bookkeeper::on_register(const longfist::types::Register &reg) {
  if (reg.category == category::TD) {
    ready_tds_.insert_or_assign(reg.location_uid, false);
  }
}

bool Bookkeeper::is_td(uint32_t location_uid) {
  if (not app_.has_location(location_uid)) {
    return false;
  }
  return app_.get_location(location_uid)->category == category::TD;
}

bool Bookkeeper::is_ready_td(uint32_t location_uid) {
  if (app_.get_location(location_uid)->mode == mode::BACKTEST) {
    return true;
  }
  return ready_tds_.try_emplace(location_uid, false).first->second;
}

} // namespace kungfu::wingchun::book