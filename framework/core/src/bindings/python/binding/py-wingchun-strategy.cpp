// SPDX-License-Identifier: Apache-2.0

#include <pybind11/functional.h>
#include <pybind11/stl.h>

#include <kungfu/wingchun/strategy/context.h>
#include <kungfu/wingchun/strategy/runner.h>

using namespace kungfu::longfist;
using namespace kungfu::longfist::types;
using namespace kungfu::longfist::enums;
using namespace kungfu::yijinjing;
using namespace kungfu::yijinjing::data;
using namespace kungfu::yijinjing::journal;
using namespace kungfu::wingchun;
using namespace kungfu::wingchun::book;

namespace py = pybind11;

namespace kungfu::wingchun::pybind {

class PyRunner : public strategy::Runner {
public:
  using strategy::Runner::Runner;
};

class PyStrategy : public strategy::Strategy {
public:
  using strategy::Strategy::Strategy; // Inherit constructors

  void pre_start(strategy::Context_ptr &context) override {
    PYBIND11_OVERLOAD(void, strategy::Strategy, pre_start, context);
  }

  void post_start(strategy::Context_ptr &context) override {
    PYBIND11_OVERLOAD(void, strategy::Strategy, post_start, context);
  }

  void pre_stop(strategy::Context_ptr &context) override {
    PYBIND11_OVERLOAD(void, strategy::Strategy, pre_stop, context);
  }

  void post_stop(strategy::Context_ptr &context) override {
    PYBIND11_OVERLOAD(void, strategy::Strategy, post_stop, context);
  }

  void on_quote(strategy::Context_ptr &context, const Quote &quote,
                const kungfu::yijinjing::data::location_ptr &location, uint32_t dest) override {
    PYBIND11_OVERLOAD(void, strategy::Strategy, on_quote, context, quote, location, dest);
  }

  void on_tree(strategy::Context_ptr &context, const Tree &tree, const kungfu::yijinjing::data::location_ptr &location,
               uint32_t dest) override {
    PYBIND11_OVERLOAD(void, strategy::Strategy, on_tree, context, tree, location, dest);
  }

  void on_depth(strategy::Context_ptr &context, const Depth &depth,
                const kungfu::yijinjing::data::location_ptr &location, uint32_t dest) override {
    PYBIND11_OVERLOAD(void, strategy::Strategy, on_depth, context, depth, location, dest);
  }

  void on_tick(strategy::Context_ptr &context, const Tick &tick, const kungfu::yijinjing::data::location_ptr &location,
               uint32_t dest) override {
    PYBIND11_OVERLOAD(void, strategy::Strategy, on_tick, context, tick, location, dest);
  }

  void on_entrust(strategy::Context_ptr &context, const Entrust &entrust,
                  const kungfu::yijinjing::data::location_ptr &location, uint32_t dest) override {
    PYBIND11_OVERLOAD(void, strategy::Strategy, on_entrust, context, entrust, location, dest);
  }

  void on_transaction(strategy::Context_ptr &context, const Transaction &transaction,
                      const kungfu::yijinjing::data::location_ptr &location, uint32_t dest) override {
    PYBIND11_OVERLOAD(void, strategy::Strategy, on_transaction, context, transaction, location, dest);
  }

  void on_synthetic_data(strategy::Context_ptr &context, const SyntheticData &synthetic_data,
                         const kungfu::yijinjing::data::location_ptr &location, uint32_t dest) override {
    PYBIND11_OVERLOAD(void, strategy::Strategy, on_synthetic_data, context, synthetic_data, location, dest);
  }

  void on_order(strategy::Context_ptr &context, const Order &order,
                const kungfu::yijinjing::data::location_ptr &location, uint32_t dest) override {
    PYBIND11_OVERLOAD(void, strategy::Strategy, on_order, context, order, location, dest);
  }

  void on_order_trigger(strategy::Context_ptr &context, const OrderTrigger &order_trigger,
                        const kungfu::yijinjing::data::location_ptr &location, uint32_t dest) override {
    PYBIND11_OVERLOAD(void, strategy::Strategy, on_order_trigger, context, order_trigger, location, dest);
  }

