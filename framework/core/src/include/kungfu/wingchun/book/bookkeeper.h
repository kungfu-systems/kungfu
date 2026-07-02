// SPDX-License-Identifier: Apache-2.0

//
// Created by Keren Dong on 2020/4/6.
//

#ifndef WINGCHUN_BOOKKEEPER_H
#define WINGCHUN_BOOKKEEPER_H

#include <kungfu/wingchun/book/accounting.h>
#include <kungfu/wingchun/book/staticdata.h>
#include <kungfu/wingchun/broker/client.h>
#include <kungfu/yijinjing/practice/apprentice.h>

namespace kungfu::wingchun::book {
// key = location_uid
typedef std::unordered_map<uint32_t, Book_ptr> BookMap;

typedef std::unordered_map<uint32_t, kungfu::state<longfist::types::Quote>> QuoteStateMap;

class BookListener {
public:
  virtual void on_position_sync_reset(const Book &old_book, const Book &new_book){};
  virtual void on_asset_sync_reset(const longfist::types::Asset &old_asset, const longfist::types::Asset &new_asset){};
};
DECLARE_PTR(BookListener)

class Bookkeeper {
public:
  explicit Bookkeeper(practice::apprentice &app, broker::Client &broker_client, bool bypass_quote = false,
                      bool bypass_replace_trading_data = false);

  virtual ~Bookkeeper() = default;

  bool has_book(uint32_t location_uid);

  Book_ptr get_book(uint32_t uid);

  void drop_book(uint32_t uid);

  [[nodiscard]] const BookMap &get_books() const;

  void set_accounting_method(longfist::enums::InstrumentType instrument_type,
                             const AccountingMethod_ptr &accounting_method);

  void on_start(const rx::connectable_observable<event_ptr> &events);

  void on_order_input(int64_t update_time, uint32_t source, uint32_t dest, const longfist::types::OrderInput &input);

  void on_algo_order_input(int64_t update_time, uint32_t source, uint32_t dest,
                           const longfist::types::AlgoOrderInput &input);

  void restore(const cache::bank &state_bank);

  void guard_positions();

  void update_book(const event_ptr &event, const longfist::types::InstrumentKey &instrument_key);

  void try_update_book(const event_ptr &event, const longfist::types::Quote &quote);

  void update_book(int64_t trigger_time, const longfist::types::Quote &quote);

  void update_book(const event_ptr &event, const longfist::types::Asset &asset);

  void add_book_listener(const BookListener_ptr &book_listener);

  void mirror_positions(int64_t trigger_time, uint32_t strategy_uid);

  void try_update_position_end(const longfist::types::PositionEnd &position_end);

  [[nodiscard]] const StaticData &get_static_data() const { return static_data_; }

  std::mutex &get_update_book_mutex();

  template <typename TradingData, typename ApplyMethod = void (AccountingMethod::*)(Book_ptr, const TradingData &)>
  void update_book(const event_ptr &event, ApplyMethod method) {
    update_book(event->gen_time(), event->source(), event->dest(), event->data<TradingData>(), method);
  }

  template <typename TradingData, typename ApplyMethod = void (AccountingMethod::*)(Book_ptr, const TradingData &)>
  void update_book(int64_t update_time, uint32_t account_id, uint32_t dest, const TradingData &data,
                   ApplyMethod method) {
    std::lock_guard<std::mutex> lock(update_book_mutex_);

    if ((is_td(account_id) and not is_ready_td(account_id)) or (is_td(dest) and not is_ready_td(dest))) {
      return;
    }

    if (accounting_methods_.find(data.instrument_type) == accounting_methods_.end()) {
      SPDLOG_WARN("accounting method not found for {}: {}", data.type_name.c_str(), data.to_string());
      return;
    }
    AccountingMethod &accounting_method = *accounting_methods_.at(data.instrument_type);
    auto apply_and_update = [&](uint32_t book_uid, bool is_td = false) {
      auto book = get_book(book_uid);
      book->add_source_id(account_id);
      (accounting_method.*method)(account_id, dest, book, data);
      auto apply = [&](auto &position) { position.update_time = update_time; };
      auto direction = get_direction(data.instrument_type, data.side, data.offset);
      book->apply_position(account_id, direction, data.exchange_id, data.instrument_id, apply);
      if (not bypass_replace_trading_data_) {
        book->replace(data);
      }
      book->update(update_time);
    };
    apply_and_update(account_id);
    if (dest != yijinjing::data::location::PUBLIC and dest != yijinjing::data::location::SYNC) {
      apply_and_update(dest);
    }
  }

  template <typename TradingData> void update_book(const event_ptr &event) {
    update_book(event->gen_time(), event->source(), event->dest(), event->data<TradingData>());
  }

  template <typename TradingData>
  void update_book(int64_t update_time, uint32_t account_id, uint32_t dest, const TradingData &data) {
    std::lock_guard<std::mutex> lock(update_book_mutex_);
    auto apply_and_update = [&](uint32_t book_uid, bool is_td = false) {
      auto book = get_book(book_uid);
      book->add_source_id(account_id);
      if (not bypass_replace_trading_data_) {
        book->replace(data);
      }
    };
    apply_and_update(account_id);
    if (dest != yijinjing::data::location::PUBLIC and dest != yijinjing::data::location::SYNC) {
      apply_and_update(dest);
    }
  }

  /// 根据event->dest() == dest 选择触发t1还是t2函数
  template <typename T, typename RouteA = void (Bookkeeper::*)(const T &),
            typename RouteB = void (Bookkeeper::*)(const T &)>
  constexpr decltype(auto) fork(uint32_t dest, RouteA t1, RouteB t2) {
    return kungfu::rx::$([&, dest, t1, t2](const event_ptr &event) {
      if (event->msg_type() != T::tag) {
        return;
      }
      if (event->dest() == dest) {
        auto &data = event->data<T>();
        (this->*t1)(data);
      } else {
        auto &data = event->data<T>();
        (this->*t2)(data);
      }
    });
  }

private:
  practice::apprentice &app_;
  broker::Client &broker_client_;
  book::StaticData static_data_;
  const bool bypass_quote_;
  QuoteStateMap quotes_;
  const bool bypass_replace_trading_data_;

  const longfist::enums::AccountingMethodType account_method_type_;
  std::mutex update_book_mutex_;
  bool positions_guarded_ = false;
  BookMap books_ = {};
  AccountingMethodMap accounting_methods_ = {};
  std::vector<BookListener_ptr> book_listeners_ = {};
  BookMap books_replica_ = {}; // 暂存从location::SYNC传来的asset和position信息
  std::unordered_map<uint32_t, bool> ready_tds_{};

  Book_ptr make_book(uint32_t location_uid);

  void batch_update_book_by_quote();

  void try_update_asset(const longfist::types::Asset &asset);

  void try_update_position(const longfist::types::Position &position);

  void try_sync_asset(const longfist::types::Asset &asset);

  void try_sync_position(const longfist::types::Position &position);

  void try_sync_position_end(const longfist::types::PositionEnd &position_end);

  Book_ptr get_book_replica(uint32_t location_uid);

  void on_output_key(const event_ptr &event);

  void on_broker_state(const longfist::types::BrokerStateUpdate &state_update);

  void on_register(const longfist::types::Register &reg);

  void on_deregister(const longfist::types::Deregister &deregister);

  bool is_td(uint32_t location_uid);

  bool is_ready_td(uint32_t location_uid);
};
} // namespace kungfu::wingchun::book
#endif // WINGCHUN_BOOKKEEPER_H