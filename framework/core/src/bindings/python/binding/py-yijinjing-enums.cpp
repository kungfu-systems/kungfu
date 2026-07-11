// SPDX-License-Identifier: Apache-2.0

#include "py-yijinjing.h"

#include <kungfu/yijinjing/schema/registry.h>

using namespace kungfu::yijinjing::enums;

namespace py = pybind11;

namespace kungfu::yijinjing::pybind {

void bind_enums(py::module &m) {
  auto m_enums = m.def_submodule("enums");

  py::enum_<mode>(m_enums, "mode", py::arithmetic(), "Kungfu Run Mode")
      .value("LIVE", mode::LIVE)
      .value("DATA", mode::DATA)
      .value("REPLAY", mode::REPLAY)
      .value("BACKTEST", mode::BACKTEST)
      .export_values();
  m_enums.def("get_mode_name", &get_mode_name);
  m_enums.def("get_mode_by_name", &get_mode_by_name);

  py::enum_<location_role>(m_enums, "location_role", py::arithmetic(), "Kungfu Location Role")
      .value("SOURCE", location_role::SOURCE)
      .value("SINK", location_role::SINK)
      .value("ACTOR", location_role::ACTOR)
      .value("SYSTEM", location_role::SYSTEM)
      .value("SERVICE", location_role::SERVICE)
      .export_values();
  m_enums.def("get_location_role_name", &get_location_role_name);
  m_enums.def("get_location_role_by_name", &get_location_role_by_name);

  py::enum_<layout>(m_enums, "layout", py::arithmetic(), "Kungfu Data Layout")
      .value("JOURNAL", layout::JOURNAL)
      .value("SQLITE", layout::SQLITE)
      .value("NANOMSG", layout::NANOMSG)
      .value("LOG", layout::LOG)
      .export_values();
  m_enums.def("get_layout_name", &get_layout_name);

  py::enum_<OperatorState>(m_enums, "OperatorState", py::arithmetic())
      .value("Pending", OperatorState::Pending)
      .value("DisConnected", OperatorState::DisConnected)
      .value("Connected", OperatorState::Connected)
      .value("Ready", OperatorState::Ready)
      .export_values()
      .def("__eq__", [](const OperatorState &a, int b) { return static_cast<int>(a) == b; });

  py::enum_<HistoryDataType>(m_enums, "HistoryDataType", py::arithmetic())
      .value("Normal", HistoryDataType::Normal)
      .value("PageEnd", HistoryDataType::PageEnd)
      .value("TotalEnd", HistoryDataType::TotalEnd)
      .export_values()
      .def("__eq__", [](const HistoryDataType &a, int b) { return static_cast<int>(a) == b; });

  py::class_<AssembleMode>(m_enums, "AssembleMode")
      .def(py::init<>())
      .def_readonly_static("Channel", &AssembleMode::Channel)
      .def_readonly_static("Write", &AssembleMode::Write)
      .def_readonly_static("Read", &AssembleMode::Read)
      .def_readonly_static("Public", &AssembleMode::Public)
      .def_readonly_static("Sync", &AssembleMode::Sync)
      .def_readonly_static("All", &AssembleMode::All);

  py::enum_<PageStatus>(m_enums, "PageStatus", py::arithmetic())
      .value("Normal", PageStatus::Normal)
      .value("PreOpen", PageStatus::PreOpen)
      .export_values()
      .def("__eq__", [](const PageStatus &a, int b) { return static_cast<int>(a) == b; });

  py::enum_<FrameDataType>(m_enums, "FrameDataType", py::arithmetic())
      .value("Raw", FrameDataType::Raw)
      .value("Json", FrameDataType::Json)
      .value("Unknown", FrameDataType::Unknown)
      .export_values()
      .def("__eq__", [](const FrameDataType &a, int b) { return static_cast<int>(a) == b; });

  py::enum_<EpisodeStatus>(m_enums, "EpisodeStatus", py::arithmetic())
      .value("Open", EpisodeStatus::Open)
      .value("Ended", EpisodeStatus::Ended)
      .value("Aborted", EpisodeStatus::Aborted)
      .value("Tombstoned", EpisodeStatus::Tombstoned)
      .export_values()
      .def("__eq__", [](const EpisodeStatus &a, int b) { return static_cast<int>(a) == b; });

  py::enum_<EpisodeRefKind>(m_enums, "EpisodeRefKind", py::arithmetic())
      .value("InputFrame", EpisodeRefKind::InputFrame)
      .value("Payload", EpisodeRefKind::Payload)
      .value("Schema", EpisodeRefKind::Schema)
      .value("Episode", EpisodeRefKind::Episode)
      .export_values()
      .def("__eq__", [](const EpisodeRefKind &a, int b) { return static_cast<int>(a) == b; });

  py::enum_<Priority>(m_enums, "Priority", py::arithmetic())
      .value("Low", Priority::Low)
      .value("Medium", Priority::Medium)
      .value("High", Priority::High)
      .export_values()
      .def("__eq__", [](const Priority &a, int b) { return static_cast<int>(a) == b; });
}
} // namespace kungfu::yijinjing::pybind
