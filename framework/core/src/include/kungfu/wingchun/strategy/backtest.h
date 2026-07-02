// SPDX-License-Identifier: Apache-2.0

//
// Created by Keren Dong on 2020/7/20.
//

#ifndef WINGCHUN_STRATEGY_BACKTEST_H
#define WINGCHUN_STRATEGY_BACKTEST_H

#include <kungfu/wingchun/strategy/context.h>
#include <kungfu/wingchun/strategy/matcher.h>
#include <kungfu/wingchun/tool/report.h>
#include <kungfu/wingchun/tool/sliceindexer.h>
#include <kungfu/wingchun/tool/slicetool.h>
#include <unordered_map>

namespace kungfu::wingchun::strategy {
class BacktestContext : public Context {
public:
  explicit BacktestContext(practice::apprentice &app, const rx::connectable_observable<event_ptr> &events,
                           Matcher_ptr matcher, tool::SliceIndexer_ptr from_indexer, tool::SliceIndexer_ptr to_indexer,
                           tool::Report_ptr report, int64_t time_interval, std::string backtest_config);

  ~BacktestContext() = default;

  /**
   * checked_ is strated started.
   * @return current time in nano seconds
   */
  bool is_started() const override;

  /**
   * Get location_uid of current process
   * @return location_uid
   */
  uint32_t get_home_uid() const override;

  /**
   * Get config from database.
   * @return  config of current location_uid
   */
  std::string get_config() const override;

  /**
   * Get current time in nano seconds.
   * @return current time in nano seconds
   */
  int64_t now() const override;

  /**
   * Add one shot timer callback.
   * @param nanotime when to call in nano seconds
   * @param callback callback function
   */
  int32_t add_timer(int64_t nanotime, const std::function<void(event_ptr)> &callback) override;

  /**
   * Add periodically callback.
   * @param duration duration in nano seconds
   * @param callback callback function
   */
  int32_t add_time_interval(int64_t duration, const std::function<void(event_ptr)> &callback) override;

  /**
   * Clear timer
   * @param timer_id id of timer, return by add_timer and add_time_interval
   */
  void clear_timer(int32_t timer_id) override;

  /**
   * Add account for strategy.
   * @param source TD group
   * @param account TD account ID
   */
  void add_account(const std::string &source, const std::string &account) override;

  /**
   * Subscribe market data.
   * @param source MD group
   * @param instrument_ids instrument IDs
   * @param exchange_id exchange IDs
   */
  void subscribe(const std::string &source, const std::vector<std::string> &instrument_ids,
                 const std::string &exchange_id) override;

  /**
   * Unubscribe market data.
   * @param source MD group
   * @param instrument_ids instrument IDs
   * @param exchange_id exchange ID
   */
  void unsubscribe(const std::string &source, const std::vector<std::string> &instrument_ids,
                   const std::string &exchange_id) override;

  /**
   * Subscribe all from given MD
   * @param source MD group
   */
  void subscribe_all(const std::string &source, uint8_t market_type = 0, uint64_t instrument_type = 0,
                     uint64_t data_type = 0) override;

  /**
   * Subscribe operator data.
   * @param group OPERATOR group
   * @param name OPERATOR name
   */
  void subscribe_operator(const std::string &group, const std::string &name) override;

  /**
   * Get broker client.
   * @return broker client reference
   */
  broker::Client &get_broker_client() override;

  /**
   * Get bookkeeper.
   * @return bookkeeper reference
   */
  book::Bookkeeper &get_bookkeeper() override;

  /**
   * Insert Block Message
   * @param opponent_seat
   * @param match_number
   * @param value
   * @return
   */
  uint64_t insert_block_message(const std::string &source, const std::string &account, const std::string &opponent_seat,
                                uint64_t match_number, bool is_specific = false) override;

  /**
   *
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
   * @return order_id
   */
  uint64_t insert_order(const std::string &instrument_id, const std::string &exchange_id, const std::string &source,
                        const std::string &account, double limit_price, double volume, longfist::enums::PriceType type,
                        longfist::enums::Side side, longfist::enums::Offset offset,
                        longfist::enums::HedgeFlag hedge_flag = longfist::enums::HedgeFlag::Speculation,
                        bool is_swap = false, uint64_t block_id = 0, uint64_t parent_id = 0,
                        const std::string &contract_id = "") override;

