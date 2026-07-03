// SPDX-License-Identifier: Apache-2.0

#include "py-yijinjing.h"

#include <pybind11/stl.h>

#include <kungfu/longfist/longfist.h>
#include <kungfu/yijinjing/cache/profile.h>
#include <kungfu/yijinjing/index/session.h>
#include <kungfu/yijinjing/io.h>
#include <kungfu/yijinjing/journal/assemble.h>
#include <kungfu/yijinjing/journal/frame.h>
#include <kungfu/yijinjing/journal/journal.h>
#include <kungfu/yijinjing/log.h>
#include <kungfu/yijinjing/nanomsg/socket.h>
#include <kungfu/yijinjing/practice/apprentice.h>
#include <kungfu/yijinjing/practice/master.h>
#include <kungfu/yijinjing/schema/schema_compiler.h>
#include <kungfu/yijinjing/time.h>
#include <kungfu/yijinjing/util/util.h>

using namespace kungfu::longfist;
using namespace kungfu::longfist::types;
using namespace kungfu::longfist::enums;
using namespace kungfu::cache;
using namespace kungfu::yijinjing::data;
using namespace kungfu::index;
using namespace kungfu::yijinjing::journal;
using namespace kungfu::nanomsg;
using namespace kungfu::practice;

namespace py = pybind11;

namespace kungfu::yijinjing {
class PyLocator : public locator {
  using locator::locator;

  [[nodiscard]] bool has_env(const std::string &name) const override {
    PYBIND11_OVERLOAD(bool, locator, has_env, name);
  }

  [[nodiscard]] std::string get_env(const std::string &name) const override {
    PYBIND11_OVERLOAD(std::string, locator, get_env, name);
  }

  [[nodiscard]] std::string layout_dir(const location_ptr &location, layout l,
                                       bool create_not_exist = true) const override {
    PYBIND11_OVERLOAD(std::string, locator, layout_dir, location, l, create_not_exist);
  }

  [[nodiscard]] std::string layout_file(const location_ptr &location, layout l,
                                        const std::string &name) const override {
    PYBIND11_OVERLOAD(std::string, locator, layout_file, location, l, name);
  }

  [[nodiscard]] std::string default_to_system_db(const location_ptr &location, const std::string &name) const override {
    PYBIND11_OVERLOAD(std::string, locator, default_to_system_db, location, name);
  }

  [[nodiscard]] std::vector<uint32_t> list_page_id(const location_ptr &location, uint32_t dest_id) const override {
    PYBIND11_OVERLOAD(std::vector<uint32_t>, locator, list_page_id, location, dest_id);
  }

  [[nodiscard]] std::vector<location_ptr> list_locations(const std::string &category, const std::string &group,
                                                         const std::string &name,
                                                         const std::string &mode) const override {
    PYBIND11_OVERLOAD(std::vector<location_ptr>, locator, list_locations, category, group, name, mode);
  }

  [[nodiscard]] std::vector<uint32_t> list_location_dest(const location_ptr &location) const override {
    PYBIND11_OVERLOAD(std::vector<uint32_t>, locator, list_location_dest, location);
  }
};

class PyEvent : public event {
public:
  [[nodiscard]] int64_t gen_time() const override { PYBIND11_OVERLOAD_PURE(int64_t, event, gen_time); }

  [[nodiscard]] int64_t trigger_time() const override { PYBIND11_OVERLOAD_PURE(int64_t, event, trigger_time); }

  [[nodiscard]] int32_t msg_type() const override { PYBIND11_OVERLOAD_PURE(int64_t, event, msg_type); }

  [[nodiscard]] uint32_t source() const override { PYBIND11_OVERLOAD_PURE(int64_t, event, source); }

  [[nodiscard]] uint32_t initial_source() const override { PYBIND11_OVERLOAD_PURE(int64_t, event, initial_source); }

  [[nodiscard]] uint32_t dest() const override { PYBIND11_OVERLOAD_PURE(int64_t, event, dest); }
};

class PyPublisher : public publisher {
public:
  int notify() override { PYBIND11_OVERLOAD_PURE(int, publisher, notify); }

