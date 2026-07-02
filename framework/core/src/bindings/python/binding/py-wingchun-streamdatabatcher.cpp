// SPDX-License-Identifier: Apache-2.0

#include <pybind11/stl.h>
#include <pybind11/stl_bind.h>

#include <kungfu/wingchun/factor/backteststreamdatabatcher.h>
#include <kungfu/wingchun/factor/livestreamdatabatcher.h>
#include <kungfu/wingchun/factor/streamdatabatcher.h>
#include <pybind11/numpy.h>

using namespace kungfu::longfist;
using namespace kungfu::longfist::types;
using namespace kungfu::longfist::enums;
using namespace kungfu::yijinjing;
using namespace kungfu::yijinjing::data;
using namespace kungfu::yijinjing::journal;
using namespace kungfu::wingchun;
using namespace kungfu::wingchun::factor;

namespace py = pybind11;

#define DEFINE_FORMAT_DESCRIPTOR(Type, Format)                                                                         \
  template <> struct py::format_descriptor<Type> {                                                                     \
    static std::string format() { return std::string(Format); }                                                        \
  };

DEFINE_FORMAT_DESCRIPTOR(int64_t, "q")
DEFINE_FORMAT_DESCRIPTOR(int32_t, "q")
DEFINE_FORMAT_DESCRIPTOR(double, "d")
DEFINE_FORMAT_DESCRIPTOR(enums::InstrumentType, "b")
DEFINE_FORMAT_DESCRIPTOR(enums::Side, "b")
DEFINE_FORMAT_DESCRIPTOR(enums::PriceType, "b")
DEFINE_FORMAT_DESCRIPTOR(enums::ExecType, "b")

namespace kungfu::wingchun::pybind {

template <typename T, size_t N> struct FormatDescriptor {
  static std::string format() {
    if constexpr (std::is_same_v<T, char>) {
      return std::to_string(N) + "s";
    } else if constexpr (std::is_same_v<T, double>) {
      return std::string(N, 'd');
    }
  }
};

auto formatMap = hana::make_map(
    hana::make_pair(hana::type_c<int64_t>, py::format_descriptor<int64_t>::format()),
    hana::make_pair(hana::type_c<int32_t>, py::format_descriptor<int32_t>::format()),
    hana::make_pair(hana::type_c<kungfu::array<char, 32>>, FormatDescriptor<char, 32>::format()),
    hana::make_pair(hana::type_c<kungfu::array<char, 16>>, FormatDescriptor<char, 16>::format()),
    hana::make_pair(hana::type_c<kungfu::array<char, 8>>, FormatDescriptor<char, 8>::format()),
    hana::make_pair(hana::type_c<kungfu::array<double, 10>>, FormatDescriptor<double, 10>::format()),
    hana::make_pair(hana::type_c<enums::InstrumentType>, py::format_descriptor<enums::InstrumentType>::format()),
    hana::make_pair(hana::type_c<enums::Side>, py::format_descriptor<enums::Side>::format()),
    hana::make_pair(hana::type_c<enums::ExecType>, py::format_descriptor<enums::ExecType>::format()),
    hana::make_pair(hana::type_c<enums::PriceType>, py::format_descriptor<enums::PriceType>::format()),
    hana::make_pair(hana::type_c<double>, py::format_descriptor<double>::format()));

template <typename BufferType>
void bind_buffer_class(const std::string &name, py::module &m, const std::string &str_format, int ndim) {
  py::class_<EventBuffer<BufferType>, std::shared_ptr<EventBuffer<BufferType>>>(m, name.c_str(), py::buffer_protocol())
      .def("get_events", &EventBuffer<BufferType>::get_events, py::return_value_policy::reference)
      .def_buffer([str_format, ndim](const EventBuffer<BufferType> &batcher) -> py::buffer_info {
        std::vector<BufferType> &event_vec = const_cast<std::vector<BufferType> &>(batcher.get_events());
        return py::buffer_info(event_vec.data(), sizeof(BufferType), str_format, ndim, {batcher.get_events().size()},
                               {sizeof(BufferType)});
      });
}

template <typename BufferType> std::string get_str_format() {
  std::string str_format = "";
  hana::for_each(hana::accessors<BufferType>(), [&](auto it) {
    [[maybe_unused]] auto second_attribute = hana::second(it);
    using MemberType = std::decay_t<decltype(second_attribute(BufferType{}))>;
    str_format += hana::at_key(formatMap, hana::type_c<MemberType>);
  });
  return str_format;
}

void bind_stream_data_batcher(pybind11::module &m) {
  bind_buffer_class<Entrust>("EntrustBuffer", m, get_str_format<Entrust>(), 1);
  bind_buffer_class<Transaction>("TransactionBuffer", m, get_str_format<Transaction>(), 1);
  bind_buffer_class<Quote>("QuoteBuffer", m, get_str_format<Quote>(), 1);
  bind_buffer_class<Tree>("TreeBuffer", m, get_str_format<Tree>(), 1);
  bind_buffer_class<Depth>("DepthBuffer", m, get_str_format<Depth>(), 1);
  bind_buffer_class<Tick>("TickBuffer", m, get_str_format<Tick>(), 1);

  py::class_<StreamDataBatcher, std::shared_ptr<StreamDataBatcher>>(m, "StreamDataBatcher")
      .def("pop_batched_entrust_until", &StreamDataBatcher::pop_batched_entrust_until,
           py::return_value_policy::reference)
      .def("pop_batched_transaction_until", &StreamDataBatcher::pop_batched_transaction_until,
           py::return_value_policy::reference)
      .def("pop_batched_quote_until", &StreamDataBatcher::pop_batched_quote_until, py::return_value_policy::reference)
      .def("pop_batched_tree_until", &StreamDataBatcher::pop_batched_tree_until, py::return_value_policy::reference)
      .def("pop_batched_depth_until", &StreamDataBatcher::pop_batched_depth_until, py::return_value_policy::reference)
      .def("pop_batched_tick_until", &StreamDataBatcher::pop_batched_tick_until, py::return_value_policy::reference)
      .def("get_entrust_buffer", &StreamDataBatcher::get_entrust_buffer, py::return_value_policy::reference)
      .def("get_transaction_buffer", &StreamDataBatcher::get_transaction_buffer, py::return_value_policy::reference)
      .def("get_quote_buffer", &StreamDataBatcher::get_quote_buffer, py::return_value_policy::reference)
      .def("get_tree_buffer", &StreamDataBatcher::get_tree_buffer, py::return_value_policy::reference)
      .def("get_depth_buffer", &StreamDataBatcher::get_depth_buffer, py::return_value_policy::reference)
      .def("get_tick_buffer", &StreamDataBatcher::get_tick_buffer, py::return_value_policy::reference);

  py::class_<BackTestStreamDataBatcher, std::shared_ptr<BackTestStreamDataBatcher>, StreamDataBatcher>(
      m, "BackTestStreamDataBatcher")
      .def(py::init<practice::apprentice &, tool::SliceIndexer_ptr>(), py::arg("app"),
           py::arg("from_indexer"));

  py::class_<LiveStreamDataBatcher, std::shared_ptr<LiveStreamDataBatcher>, StreamDataBatcher>(m,
                                                                                               "LiveStreamDataBatcher")
      .def(py::init<>());
}
} // namespace kungfu::wingchun::pybind