  /**
   * Insert Order
   * @param source
   * @param account
   * @param order_input
   * @return
   */
  uint64_t insert_order_input(const std::string &source, const std::string &account,
                              longfist::types::OrderInput &order_input) override;

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
   * @param action_flag
   * @param order_id
   * @param stop_price
   * @param hedge_flag
   * @param is_swap
   * @return
   */
  uint64_t insert_order_trigger(const std::string &instrument_id, const std::string &exchange_id,
                                const std::string &source, const std::string &account, double limit_price,
                                double volume, longfist::enums::PriceType type, longfist::enums::Side side,
                                longfist::enums::Offset offset, longfist::enums::OrderTriggerType trigger_type,
                                double stop_price = 0,
                                longfist::enums::HedgeFlag hedge_flag = longfist::enums::HedgeFlag::Speculation,
                                bool is_swap = false) override;

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
  std::vector<uint64_t>
  insert_batch_orders(const std::string &source, const std::string &account,
                      const std::vector<std::string> &instrument_ids, const std::vector<std::string> &exchange_ids,
                      std::vector<double> limit_prices, std::vector<double> volumes,
                      std::vector<longfist::enums::PriceType> types, std::vector<longfist::enums::Side> sides,
                      std::vector<longfist::enums::Offset> offsets, std::vector<longfist::enums::HedgeFlag> hedge_flags,
                      std::vector<bool> is_swaps, const std::vector<std::string> &contract_ids = {}) override;

  /**
   * Insert Batch Orders
   * @param source
   * @param account
   * @param order_inputs
   * @return
   */
  std::vector<uint64_t> insert_array_orders(const std::string &source, const std::string &account,
                                            std::vector<longfist::types::OrderInput> &order_inputs) override;

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
   * @param basket_uid basket uid
   * @return order_id
   */
  uint64_t insert_algo_order(const std::string &instrument_id, const std::string &exchange_id,
                             const std::string &source, const std::string &account, int64_t begin_time,
                             int64_t end_time, double volume, longfist::enums::PriceType type,
                             longfist::enums::Side side, longfist::enums::Offset offset,
                             const std::string &algo_type_id, const std::string &algo_id, const std::string &args,
                             bool is_local = false, uint32_t basket_uid = 0,
                             longfist::enums::PriceLevel price_level = longfist::enums::PriceLevel::Last,
                             double price_offset = 0) override;

  /**
   * @param origin_order_id origin order id to update
   * @param source source ID
   * @param account account ID
   * @param volume trade volume
   * @return order_id
   */
  uint64_t update_algo_order_volume(uint64_t origin_order_id, const std::string &source, const std::string &account,
                                    double volume) override;

  /**
   * Cancel order.
   * @param order_id order ID
   * @return order action ID
   */
  uint64_t
  cancel_order(uint64_t order_id,
               longfist::enums::OrderActionFlag action_flag = longfist::enums::OrderActionFlag::Cancel) override;

  /**
   * Cancel OrderTrigger
   * @param trigger_id
   * @return trigger action id
   */
  uint64_t cancel_order_trigger(uint64_t trigger_id) override;

  /**
   * Cancel Algo Order
   * @param algo_order_id
   * @return algo order action ID
   */
  uint64_t cancel_algo_order(uint64_t algo_order_id, longfist::enums::AlgoOrderActionFlag action_flag =
                                                         longfist::enums::AlgoOrderActionFlag::Cancel) override;
  /**
   * Toggle Algo Order
   * @param algo_order_id
   * @return algo order action ID
   */
  uint64_t toggle_algo_order(uint64_t algo_order_id, longfist::enums::AlgoOrderActionFlag action_flag =
                                                         longfist::enums::AlgoOrderActionFlag::Start) override;

  /**
   * query history order
   */
  void req_history_order(const std::string &source, const std::string &account, uint32_t query_num = 0) override;

  /**
   * query history trade
   */
  void req_history_trade(const std::string &source, const std::string &account, uint32_t query_num = 0) override;

  /**
   * request deregister.
   * @return void
   */
  void req_deregister() override;

  /**
   * Update Strategy State
   * @param state StrategyState
   * @param infos vector<string>, info_a, info_b, info_c.
   */
  void update_strategy_state(longfist::types::StrategyStateUpdate &state_update) override;

