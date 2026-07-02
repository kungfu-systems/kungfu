// SPDX-License-Identifier: Apache-2.0

#include "py-wingchun.h"

#include <pybind11/functional.h>
#include <pybind11/stl.h>

#include <kungfu/wingchun/operator/context.h>
#include <kungfu/wingchun/operator/runner.h>

using namespace kungfu::longfist;
using namespace kungfu::longfist::types;
using namespace kungfu::longfist::enums;
using namespace kungfu::yijinjing;
using namespace kungfu::yijinjing::data;
using namespace kungfu::yijinjing::journal;
using namespace kungfu::wingchun;

namespace py = pybind11;

namespace kungfu::wingchun::pybind {

class PyOpRunner : public op::Runner {
public:
  using op::Runner::Runner;
};

class PyOperator : public op::Operator {
public:
  using op::Operator::Operator; // Inherit constructors

  void pre_start(op::Context_ptr &context) override { PYBIND11_OVERLOAD(void, op::Operator, pre_start, context); }

  void post_start(op::Context_ptr &context) override { PYBIND11_OVERLOAD(void, op::Operator, post_start, context); }

  void pre_stop(op::Context_ptr &context) override { PYBIND11_OVERLOAD(void, op::Operator, pre_stop, context); }

  void post_stop(op::Context_ptr &context) override { PYBIND11_OVERLOAD(void, op::Operator, post_stop, context); }

  void on_quote(op::Context_ptr &context, const Quote &quote, const kungfu::yijinjing::data::location_ptr &location,
                uint32_t dest) override {
    PYBIND11_OVERLOAD(void, op::Operator, on_quote, context, quote, location, dest);
  }

  void on_entrust(op::Context_ptr &context, const Entrust &entrust,
                  const kungfu::yijinjing::data::location_ptr &location, uint32_t dest) override {
    PYBIND11_OVERLOAD(void, op::Operator, on_entrust, context, entrust, location, dest);
  }

  void on_transaction(op::Context_ptr &context, const Transaction &transaction,
                      const kungfu::yijinjing::data::location_ptr &location, uint32_t dest) override {
    PYBIND11_OVERLOAD(void, op::Operator, on_transaction, context, transaction, location, dest);
  }

  void on_tree(op::Context_ptr &context, const Tree &tree, const kungfu::yijinjing::data::location_ptr &location,
               uint32_t dest) override {
    PYBIND11_OVERLOAD(void, op::Operator, on_tree, context, tree, location, dest);
  }

  void on_depth(op::Context_ptr &context, const Depth &depth, const kungfu::yijinjing::data::location_ptr &location,
                uint32_t dest) override {
    PYBIND11_OVERLOAD(void, op::Operator, on_depth, context, depth, location, dest);
  }

  void on_tick(op::Context_ptr &context, const Tick &tick, const kungfu::yijinjing::data::location_ptr &location,
               uint32_t dest) override {
    PYBIND11_OVERLOAD(void, op::Operator, on_tick, context, tick, location, dest);
  }

  void on_synthetic_data(op::Context_ptr &context, const SyntheticData &synthetic_data,
                         const kungfu::yijinjing::data::location_ptr &location, uint32_t dest) override {
    PYBIND11_OVERLOAD(void, op::Operator, on_synthetic_data, context, synthetic_data, location, dest);
  }

  void on_deregister(op::Context_ptr &context, const Deregister &deregister,
                     const kungfu::yijinjing::data::location_ptr &location) override {
    PYBIND11_OVERLOAD(void, op::Operator, on_deregister, context, deregister, location);
  }

  void on_broker_state_change(op::Context_ptr &context, const BrokerStateUpdate &broker_state_update,
                              const kungfu::yijinjing::data::location_ptr &location) override {
    PYBIND11_OVERLOAD(void, op::Operator, on_broker_state_change, context, broker_state_update, location);
  }