  void on_order_action_error(strategy::Context_ptr &context, const OrderActionError &error,
                             const kungfu::yijinjing::data::location_ptr &location, uint32_t dest) override {
    PYBIND11_OVERLOAD(void, strategy::Strategy, on_order_action_error, context, error, location, dest);
  }

  void on_order_trigger_action_error(strategy::Context_ptr &context, const OrderTriggerActionError &error,
                                     const kungfu::yijinjing::data::location_ptr &location, uint32_t dest) override {
    PYBIND11_OVERLOAD(void, strategy::Strategy, on_order_trigger_action_error, context, error, location, dest);
  }

  void on_trade(strategy::Context_ptr &context, const Trade &trade,
                const kungfu::yijinjing::data::location_ptr &location, uint32_t dest) override {
    PYBIND11_OVERLOAD(void, strategy::Strategy, on_trade, context, trade, location, dest);
  }

  void on_algo_order(strategy::Context_ptr &context, const AlgoOrder &algo_order,
                     const kungfu::yijinjing::data::location_ptr &location, uint32_t dest) override {
    PYBIND11_OVERLOAD(void, strategy::Strategy, on_algo_order, context, algo_order, location, dest);
  }

  void on_algo_order_action_error(strategy::Context_ptr &context, const AlgoOrderActionError &error,
                                  const kungfu::yijinjing::data::location_ptr &location, uint32_t dest) override {
    PYBIND11_OVERLOAD(void, strategy::Strategy, on_algo_order_action_error, context, error, location, dest);
  }

  void on_deregister(strategy::Context_ptr &context, const Deregister &deregister,
                     const kungfu::yijinjing::data::location_ptr &location) override {
    PYBIND11_OVERLOAD(void, strategy::Strategy, on_deregister, context, deregister, location);
  }

  void on_broker_state_change(strategy::Context_ptr &context, const BrokerStateUpdate &brokerStateUpdate,
                              const kungfu::yijinjing::data::location_ptr &location) override {
    PYBIND11_OVERLOAD(void, strategy::Strategy, on_broker_state_change, context, brokerStateUpdate, location);
  }

  void on_operator_state_change(strategy::Context_ptr &context, const OperatorStateUpdate &operator_state_update,
                                const kungfu::yijinjing::data::location_ptr &location) override {
    PYBIND11_OVERLOAD(void, strategy::Strategy, on_operator_state_change, context, operator_state_update, location);
  }

  void on_history_order(strategy::Context_ptr &context, const HistoryOrder &history_order,
                        const kungfu::yijinjing::data::location_ptr &location, uint32_t dest) override {
    PYBIND11_OVERLOAD(void, strategy::Strategy, on_history_order, context, history_order, location, dest);
  }

  void on_history_trade(strategy::Context_ptr &context, const HistoryTrade &history_trade,
                        const kungfu::yijinjing::data::location_ptr &location, uint32_t dest) override {
    PYBIND11_OVERLOAD(void, strategy::Strategy, on_history_trade, context, history_trade, location, dest);
  }

  void on_req_history_order_error(strategy::Context_ptr &context, const RequestHistoryOrderError &error,
                                  const kungfu::yijinjing::data::location_ptr &location, uint32_t dest) override {
    PYBIND11_OVERLOAD(void, strategy::Strategy, on_req_history_order_error, context, error, location, dest);
  }

  void on_req_history_trade_error(strategy::Context_ptr &context, const RequestHistoryTradeError &error,
                                  const kungfu::yijinjing::data::location_ptr &location, uint32_t dest) override {
    PYBIND11_OVERLOAD(void, strategy::Strategy, on_req_history_trade_error, context, error, location, dest);
  }

  void on_position_sync_reset(strategy::Context_ptr &context, const Book &old_book, const Book &new_book) override {
    PYBIND11_OVERLOAD(void, strategy::Strategy, on_position_sync_reset, context, old_book, new_book);
  }

  void on_asset_sync_reset(strategy::Context_ptr &context, const Asset &old_asset, const Asset &new_asset) override {
    PYBIND11_OVERLOAD(void, strategy::Strategy, on_asset_sync_reset, context, old_asset, new_asset);
  }

