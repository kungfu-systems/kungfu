// SPDX-License-Identifier: Apache-2.0

//
// Created by Keren Dong on 2019-06-20.
//

#ifndef WINGCHUN_CONTEXT_H
#define WINGCHUN_CONTEXT_H

#include <kungfu/longfist/longfist.h>
#include <kungfu/wingchun/book/bookkeeper.h>
#include <kungfu/wingchun/book/staticdata.h>
#include <kungfu/wingchun/broker/client.h>
#include <kungfu/wingchun/factor/backteststreamdatabatcher.h>
#include <kungfu/wingchun/factor/crosssection.h>
#include <kungfu/wingchun/factor/livestreamdatabatcher.h>
#include <kungfu/wingchun/factor/streamdatabatcher.h>
#include <kungfu/wingchun/orderbook/orderbooks.h>
#include <kungfu/wingchun/strategy/strategy.h>
#include <kungfu/yijinjing/practice/apprentice.h>

namespace kungfu::wingchun::strategy {

class Context : public std::enable_shared_from_this<Context> {
public:
  Context(practice::apprentice &app, const rx::connectable_observable<event_ptr> &events);

  virtual ~Context() = default;

  /**
   * checked_ is strated started.
   * @return current time in nano seconds
   */
  virtual bool is_started() const = 0;

  /**
   * Get current time in nano seconds.
   * @return current time in nano seconds
   */
  virtual int64_t now() const = 0;

  /**
   * Get location_uid of current process
   * @return location_uid
   */
  virtual uint32_t get_home_uid() const = 0;

  /**
   * Get config from database.
   * @return  config of current location_uid
   */
  virtual std::string get_config() const = 0;

  /**
   * Get arguments kfc run -a
   * @return string of arguments
   */

  virtual std::string get_arguments() { return app_.get_arguments(); };

  /**
   * Add one shot timer callback.
   * @param nanotime when to call in nano seconds
   * @param callback callback function
   */
  virtual int32_t add_timer(int64_t nanotime, const std::function<void(event_ptr)> &callback) = 0;

  /**
   * Add periodically callback.
   * @param duration duration in nano seconds
   * @param callback callback function
   */
  virtual int32_t add_time_interval(int64_t duration, const std::function<void(event_ptr)> &callback) = 0;

  /**
   * Clear timer
   * @param timer_id id of timer, return by add_timer and add_time_interval
   */
  virtual void clear_timer(int32_t timer_id) = 0;

  /**
   * Add account for strategy.
   * @param source TD group
   * @param account TD account ID
   */
  virtual void add_account(const std::string &source, const std::string &account) = 0;

  /**
   * Subscribe market data.
   * @param source MD group
   * @param instrument_ids instrument IDs
   * @param exchange_ids exchange IDs
   */
  virtual void subscribe(const std::string &source, const std::vector<std::string> &instrument_ids,
                         const std::string &exchange_id) = 0;

  /**
   * Unubscribe market data.
   * @param source MD group
   * @param instrument_ids instrument IDs
   * @param exchange_id exchange ID
   */
  virtual void unsubscribe(const std::string &source, const std::vector<std::string> &instrument_ids,
                           const std::string &exchange_id) {};

  /**
   * Subscribe all from given MD
   * @param source MD group
   */
  virtual void subscribe_all(const std::string &source, uint8_t market_type = 0, uint64_t instrument_type = 0,
                             uint64_t data_type = 0) = 0;

  /**
   * Subscribe operator data.
   * @param group OPERATOR group
   * @param name OPERATOR name
   */
  virtual void subscribe_operator(const std::string &group, const std::string &name) = 0;

  /**
   * Get broker client.
   * @return broker client reference
   */
  virtual broker::Client &get_broker_client() = 0;

  /**
   * Get bookkeeper.
   * @return bookkeeper reference
   */
  virtual book::Bookkeeper &get_bookkeeper() = 0;

  /**
   * Insert Block Message
   * @param opponent_seat
   * @param match_number
   * @param value
   * @return
   */
  virtual uint64_t insert_block_message(const std::string &source, const std::string &account,
                                        const std::string &opponent_seat, uint64_t match_number,
                                        bool is_specific = false) = 0;