  void on_operator_state_change(op::Context_ptr &context, const OperatorStateUpdate &operator_state_update,
                                const kungfu::yijinjing::data::location_ptr &location) override {
    PYBIND11_OVERLOAD(void, op::Operator, on_operator_state_change, context, operator_state_update, location);
  }
};

void bind_operator(pybind11::module &m) {

  py::class_<op::Runner, PyOpRunner, kungfu::practice::apprentice, std::shared_ptr<op::Runner>>(m,
                                                                                                           "OpRunner")
      .def(py::init<kungfu::yijinjing::data::locator_ptr, const std::string &, const std::string &,
                    longfist::enums::mode, bool, const std::string &>())
      .def_property_readonly("context", &op::Runner::get_context)
      .def("set_from_indexer", &op::Runner::set_from_indexer)
      .def("set_to_indexer", &op::Runner::set_to_indexer)
      .def("set_report", &op::Runner::set_report)
      .def("set_time_interval", &op::Runner::set_time_interval)
      .def("set_backtest_config", &op::Runner::set_backtest_config)
      .def("set_operator_dir", &op::Runner::set_operator_dir)
      .def("add_operator", &op::Runner::add_operator);

  py::class_<op::Context, std::shared_ptr<op::Context>>(m, "OpContext")
      .def_property_readonly("config", &op::Context::get_config, py::return_value_policy::reference)
      .def_property_readonly("arguments", &op::Context::get_arguments, py::return_value_policy::reference)
      .def_property_readonly("operator_dir", &op::Context::get_operator_dir, py::return_value_policy::reference)
      .def_property_readonly("bookkeeper", &op::Context::get_bookkeeper, py::return_value_policy::reference)
      .def("now", &op::Context::now)
      .def("is_started", &op::Context::is_started)
      .def("add_timer", &op::Context::add_timer)
      .def("add_time_interval", &op::Context::add_time_interval)
      .def("clear_timer", &op::Context::clear_timer)
      .def("subscribe", &op::Context::subscribe)
      .def("unsubscribe", &op::Context::unsubscribe)
      .def("subscribe_all", &op::Context::subscribe_all, py::arg("source"), py::arg("market_type") = MarketType::All,
           py::arg("instrument_type") = SubscribeInstrumentType::All, py::arg("data_type") = SubscribeDataType::All)
      .def("subscribe_operator", &op::Context::subscribe_operator)
      .def("publish_synthetic_data", &op::Context::publish_synthetic_data)
      .def("update_operator_state", &op::Context::update_operator_state)
      .def("set_resume_policy", &op::Context::set_resume_policy)
      .def("attach_orderbooks", &op::Context::attach_orderbooks)
      .def("batch_streaming", &op::Context::batch_streaming)
      .def("attach_factor_cache", &op::Context::attach_factor_cache)
      .def("req_deregister", &op::Context::req_deregister);

  py::class_<op::Operator, PyOperator, op::Operator_ptr>(m, "Operator")
      .def(py::init())
      .def("pre_start", &op::Operator::pre_start)
      .def("post_start", &op::Operator::post_start)
      .def("pre_stop", &op::Operator::pre_stop)
      .def("post_stop", &op::Operator::post_stop)
      .def("on_quote", &op::Operator::on_quote)
      .def("on_entrust", &op::Operator::on_entrust)
      .def("on_transaction", &op::Operator::on_transaction)
      .def("on_tree", &op::Operator::on_tree)
      .def("on_depth", &op::Operator::on_depth)
      .def("on_tick", &op::Operator::on_tick)
      .def("on_synthetic_data", &op::Operator::on_synthetic_data)
      .def("on_deregister ", &op::Operator::on_deregister)
      .def("on_broker_state_change ", &op::Operator::on_broker_state_change)
      .def("on_operator_state_change ", &op::Operator::on_operator_state_change);
}
} // namespace kungfu::wingchun::pybind