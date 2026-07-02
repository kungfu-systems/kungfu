// SPDX-License-Identifier: Apache-2.0

#include "py-wingchun.h"

#include <kungfu/wingchun/service/ledger.h>

using namespace kungfu::longfist::enums;
using namespace kungfu::longfist::types;
using namespace kungfu::yijinjing::data;
using namespace kungfu::yijinjing::journal;
using namespace kungfu::practice;
using namespace kungfu::wingchun::service;

namespace py = pybind11;

namespace kungfu::wingchun::pybind {
void bind_service(pybind11::module &m) {
  py::class_<Ledger, apprentice, std::shared_ptr<Ledger>>(m, "Ledger")
      .def(py::init<locator_ptr, std::string &, std::string &, mode, bool, const std::string &>())
      .def_property_readonly("io_device", &Ledger::get_io_device)
      .def_property_readonly("usable", &Ledger::is_usable)
      .def_property_readonly("bookkeeper", &Ledger::get_bookkeeper, py::return_value_policy::reference);
}
} // namespace kungfu::wingchun::pybind