  /**
   * Insert order.
   * @param instrument_id instrument ID
   * @param exchange_id exchange ID
   * @param source source ID
   * @param account account ID
   * @param limit_price limit price
   * @param volume trade volume
   * @param type price type
   * @param side side
   * @param offset offset, defaults to longfist::enums::Offset::Open
   * @param hedge_flag hedge_flag, defaults to longfist::enums::HedgeFlag::Speculation
   * @param block_id BlockMessage id
   * @param is_swap boolean
   * @param parent_id parent order id
   * @return
   */
  virtual uint64_t insert_order(const std::string &instrument_id, const std::string &exchange_id,
                                const std::string &source, const std::string &account, double limit_price,
                                double volume, longfist::enums::PriceType type, longfist::enums::Side side,
                                longfist::enums::Offset offset,
                                longfist::enums::HedgeFlag hedge_flag = longfist::enums::HedgeFlag::Speculation,
                                bool is_swap = false, uint64_t block_id = 0, uint64_t parent_id = 0,
                                const std::string &contract_id = "") = 0;

  /**
   * Insert Order
   * @param source
   * @param account
   * @param order_input
   * @return
   */
  virtual uint64_t insert_order_input(const std::string &source, const std::string &account,
                                      longfist::types::OrderInput &order_input) = 0;

  /**
   *
   * @param instrument_id
   * @param exchange_id
   * @param source
   * @param account
   * @param limit_price
   * @param volume
   * @param type
   * @param side
   * @param offset
   * @param trigger_type
   * @param time_condition
   * @param action_flag
   * @param order_id
   * @param stop_price
   * @param hedge_flag
   * @param is_swap
   * @return
   */
  virtual uint64_t
  insert_order_trigger(const std::string &instrument_id, const std::string &exchange_id, const std::string &source,
                       const std::string &account, double limit_price, double volume, longfist::enums::PriceType type,
                       longfist::enums::Side side, longfist::enums::Offset offset,
                       longfist::enums::OrderTriggerType trigger_type = longfist::enums::OrderTriggerType::ParkedOrder,
                       double stop_price = 0,
                       longfist::enums::HedgeFlag hedge_flag = longfist::enums::HedgeFlag::Speculation,
                       bool is_swap = false) = 0;

  /**
   * Insert Batch Orders
   * @param source
   * @param account
   * @param instrument_ids
   * @param exchange_ids
   * @param limit_prices
   * @param volumes
   * @param types
   * @param sides
   * @param offsets
   * @param hedge_flags
   * @param is_swaps
   * @return
   */
  virtual std::vector<uint64_t>
  insert_batch_orders(const std::string &source, const std::string &account,
                      const std::vector<std::string> &instrument_ids, const std::vector<std::string> &exchange_ids,
                      std::vector<double> limit_prices, std::vector<double> volumes,
                      std::vector<longfist::enums::PriceType> types, std::vector<longfist::enums::Side> sides,
                      std::vector<longfist::enums::Offset> offsets, std::vector<longfist::enums::HedgeFlag> hedge_flags,
                      std::vector<bool> is_swaps, const std::vector<std::string> &contract_ids = {}) = 0;

  /**
   * Insert Batch Orders
   * @param source
   * @param account
   * @param order_inputs
   * @return
   */
  virtual std::vector<uint64_t> insert_array_orders(const std::string &source, const std::string &account,
                                                    std::vector<longfist::types::OrderInput> &order_inputs) = 0;

  /**
   * @param instrument_id instrument ID
   * @param exchange_id exchange ID
   * @param source source ID
   * @param account account ID
   * @param begin_time algo begin time
   * @param end_time algo end time
   * @param volume trade volume
   * @param type price type
   * @param side side
   * @param offset offset, defaults to longfist::enums::Offset::Open
   * @param algo_type_id algo type id
   * @param algo_id algo id
   * @param args json string for algo custom arguments
   * @param is_local boolean marking local algo order
   * @return order_id
   */
  virtual uint64_t insert_algo_order(const std::string &instrument_id, const std::string &exchange_id,
                                     const std::string &source, const std::string &account, int64_t begin_time,
                                     int64_t end_time, double volume, longfist::enums::PriceType type,
                                     longfist::enums::Side side, longfist::enums::Offset offset,
                                     const std::string &algo_type_id, const std::string &algo_id,
                                     const std::string &args, bool is_local = false, uint32_t basket_uid = 0,
                                     longfist::enums::PriceLevel price_level = longfist::enums::PriceLevel::Last,
                                     double price_offset = 0) = 0;

  /**
   * @param origin_order_id origin order id to update
   * @param source source ID
   * @param account account ID
   * @param volume trade volume
   * @return order_id
   */
  virtual uint64_t update_algo_order_volume(uint64_t origin_order_id, const std::string &source,
                                            const std::string &account, double volume) = 0;

  /**
   * Cancel order.
   * @param order_id order ID
   * @param action_flag for mark cancel or trigger cancel
   * @return order action ID
   */
  virtual uint64_t
  cancel_order(uint64_t order_id,
               longfist::enums::OrderActionFlag action_flag = longfist::enums::OrderActionFlag::Cancel) = 0;