  void on_custom_data(strategy::Context_ptr &context, uint32_t msg_type, const std::vector<uint8_t> &data,
                      uint32_t length, const kungfu::yijinjing::data::location_ptr &location, uint32_t dest) override {
    PYBIND11_OVERLOAD(void, strategy::Strategy, on_custom_data, context, msg_type, data, length, location, dest);
  }
};

void bind_strategy(pybind11::module &m) {

  py::class_<strategy::Runner, PyRunner, kungfu::practice::apprentice, std::shared_ptr<strategy::Runner>>(
      m, "Runner")
      .def(py::init<kungfu::yijinjing::data::locator_ptr, const std::string &, const std::string &,
                    longfist::enums::mode, bool, const std::string &>())
      .def_property_readonly("context", &strategy::Runner::get_context)
      .def("set_matcher", &strategy::Runner::set_matcher)
      .def("set_from_indexer", &strategy::Runner::set_from_indexer)
      .def("set_to_indexer", &strategy::Runner::set_to_indexer)
      .def("set_time_interval", &strategy::Runner::set_time_interval)
      .def("set_report", &strategy::Runner::set_report)
      .def("set_backtest_config", &strategy::Runner::set_backtest_config)
      .def("set_strategy_dir", &strategy::Runner::set_strategy_dir)
      .def("add_strategy", &strategy::Runner::add_strategy);

  py::class_<strategy::Context, std::shared_ptr<strategy::Context>>(m, "Context")
      .def_property_readonly("config", &strategy::Context::get_config, py::return_value_policy::reference)
      .def_property_readonly("arguments", &strategy::Context::get_arguments, py::return_value_policy::reference)
      .def_property_readonly("strategy_dir", &strategy::Context::get_strategy_dir, py::return_value_policy::reference)
      .def_property_readonly("bookkeeper", &strategy::Context::get_bookkeeper, py::return_value_policy::reference)
      .def("now", &strategy::Context::now)
      .def("is_started", &strategy::Context::is_started)
      .def("add_timer", &strategy::Context::add_timer)
      .def("add_time_interval", &strategy::Context::add_time_interval)
      .def("clear_timer", &strategy::Context::clear_timer)
      .def("add_account", &strategy::Context::add_account)
      .def("subscribe", &strategy::Context::subscribe)
      .def("unsubscribe", &strategy::Context::unsubscribe)
      .def("subscribe_all", &strategy::Context::subscribe_all, py::arg("source"),
           py::arg("market_type") = MarketType::All, py::arg("instrument_type") = SubscribeInstrumentType::All,
           py::arg("data_type") = SubscribeDataType::All)
      .def("subscribe_operator", &strategy::Context::subscribe_operator)
      .def("insert_order_input", &strategy::Context::insert_order_input)
      .def("insert_order", &strategy::Context::insert_order, py::arg("instrument_id"), py::arg("exchange"),
           py::arg("source"), py::arg("account"), py::arg("limit_price"), py::arg("volume"), py::arg("type"),
           py::arg("side"), py::arg("offset") = Offset::Open, py::arg("hedge_flag") = HedgeFlag::Speculation,
           py::arg("is_swap") = false, py::arg("block_id") = 0, py::arg("parent_id") = 0, py::arg("contract_id") = "")
      .def("insert_block_message", &strategy::Context::insert_block_message, py::arg("source"), py::arg("account"),
           py::arg("opponent_seat"), py::arg("match_number"), py::arg("is_specific") = false)
      .def("insert_order_trigger", &strategy::Context::insert_order_trigger, py::arg("instrument_id"),
           py::arg("exchange"), py::arg("source"), py::arg("account"), py::arg("limit_price"), py::arg("volume"),
           py::arg("type"), py::arg("side"), py::arg("offset") = Offset::Open,
           py::arg("trigger_type") = longfist::enums::OrderTriggerType::ParkedOrder, py::arg("stop_price") = 0,
           py::arg("hedge_flag") = HedgeFlag::Speculation, py::arg("is_swap") = false)
      .def("insert_batch_orders", &strategy::Context::insert_batch_orders)
      .def("insert_array_orders", &strategy::Context::insert_array_orders)
      .def("insert_algo_order", &strategy::Context::insert_algo_order, py::arg("instrument_id"), py::arg("exchange_id"),
           py::arg("source"), py::arg("account"), py::arg("begin_time"), py::arg("end_time"), py::arg("volume"),
           py::arg("type"), py::arg("side"), py::arg("offset"), py::arg("algo_type_id"), py::arg("algo_id"),
           py::arg("args"), py::arg("is_local") = false, py::arg("baskrt_uid") = 0,
           py::arg("price_level") = PriceLevel::Last, py::arg("price_offset") = 0)
      .def("update_algo_order_volume", &strategy::Context::update_algo_order_volume, py::arg("origin_order_id"),
           py::arg("source"), py::arg("account"), py::arg("volume"))
      .def("cancel_order", &strategy::Context::cancel_order, py::arg("order_id"),
           py::arg("action_flag") = OrderActionFlag::Cancel)
      .def("cancel_order_trigger", &strategy::Context::cancel_order_trigger)
      .def("cancel_algo_order", &strategy::Context::cancel_algo_order)
      .def("toggle_algo_order", &strategy::Context::toggle_algo_order)
      .def("req_history_order", &strategy::Context::req_history_order, py::arg("source"), py::arg("account"),
           py::arg("query_num") = 0)
      .def("req_history_trade", &strategy::Context::req_history_trade, py::arg("source"), py::arg("account"),
           py::arg("query_num") = 0)
      .def("hold_book", &strategy::Context::hold_book)
      .def("hold_positions", &strategy::Context::hold_positions)
      .def("is_book_held", &strategy::Context::is_book_held)
      .def("is_positions_held", &strategy::Context::is_positions_held)
      .def("is_bypass_accounting", &strategy::Context::is_bypass_accounting)
      .def("bypass_accounting", &strategy::Context::bypass_accounting)
      .def("update_strategy_state", &strategy::Context::update_strategy_state)
      .def("set_resume_policy", &strategy::Context::set_resume_policy)
      .def("attach_orderbooks", &strategy::Context::attach_orderbooks)
      .def("batch_streaming", &strategy::Context::batch_streaming)
      .def("attach_factor_cache", &strategy::Context::attach_factor_cache)
      .def("req_deregister", &strategy::Context::req_deregister);

  py::class_<strategy::Matcher, std::shared_ptr<strategy::Matcher>>(m, "Matcher");

  py::class_<strategy::Strategy, PyStrategy, strategy::Strategy_ptr>(m, "Strategy")
      .def(py::init())
      .def("pre_start", &strategy::Strategy::pre_start)
      .def("post_start", &strategy::Strategy::post_start)
      .def("pre_stop", &strategy::Strategy::pre_stop)
      .def("post_stop", &strategy::Strategy::post_stop)
      .def("on_quote", &strategy::Strategy::on_quote)
      .def("on_tree", &strategy::Strategy::on_tree)
      .def("on_entrust", &strategy::Strategy::on_entrust)
      .def("on_transaction", &strategy::Strategy::on_transaction)
      .def("on_depth", &strategy::Strategy::on_depth)
      .def("on_tick", &strategy::Strategy::on_tick)
      .def("on_synthetic_data", &strategy::Strategy::on_synthetic_data)
      .def("on_order", &strategy::Strategy::on_order)
      .def("on_order_trigger", &strategy::Strategy::on_order_trigger)
      .def("on_algo_order", &strategy::Strategy::on_algo_order)
      .def("on_order_action_error", &strategy::Strategy::on_order_action_error)
      .def("on_order_trigger_action_error", &strategy::Strategy::on_order_trigger_action_error)
      .def("on_algo_order_action_error", &strategy::Strategy::on_algo_order_action_error)
      .def("on_trade", &strategy::Strategy::on_trade)
      .def("on_position_sync_reset", &strategy::Strategy::on_position_sync_reset)
      .def("on_asset_sync_reset", &strategy::Strategy::on_asset_sync_reset)
      .def("on_deregister ", &strategy::Strategy::on_deregister)
      .def("on_broker_state_change ", &strategy::Strategy::on_broker_state_change)
      .def("on_operator_state_change ", &strategy::Strategy::on_operator_state_change)
      .def("on_history_order", &strategy::Strategy::on_history_order)
      .def("on_history_trade", &strategy::Strategy::on_history_trade)
      .def("on_req_history_order_error", &strategy::Strategy::on_req_history_order_error)
      .def("on_req_history_trade_error", &strategy::Strategy::on_req_history_trade_error)
      .def("on_custom_data", &strategy::Strategy::on_custom_data);
}
} // namespace kungfu::wingchun::pybind