  int publish(const std::string &json_message, int flags = NNG_FLAG_NONBLOCK, bool no_exception = false) override {
    PYBIND11_OVERLOAD_PURE(int, publisher, publish, json_message, flags, no_exception);
  }
};

class PyObserver : public observer {
public:
  bool wait() override { PYBIND11_OVERLOAD_PURE(bool, observer, wait); }

  const std::string &get_notice() override { PYBIND11_OVERLOAD_PURE(const std::string &, observer, get_notice); }
};

class PySink : public sink {
public:
  void put(const yijinjing::data::location_ptr &location, uint32_t dest_id, const frame_ptr &frame) override {
    PYBIND11_OVERLOAD_PURE(void, sink, put, location, dest_id, frame);
  }
  void close() override { PYBIND11_OVERLOAD(void, sink, close); }
};

class PyMaster : public master {
public:
  using master::master;

  void on_exit() override { PYBIND11_OVERLOAD(void, master, on_exit); }

  void on_register(int64_t gen_time, const Register &register_data) override {
    PYBIND11_OVERLOAD_PURE(void, master, on_register, gen_time, register_data);
  }

  bool check_register(int64_t gen_time, const Register &register_data) override {
    PYBIND11_OVERLOAD_PURE(bool, master, check_register, gen_time, register_data);
  }

  void on_interval_check(int64_t nanotime) override {
    PYBIND11_OVERLOAD_PURE(void, master, on_interval_check, nanotime);
  }
};

class PyApprentice : public apprentice {
public:
  using apprentice::apprentice;