  /**
   * Cancel OrderTrigger
   * @param trigger_id
   * @return trigger action id
   */
  virtual uint64_t cancel_order_trigger(uint64_t trigger_id) = 0;

  /**
   * Cancel Algo Order
   * @param algo_order_id
   * @return algo order action ID
   */
  virtual uint64_t cancel_algo_order(uint64_t algo_order_id, longfist::enums::AlgoOrderActionFlag action_flag =
                                                                 longfist::enums::AlgoOrderActionFlag::Cancel) = 0;

  /**
   * Toggle Algo Order
   * @param algo_order_id
   * @return algo order action ID
   */
  virtual uint64_t
  toggle_algo_order(uint64_t algo_order_id,
                    longfist::enums::AlgoOrderActionFlag action_flag = longfist::enums::AlgoOrderActionFlag::Start) = 0;

  /**
   * query history order
   */
  virtual void req_history_order(const std::string &source, const std::string &account, uint32_t query_num = 0) = 0;

  /**
   * query history trade
   */
  virtual void req_history_trade(const std::string &source, const std::string &account, uint32_t query_num = 0) = 0;

  /**
   * Tells whether the book is held.
   * If book is held, all traded positions will be recovered from ledger.
   * If book is not held, ledger will use the information collected in pre_start to build a fresh book.
   * @return true if book is held, false otherwise. Defaults to false.
   */
  [[nodiscard]] bool is_book_held() const;

  /**
   * Tells whether to mirror positions from enrolled accounts.
   * If positions are mirrored, will always have positions equal to the corresponding positions under accounts.
   * If positions are not mirrored, will set positions to 0 for newly added strategies, or the history values recorded
   * by kungfu.
   * @return true if positions are mirrored, false otherwise. Defaults to true.
   */
  [[nodiscard]] bool is_positions_held() const;

  /**
   * Call to hold book.
   */
  void hold_book();

  /**
   * Call to hold positions, i.e. do not mirror positions.
   */
  void hold_positions();

  /**
   * Call to skip bookkeeper calculation
   */
  void bypass_accounting();

  /**
   * Tells whether skip bookkeeper
   * @return true to skip bookkeeper, false to using bookkeeper
   */
  bool is_bypass_accounting() const;

  /**
   * request deregister.
   * @return void
   */
  virtual void req_deregister() {};

  /**
   * Update Strategy State
   * @param state StrategyState
   * @param infos vector<string>, info_a, info_b, info_c.
   */
  virtual void update_strategy_state(longfist::types::StrategyStateUpdate &state_update) {};

  /**
   *
   * @param location_uid
   * @return location_ptr of location_uid
   */
  virtual yijinjing::data::location_ptr get_location(uint32_t location_uid) = 0;

  /**
   *
   * @param resume_policy
   * @return void
   */
  virtual void set_resume_policy(longfist::enums::ResumePolicy resume_policy) {};

  /**
   *
   * @return longfist::enums::ResumePolicy
   */
  virtual longfist::enums::ResumePolicy get_resume_policy() { return longfist::enums::ResumePolicy::Now; };

  /**
   * attach the orderbooks to market data received.
   * @param orderbooks
   */
  void attach_orderbooks(orderbook::Orderbooks &orderbooks);

  /**
   * attach the factor cache to market data received.
   * @param factor_cache
   */
  void attach_factor_cache(factor::MultiCrossSectionalFactor &factor_cache);

  /**
   * the directory of strategy
   * @return
   */
  const std::string &get_strategy_dir();

  virtual std::shared_ptr<wingchun::factor::StreamDataBatcher> batch_streaming() = 0;

protected:
  practice::apprentice &app_;
  const rx::connectable_observable<event_ptr> &events_;
  std::string strategy_dir_;
  bool started_ = false;

  virtual void on_start() {};

  virtual void prepare(const event_ptr &event) = 0;

  virtual void post_stop() {};

private:
  bool book_held_ = false;
  bool positions_mirrored_ = true;
  bool bypass_accounting_ = false;

  friend void enable(Context &context) { context.on_start(); }

  friend void prepare(const event_ptr &event, Context &context) { context.prepare(event); }

  friend void stop(Context &context) { context.post_stop(); }

  friend void make_strategy_dir(Context &context, const std::string &strategy_dir) {
    context.strategy_dir_ = strategy_dir;
  }
};
} // namespace kungfu::wingchun::strategy

#endif // WINGCHUN_CONTEXT_H
