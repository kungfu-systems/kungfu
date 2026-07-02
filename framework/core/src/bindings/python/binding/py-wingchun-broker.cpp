// SPDX-License-Identifier: Apache-2.0

#include "py-wingchun.h"

#include <pybind11/functional.h>
#include <pybind11/stl.h>

#include <kungfu/wingchun/broker/marketdata.h>
#include <kungfu/wingchun/broker/trader.h>

using namespace kungfu::longfist;
using namespace kungfu::longfist::types;
using namespace kungfu::longfist::enums;
using namespace kungfu::yijinjing;
using namespace kungfu::yijinjing::data;
using namespace kungfu::yijinjing::journal;
using namespace kungfu::wingchun;
using namespace kungfu::wingchun::broker;

namespace py = pybind11;

namespace kungfu::wingchun::pybind {
class PyBrokerVendor : public BrokerVendor {
public:
  using BrokerVendor::BrokerVendor;

protected:
  BrokerService_ptr get_service() override { PYBIND11_OVERLOAD_PURE(BrokerService_ptr, BrokerVendor, get_service); }
};

class PyMarketData : public MarketData {
public:
  using MarketData::MarketData;

  bool subscribe(const std::vector<InstrumentKey> &instruments) override {
    PYBIND11_OVERLOAD_PURE(bool, MarketData, subscribe, instruments);
  }

  bool subscribe_all() override { PYBIND11_OVERLOAD(bool, MarketData, subscribe_all); }

  bool unsubscribe(const std::vector<InstrumentKey> &instruments) override {
    PYBIND11_OVERLOAD_PURE(bool, MarketData, unsubscribe, instruments);
  }

  void on_start() override { PYBIND11_OVERLOAD(void, MarketData, on_start); }
};

class PyTrader : public Trader {
public:
  using Trader::Trader;

  [[nodiscard]] AccountType get_account_type() const override {
    PYBIND11_OVERLOAD_PURE(const AccountType, Trader, get_account_type);
  }

  bool insert_order(const event_ptr &event) override { PYBIND11_OVERLOAD_PURE(bool, Trader, insert_order, event); }

  bool insert_block_order(const event_ptr &event, const BlockMessage &block_message) override {
    PYBIND11_OVERLOAD(bool, Trader, insert_block_order, event, block_message);
  }

  bool insert_batch_orders(const event_ptr &event, const OrderInputs &order_inputs) override {
    PYBIND11_OVERLOAD(bool, Trader, insert_batch_orders, event, order_inputs);
  }

  bool insert_order_trigger(const event_ptr &event) override {
    PYBIND11_OVERLOAD(bool, Trader, insert_order_trigger, event);
  }

  bool insert_algo_order(const event_ptr &event) override { PYBIND11_OVERLOAD(bool, Trader, insert_algo_order, event); }

  bool cancel_order(const event_ptr &event) override { PYBIND11_OVERLOAD_PURE(bool, Trader, cancel_order, event); }

  bool cancel_order_trigger(const event_ptr &event) override {
    PYBIND11_OVERLOAD(bool, Trader, cancel_order_trigger, event);
  }

  bool cancel_algo_order(const event_ptr &event) override { PYBIND11_OVERLOAD(bool, Trader, cancel_algo_order, event); }

  bool toggle_algo_order(const event_ptr &event) override { PYBIND11_OVERLOAD(bool, Trader, toggle_algo_order, event); }

  bool on_custom_event(const event_ptr &event) override { PYBIND11_OVERLOAD(bool, Trader, on_custom_event, event); }

  void on_time_key_value(const kungfu::event_ptr &event) override {
    PYBIND11_OVERLOAD(void, Trader, on_time_key_value, event);
  }

  bool req_position() override { PYBIND11_OVERLOAD_PURE(bool, Trader, req_position); }

  bool req_account() override { PYBIND11_OVERLOAD_PURE(bool, Trader, req_account); }

  bool req_order_trigger() override { PYBIND11_OVERLOAD(bool, Trader, req_order_trigger); }

  bool req_contract() override { PYBIND11_OVERLOAD(bool, Trader, req_contract); }

  bool req_algo_order(const event_ptr &event) override { PYBIND11_OVERLOAD(bool, Trader, req_algo_order, event); }

  bool req_history_order(const event_ptr &event) override { PYBIND11_OVERLOAD(bool, Trader, req_history_order, event); }

  bool req_history_trade(const event_ptr &event) override { PYBIND11_OVERLOAD(bool, Trader, req_history_trade, event); }

  void on_recover() override { PYBIND11_OVERLOAD(void, Trader, on_recover); }

  void on_start() override { PYBIND11_OVERLOAD(void, Trader, on_start); }