  yijinjing::data::location_ptr get_location(uint32_t location_uid) override;

  std::shared_ptr<wingchun::factor::StreamDataBatcher> batch_streaming() override;

protected:
  void on_start() override;
  void prepare(const event_ptr &event) override;
  void post_stop() override;

  yijinjing::data::location_ptr find_td_location(const std::string &source, const std::string &account,
                                                 bool check_exist = true) const;

  uint64_t get_order_id(const yijinjing::journal::writer_ptr &writer, uint32_t dest) const;

  template <typename DataType>
  void parse_then_write_in_timer(const nlohmann::json &config_obj, const yijinjing::journal::writer_ptr &writer) {
    try {
      if (not config_obj.contains(DataType::type_name.c_str()))
        return;
      auto state_config_obj = config_obj[DataType::type_name.c_str()];
      for (auto time_it = state_config_obj.begin(); time_it != state_config_obj.end(); ++time_it) {
        int64_t update_time =
            time_it.key() == "default" ? now() : yijinjing::time::strptime(time_it.key(), "%Y-%m-%d %H:%M:%S");
        if (update_time < now()) {
          SPDLOG_WARN("update_time={} of state data in backtest_config is earlier than begin_time {}", time_it.key(),
                      yijinjing::time::strftime(now()));
          continue;
        }
        for (auto it = time_it.value().begin(); it != time_it.value().end(); ++it) {
          auto state = DataType(nlohmann::to_string(it.value()));
          add_timer(update_time, [this, state, writer](const auto &e) {
            writer->write_raw_at_as(now(), now(), app_.get_home_uid(), yijinjing::data::location::PUBLIC, state.tag,
                                    reinterpret_cast<uintptr_t>(&state), sizeof(state));
          });
        }
      }
    } catch (const std::exception &e) {
      SPDLOG_ERROR("parse the {} data in backtest_config error: {}", DataType::type_name.c_str(), e.what());
      throw wingchun_error(e.what());
    }
  }

private:
  struct TimerTask {
    int32_t timer_id;
    int64_t nanotime;
    std::function<void(event_ptr)> call_back;
    TimerTask(int32_t id, int64_t nanotime, std::function<void(event_ptr)> cb)
        : timer_id(id), nanotime(nanotime), call_back(std::move(cb)){};
    bool operator<(const TimerTask &other) const { return other.nanotime < this->nanotime; }
  };

  enum class SliceState { Idle, Acquiring, Acquired, Releasing, Released };
  struct SliceReferenceState {
    SliceState state;
    int reference_count;
  };

  static std::shared_ptr<wingchun::factor::BackTestStreamDataBatcher> backtest_stream_data_batcher_;
  broker::PassiveClient broker_client_;
  book::Bookkeeper bookkeeper_;
  Matcher_ptr matcher_;
  tool::SliceIndexer_ptr from_indexer_;
  tool::SliceTool_ptr slice_tool_;
  tool::Report_ptr report_;
  int64_t time_interval_;
  const std::string backtest_config_{"{}"};
  int32_t timer_usage_count_{0};
  int32_t protected_timer_id_;

  std::vector<TimerTask> timer_tasks_{};
  void on_timer_check();
  int32_t add_timer_interval_helper(int64_t duration, int32_t timer_id, const std::function<void(event_ptr)> &callback);
  int32_t add_timer_helper(int64_t nanotime, int32_t timer_id, const std::function<void(event_ptr)> &callback);
  void init_time_events();

  std::unordered_map<yijinjing::data::location, SliceReferenceState> slice_reference_states_;
  void subscribe_slice(const yijinjing::data::location_ptr &slice_location, int64_t nanotime, int64_t offset);
  void unsubscribe_slice(const yijinjing::data::location_ptr &slice_location, int64_t nanotime, int64_t offset);
  void subscribe_helper(int64_t begin_time, const std::string &source, const std::string &instrument_id,
                        const std::string &exchange_id, int32_t data_tag);
  void subscribe_operator_helper(int64_t nanotime, const std::string &group, const std::string &name);
};

DECLARE_PTR(BacktestContext)
} // namespace kungfu::wingchun::strategy

#endif // WINGCHUN_STRATEGY_BACKTEST_H