  void on_exit() override { PYBIND11_OVERLOAD_PURE(void, apprentice, on_exit); }
};

template <typename DataType> DataType event_to_data(const event &e) { return e.data<DataType>(); }

void bind(pybind11::module &&m) {
  yijinjing::ensure_sqlite_initilize();

  // nanosecond-time related
  m.def("now_in_nano", &yijinjing::time::now_in_nano);
  m.def("nano_hashed", &yijinjing::time::nano_hashed);
  m.def("next_minute", &yijinjing::time::next_minute);
  m.def("next_trading_day_end", &yijinjing::time::next_trading_day_end);
  m.def("calendar_day_start", &yijinjing::time::calendar_day_start);
  m.def("today_start", &yijinjing::time::today_start);
  m.def("trading_day_start", &yijinjing::time::trading_day_start);
  m.def("restore_start", &yijinjing::time::restore_start);
  m.def("strftime", &yijinjing::time::strftime, py::arg("nanotime"), py::arg("format") = KUNGFU_TIMESTAMP_FORMAT);
  m.def("strptime", py::overload_cast<const std::string &, const std::string &>(&yijinjing::time::strptime), py::arg("timestr"),
        py::arg("format") = KUNGFU_TIMESTAMP_FORMAT);
  m.def("strfnow", &yijinjing::time::strfnow, py::arg("format") = KUNGFU_TIMESTAMP_FORMAT);

  m.def("get_page_path", &page::get_page_path);

  // open-layer schema compilation: a kfx `.fbs` text schema -> `.bfbs`
  // reflection binary, compiled in-process by the linked FlatBuffers library
  // (no flatc binary, no subprocess). Returns (bfbs_bytes, error): on success
  // error is empty; on a parse/policy failure bfbs is empty and error carries
  // the diagnostic. `sandboxed=True` applies the untrusted-kfx bounds.
  m.def(
      "compile_schema",
      [](const std::string &fbs_text, bool sandboxed) {
        schema::compile_options opts;
        opts.tier = sandboxed ? schema::trust_tier::sandboxed : schema::trust_tier::trusted;
        auto r = schema::compile_fbs(fbs_text, opts);
        return py::make_tuple(py::bytes(reinterpret_cast<const char *>(r.bfbs.data()), r.bfbs.size()), r.error);
      },
      py::arg("fbs_text"), py::arg("sandboxed") = false);

  m.def("thread_id", &yijinjing::util::get_thread_id);
  m.def("in_color_terminal", &yijinjing::util::in_color_terminal);
  m.def("color_print", &yijinjing::util::color_print);

  m.def("hash_32", &yijinjing::util::hash_32, py::arg("key"), py::arg("length"), py::arg("seed") = KUNGFU_HASH_SEED);
  m.def("hash_str_32", &yijinjing::util::hash_str_32, py::arg("key"), py::arg("seed") = KUNGFU_HASH_SEED);

  m.def("setup_log", &yijinjing::log::setup_log);
  m.def("emit_log", &yijinjing::log::emit_log);

  py::enum_<nanomsg::protocol>(m, "protocol", py::arithmetic(), "Nanomsg Protocol")
      .value("REPLY", nanomsg::protocol::REPLY)
      .value("REQUEST", nanomsg::protocol::REQUEST)
      .value("PUSH", nanomsg::protocol::PUSH)
      .value("PULL", nanomsg::protocol::PULL)
      .value("PUBLISH", nanomsg::protocol::PUBLISH)
      .value("SUBSCRIBE", nanomsg::protocol::SUBSCRIBE)
      .export_values();

  auto event_class = py::class_<event, PyEvent, std::shared_ptr<event>>(m, "event");
  event_class.def_property_readonly("gen_time", &event::gen_time)
      .def_property_readonly("trigger_time", &event::trigger_time)
      .def_property_readonly("source", &event::source)
      .def_property_readonly("dest", &event::dest)
      .def_property_readonly("msg_type", &event::msg_type)
      .def_property_readonly("data_length", &event::data_length)
      .def_property_readonly("data_as_bytes", &event::data_as_bytes)
      .def_property_readonly("data_as_byte_array", &event::data_as_byte_array)
      .def_property_readonly("data_as_string", &event::data_as_string)
      .def("to_string", &event::to_string);
  boost::hana::for_each(AllDataTypes, [&](auto pair) {
    using DataType = typename decltype(+boost::hana::second(pair))::type;
    event_class.def(boost::hana::first(pair).c_str(), &event_to_data<DataType>);
  });

  py::class_<frame, event, frame_ptr>(m, "frame")
      .def_property_readonly("frame_length", &frame::frame_length)
      .def("has_data", &frame::has_data);

  auto location_class = py::class_<location, location_ptr>(m, "location");
  location_class
      .def(py::init<mode, category, const std::string &, const std::string &, locator_ptr, uint32_t>(), py::arg("m"),
           py::arg("c"), py::arg("g"), py::arg("n"), py::arg("l"), py::arg("default_seed") = KUNGFU_HASH_SEED)
      .def_readonly("mode", &location::mode)
      .def_readonly("category", &location::category)
      .def_readonly("group", &location::group)
      .def_readonly("name", &location::name)
      .def_readonly("uname", &location::uname)
      .def_readonly("uid", &location::uid)
      .def_readonly("locator", &location::locator)
      .def("__repr__", [&](location &target) { return target.uname; });
  location_class.def("to", py::overload_cast<Config &>(&location::to<Config>, py::const_));
  location_class.def("to", py::overload_cast<Register &>(&location::to<Register>, py::const_));
  location_class.def("to", py::overload_cast<Deregister &>(&location::to<Deregister>, py::const_));
  location_class.def("to", py::overload_cast<Location &>(&location::to<Location>, py::const_));

  py::class_<locator, PyLocator, locator_ptr>(m, "locator")
      .def(py::init())
      .def(py::init<const std::string &>())
      .def(py::init<const std::string &, mode>())
      .def(py::init<mode, const std::vector<std::string> &>(), py::arg("mode"),
           py::arg("tags") = std::vector<std::string>{})
      .def("has_env", &locator::has_env)
      .def("get_env", &locator::get_env)
      .def("layout_dir", &locator::layout_dir)
      .def("layout_file", &locator::layout_file)
      .def("get_root", &locator::get_root)
      .def("list_page_id", &locator::list_page_id)
      .def("list_locations", &locator::list_locations, py::arg("category") = "*", py::arg("group") = "*",
           py::arg("name") = "*", py::arg("mode") = "*")
      .def("list_location_dest", &locator::list_location_dest);

  py::class_<nanomsg::socket, socket_ptr>(m, "socket")
      .def(py::init<protocol>(), py::arg("protocol"))
      .def("setsockopt", &socket::setsockopt_str, py::arg("option"), py::arg("value"))
      .def("setsockopt", &socket::setsockopt_int, py::arg("option"), py::arg("value"))
      .def("setsockopt", &socket::setsockopt_ms, py::arg("option"), py::arg("value"))
      .def("getsockopt", &socket::getsockopt_int, py::arg("option"))
      .def("getsockopt", &socket::getsockopt_ms, py::arg("option"))
      .def("listen", &socket::listen, py::arg("url"), py::arg("flags") = 0)
      .def("dial", &socket::dial, py::arg("url"), py::arg("flags") = 0)
      .def("close", &socket::close)
      .def("send", &socket::send, py::arg("msg"), py::arg("flags") = 0, py::arg("no_exception") = false)
      .def("recv", &socket::recv_msg, py::arg("flags") = 0)
      .def("last_message", &socket::last_message);

  py::class_<publisher, PyPublisher, publisher_ptr>(m, "publisher")
      .def("publish", &publisher::publish)
      .def("notify", &publisher::notify);

  // standalone python journal writers (e.g. the rewind capture supervisor)
  // need the same no-op publisher the C++ slices use
  py::class_<journal::noop_publisher, publisher, std::shared_ptr<journal::noop_publisher>>(m, "noop_publisher")
      .def(py::init<>());

  py::class_<observer, PyObserver, observer_ptr>(m, "observer")
      .def("wait", &observer::wait)
      .def("get_notice", &observer::get_notice);

  py::class_<reader, reader_ptr>(m, "reader")
      .def(py::init<bool, bool, bus_ptr>())
      .def(py::init<const reader &>())
      .def("subscribe", &reader::join)
      .def("current_frame", &reader::current_frame)
      .def("seek_to_time", &reader::seek_to_time)
      .def("data_available", &reader::data_available)
      .def("next", &reader::next)
      .def("join", &reader::join, py::arg("location"), py::arg("dest_id"), py::arg("from_time"),
           py::arg("page_size") = 0, py::arg("priority") = Priority::Medium)
      .def("disjoin", &reader::disjoin)
      .def("disjoin_channel", &reader::disjoin_channel);

  py::class_<bus, bus_ptr>(m, "bus").def(py::init<bool>()).def("on_load_page", &bus::on_load_page);

  auto writer_class = py::class_<writer, writer_ptr>(m, "writer");
  writer_class
      .def(py::init<const yijinjing::data::location_ptr &, uint32_t, bool, publisher_ptr, bool, const bus_ptr &, uint32_t>())
      .def("current_frame_uid", &writer::current_frame_uid)
      .def("get_location", &writer::get_location)
      .def("get_dest", &writer::get_dest)
      .def("copy_frame", &writer::copy_frame)
      .def("mark", &writer::mark)
      .def("mark_at", &writer::mark_at)
      .def("write_bytes", &writer::write_bytes);
  boost::hana::for_each(AllDataTypes, [&](auto type) {
    using DataType = typename decltype(+boost::hana::second(type))::type;
    writer_class.def("write", py::overload_cast<int64_t, const DataType &, int32_t>(&writer::write<DataType>),
                     py::arg("trigger_time"), py::arg("data"), py::arg("msg_type") = DataType::tag);
    writer_class.def("write_at", py::overload_cast<int64_t, int64_t, const DataType &>(&writer::write_at<DataType>),
                     py::arg("gen_time"), py::arg("trigger_time"), py::arg("data"));
  });

  py::class_<sink, PySink, sink_ptr>(m, "sink")
      .def(py::init())
      .def_property_readonly("publisher", &sink::get_publisher)
      .def_property_readonly("bus", &sink::get_bus)
      .def("put", &sink::put)
      .def("find_page_size", &sink::find_page_size)
      .def("close", &sink::close);

  py::class_<null_sink, sink, std::shared_ptr<null_sink>>(m, "null_sink").def(py::init<>());

  py::class_<copy_sink, sink, std::shared_ptr<copy_sink>>(m, "copy_sink")
      .def(py::init<yijinjing::data::locator_ptr>())
      .def("put", &copy_sink::put);

  auto assemble_class = py::class_<assemble, assemble_ptr>(m, "assemble");
  assemble_class
      .def(py::init<const std::vector<yijinjing::data::locator_ptr> &, const std::string &, const std::string &,
                    const std::string &, const std::string &>(),
           py::arg("locators"), py::arg("mode") = "*", py::arg("category") = "*", py::arg("group") = "*",
           py::arg("name") = "*")
      .def(py::init<const yijinjing::data::location_ptr &, uint32_t, uint32_t, int64_t>(), py::arg("source_location"),
           py::arg("dest_id"), py::arg("assemble_mode") = longfist::enums::AssembleMode::Channel,
           py::arg("from_time") = 0)
      .def("read_headers", (std::vector<frame_header>(assemble::*)(int32_t, int64_t)) & assemble::read_headers,
           py::arg("msg_type"), py::arg("end_time") = INT64_MAX, py::return_value_policy::move)
      .def(
          "read_bytes",
          (std::vector<std::pair<longfist::types::frame_header, std::vector<uint8_t>>>(assemble::*)(int32_t, int64_t)) &
              assemble::read_bytes,
          py::arg("msg_type"), py::arg("end_time") = INT64_MAX, py::return_value_policy::move)
      .def("__plus__", &assemble::operator+)
      .def("__rshift__", &assemble::operator>>);
  boost::hana::for_each(AllDataTypes, [&](auto type) {
    using DataType = typename decltype(+boost::hana::second(type))::type;
    assemble_class.def("read_all", py::overload_cast<const DataType &, int64_t>(&assemble::read_all<DataType>),
                       py::arg("data"), py::arg("end_time") = INT64_MAX, py::return_value_policy::move);
    assemble_class.def("read_header_data",
                       py::overload_cast<const DataType &, int64_t>(&assemble::read_header_data<DataType>),
                       py::arg("data"), py::arg("end_time") = INT64_MAX, py::return_value_policy::move);
    assemble_class.def("read_headers", py::overload_cast<const DataType &, int64_t>(&assemble::read_headers<DataType>),
                       py::arg("data") = DataType{}, py::arg("end_time") = INT64_MAX, py::return_value_policy::move);
    assemble_class.def("read_bytes", py::overload_cast<const DataType &, int64_t>(&assemble::read_bytes<DataType>),
                       py::arg("data") = DataType{}, py::arg("end_time") = INT64_MAX, py::return_value_policy::move);
  });

  py::class_<io_device, yijinjing::io_device_ptr>(m, "io_device")
      .def(py::init<location_ptr, bool, bool>(), py::arg("home"), py::arg("low_latency") = false,
           py::arg("lazy") = true)
      .def_property_readonly("publisher", &io_device::get_publisher)
      .def_property_readonly("bus", &io_device::get_bus)
      .def_property_readonly("observer", &io_device::get_observer)
      .def_property_readonly("home", &io_device::get_home)
      .def_property_readonly("live_home", &io_device::get_live_home)
      .def("is_usable", &io_device::is_usable)
      .def("setup", &io_device::setup)
      .def("open_reader", &io_device::open_reader)
      .def("open_reader_to_subscribe", &io_device::open_reader_to_subscribe)
      .def("open_writer", &io_device::open_writer);

  py::class_<yijinjing::io_device_master, io_device, io_device_master_ptr>(m, "yijinjing::io_device_master")
      .def(py::init<location_ptr, bool>(), py::arg("home"), py::arg("low_latency"));

  py::class_<yijinjing::io_device_client, io_device, io_device_client_ptr>(m, "yijinjing::io_device_client")
      .def(py::init<location_ptr, bool>(), py::arg("home"), py::arg("low_latency"));

  py::class_<yijinjing::io_device_console, io_device, io_device_console_ptr>(m, "yijinjing::io_device_console")
      .def(py::init<location_ptr, uint32_t, uint32_t>(), py::arg("home"), py::arg("width"), py::arg("height"))
      .def("trace", &yijinjing::io_device_console::trace)
      .def("show", &yijinjing::io_device_console::show);

  py::class_<session_finder, std::shared_ptr<session_finder>>(m, "session_finder")
      .def(py::init<yijinjing::io_device_ptr>())
      .def("find_sessions", &session_finder::find_sessions, py::arg("from") = 0, py::arg("to") = INT64_MAX)
      .def("find_sessions_for", &session_finder::find_sessions_for, py::arg("source"), py::arg("from") = 0,
           py::arg("to") = INT64_MAX);

  py::class_<session_builder, session_finder, std::shared_ptr<session_builder>>(m, "session_builder")
      .def(py::init<yijinjing::io_device_ptr>())
      .def("rebuild_index_db", &session_builder::rebuild_index_db)
      .def("update_index_db", &session_builder::update_index_db);

  auto profile_class = py::class_<profile, std::shared_ptr<profile>>(m, "profile");
  profile_class.def(py::init<const locator_ptr &>());
  boost::hana::for_each(longfist::ProfileDataTypes, [&](auto type) {
    using DataType = typename decltype(+boost::hana::second(type))::type;
    profile_class.def("set", &profile::set<DataType>);
    profile_class.def("get", &profile::get<DataType>);
    profile_class.def("get_all", &profile::get_all<DataType>);
    profile_class.def("remove", &profile::remove<DataType>);
  });

  py::class_<master, PyMaster>(m, "master")
      .def(py::init<location_ptr, bool>(), py::arg("home"), py::arg("low_latency") = false)
      .def_property_readonly("io_device", &master::get_io_device)
      .def_property_readonly("home", &master::get_home)
      .def_property_readonly("live", &master::is_live)
      .def("get_begin_time", &master::get_begin_time)
      .def("get_end_time", &master::get_end_time)
      .def("get_home_uid", &master::get_home_uid)
      .def("get_home_uname", &master::get_home_uname)
      .def("now", &master::now)
      .def("run", &master::run, py::arg("step_limit") = 0)
      .def("pre_setup", &master::pre_setup)
      .def("setup", &master::setup)
      .def("step", &master::step)
      .def("is_live", &master::is_live)
      .def("on_exit", &master::on_exit)
      .def("on_register", &master::on_register)
      .def("check_register", &master::check_register)
      .def("on_interval_check", &master::on_interval_check)
      .def("deregister_app", &master::deregister_app);

  py::class_<apprentice, PyApprentice, apprentice_ptr>(m, "apprentice")
      .def(py::init<location_ptr, bool, std::string>(), py::arg("home"), py::arg("low_latency") = false,
           py::arg("arguments") = "{}")
      .def_property_readonly("io_device", &apprentice::get_io_device)
      .def_property_readonly("home", &apprentice::get_home)
      .def_property_readonly("live", &apprentice::is_live)
      .def("set_begin_time", &apprentice::set_begin_time)
      .def("set_end_time", &apprentice::set_end_time)
      .def("get_begin_time", &apprentice::get_begin_time)
      .def("get_end_time", &apprentice::get_end_time)
      .def("get_location", &apprentice::get_location)
      .def("get_home_uid", &apprentice::get_home_uid)
      .def("get_home_uname", &apprentice::get_home_uname)
      .def("now", &apprentice::now)
      .def("run", &apprentice::run, py::arg("step_limit") = 0)
      .def("pre_setup", &apprentice::pre_setup)
      .def("setup", &apprentice::setup)
      .def("step", &apprentice::step)
      .def("is_live", &apprentice::is_live)
      .def("is_started", &apprentice::is_started)
      .def("has_writer", &apprentice::has_writer)
      .def("get_writer", &apprentice::get_writer)
      .def("on_exit", &apprentice::on_exit);
}
} // namespace kungfu::yijinjing