  void on_exit() override { PYBIND11_OVERLOAD(void, Trader, on_exit); }
};

void bind_broker(pybind11::module &m) {
  py::class_<BrokerVendor, PyBrokerVendor, kungfu::practice::apprentice, std::shared_ptr<BrokerVendor>>(
      m, "BrokerVendor")
      .def(py::init<location_ptr, bool, const std::string &>());

  py::class_<MarketData, PyMarketData, std::shared_ptr<MarketData>>(m, "MarketData")
      .def(py::init<BrokerVendor &>())
      .def_property_readonly("state", &MarketData::get_state)
      .def_property_readonly("runtime_folder", &MarketData::get_runtime_folder)
      .def_property_readonly("config", &MarketData::get_config)
      .def_property_readonly("home", &MarketData::get_home, py::return_value_policy::reference)
      .def("on_start", &MarketData::on_start)
      .def("now", &MarketData::now)
      .def("get_writer", &MarketData::get_writer)
      .def("has_writer", &MarketData::has_writer)
      .def("add_timer", &MarketData::add_timer)
      .def("add_time_interval", &MarketData::add_time_interval)
      .def("clear_timer", &MarketData::clear_timer)
      .def("request_deregister", &MarketData::request_deregister)
      .def("update_broker_state", &MarketData::update_broker_state)
      .def("subscribe", &MarketData::subscribe)
      .def("subscribe_all", &MarketData::subscribe_all)
      .def("unsubscribe", &MarketData::unsubscribe)
      .def("get_vendor", &MarketData::get_vendor);

  py::class_<Trader, PyTrader, std::shared_ptr<Trader>>(m, "Trader")
      .def(py::init<BrokerVendor &>())
      .def_property_readonly("state", &Trader::get_state)
      .def_property_readonly("runtime_folder", &Trader::get_runtime_folder)
      .def_property_readonly("config", &Trader::get_config)
      .def_property_readonly("home", &Trader::get_home, py::return_value_policy::reference)
      .def_property_readonly("orders", &Trader::get_orders, py::return_value_policy::reference)
      .def_property_readonly("order_actions", &Trader::get_order_actions, py::return_value_policy::reference)
      .def_property_readonly("trades", &Trader::get_trades, py::return_value_policy::reference)
      .def_property_readonly("order_triggers", &Trader::get_order_triggers, py::return_value_policy::reference)
      .def_property_readonly("order_trigger_actions", &Trader::get_order_trigger_actions,
                             py::return_value_policy::reference)
      .def_property_readonly("algo_orders", &Trader::get_algo_orders, py::return_value_policy::reference)
      .def_property_readonly("algo_order_actions", &Trader::get_algo_order_actions, py::return_value_policy::reference)
      .def("on_start", &Trader::on_start)
      .def("on_recover", &Trader::on_recover)
      .def("on_time_key_value", &Trader::on_time_key_value)
      .def("on_custom_event", &Trader::on_custom_event)
      .def("on_risk_setting", &Trader::on_risk_setting)
      .def("now", &Trader::now)
      .def("get_writer", &Trader::get_writer)
      .def("has_writer", &Trader::has_writer)
      .def("get_asset_writer", &Trader::get_asset_writer)
      .def("get_position_writer", &Trader::get_position_writer)
      .def("has_order", &Trader::has_order)
      .def("get_order", &Trader::get_order)
      .def("has_order_trigger", &Trader::has_order_trigger)
      .def("get_order_trigger", &Trader::get_order_trigger)
      .def("has_algo_order", &Trader::has_algo_order)
      .def("get_algo_order", &Trader::get_algo_order)
      .def("enable_asset_sync", &Trader::enable_asset_sync)
      .def("enable_positions_sync", &Trader::enable_positions_sync)
      .def("get_account_type", &Trader::get_account_type)
      .def("add_timer", &Trader::add_timer)
      .def("add_time_interval", &Trader::add_time_interval)
      .def("clear_timer", &Trader::clear_timer)
      .def("request_deregister", &Trader::request_deregister)
      .def("update_broker_state", &Trader::update_broker_state)
      .def("insert_order", &Trader::insert_order)
      .def("insert_block_order", &Trader::insert_block_order)
      .def("insert_order_trigger", &Trader::insert_order_trigger)
      .def("insert_algo_order", &Trader::insert_algo_order)
      .def("insert_batch_orders", &Trader::insert_batch_orders)
      .def("cancel_order", &Trader::cancel_order)
      .def("cancel_order_trigger", &Trader::cancel_order_trigger)
      .def("cancel_algo_order", &Trader::cancel_algo_order)
      .def("toggle_algo_order", &Trader::toggle_algo_order)
      .def("req_history_order", &Trader::req_history_order)
      .def("req_history_trade", &Trader::req_history_trade)
      .def("req_account", &Trader::req_account)
      .def("req_position", &Trader::req_position)
      .def("get_vendor", &Trader::get_vendor);

  py::class_<MarketDataVendor, BrokerVendor, std::shared_ptr<MarketDataVendor>>(m, "MarketDataVendor")
      .def(py::init<locator_ptr, const std::string &, const std::string &, mode, bool, const std::string &>())
      .def("set_service", &MarketDataVendor::set_service)
      .def("get_arguments", &MarketDataVendor::get_arguments);

  py::class_<TraderVendor, BrokerVendor, std::shared_ptr<TraderVendor>>(m, "TraderVendor")
      .def(py::init<locator_ptr, const std::string &, const std::string &, mode, bool, const std::string &>())
      .def("set_service", &TraderVendor::set_service)
      .def("get_arguments", &TraderVendor::get_arguments);
}
} // namespace kungfu::wingchun::pybind