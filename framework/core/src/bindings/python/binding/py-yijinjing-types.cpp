// SPDX-License-Identifier: Apache-2.0

#include "py-yijinjing.h"

#include <pybind11/stl.h>
#include <pybind11/stl_bind.h>

#include <cstdint>
#include <sstream>
#include <type_traits>

#include <kungfu/yijinjing/schema/registry.h>

namespace pybind11::detail {
template <size_t Size> struct type_caster<kungfu::array<char, Size>> {
  using ArrayType = kungfu::array<char, Size>;
  using value_conv = make_caster<char>;

  bool load(handle src, bool convert) {
    if (!isinstance<str>(src))
      return false;
    std::string &&s = reinterpret_borrow<str>(src);
    if (s.length() > Size)
      return false;
    kungfu::copy_string(value.value, s.c_str());
    return true;
  }

  template <typename T> static handle cast(T &&src, return_value_policy policy, handle parent) {
    return str(src.to_string()).release();
  }

  PYBIND11_TYPE_CASTER(ArrayType, _("String[") + value_conv::name + _("[") + _<Size>() + _("]") + _("]"));
};

template <typename ValueType, size_t Size> struct type_caster<kungfu::array<ValueType, Size>> {
  using ArrayType = kungfu::array<ValueType, Size>;
  using value_conv = make_caster<ValueType>;

  bool load(handle src, bool convert) {
    if (!isinstance<sequence>(src))
      return false;
    auto l = reinterpret_borrow<sequence>(src);
    if (l.size() > Size)
      return false;
    size_t ctr = 0;
    for (auto it : l) {
      value_conv conv;
      if (!conv.load(it, convert))
        return false;
      value.value[ctr++] = cast_op<ValueType &&>(std::move(conv));
    }
    return true;
  }

  template <typename T> static handle cast(T &&src, return_value_policy policy, handle parent) {
    list l(src.size());
    for (size_t index = 0; index < Size; index++) {
      auto &&value = src.value[index];
      auto value_ = reinterpret_steal<object>(value_conv::cast(forward_like<T>(value), policy, parent));
      PyList_SET_ITEM(l.ptr(), (ssize_t)index, value_.release().ptr());
    }
    return l.release();
  }

  PYBIND11_TYPE_CASTER(ArrayType, _("List[") + value_conv::name + _("[") + _<Size>() + _("]") + _("]"));
};
} // namespace pybind11::detail

namespace kungfu::yijinjing::pybind {
namespace py = pybind11;
namespace hana = boost::hana;

template <typename DataType> void bind_data_type(pybind11::module &m_types, const char *type_name) {
  // KF-ADR-019f86da-4f90-7499-9152-520599d089ae Decision 3: frame_header opts into the Python buffer protocol so
  // its raw struct bytes can be handed to the native checksum_frame primitive
  // zero-copy; def_buffer below requires the py::buffer_protocol() tag here.
  auto py_class = [&] {
    if constexpr (std::is_same_v<DataType, kungfu::yijinjing::types::frame_header>) {
      return py::class_<DataType, std::shared_ptr<DataType>>(m_types, type_name, py::buffer_protocol());
    } else {
      return py::class_<DataType, std::shared_ptr<DataType>>(m_types, type_name);
    }
  }();
  py_class.def(py::init<>());
  py_class.def(py::init<const std::string &>());

  hana::for_each(hana::accessors<DataType>(), [&](auto it) {
    auto name = hana::first(it);
    auto public_name = kungfu::public_field_name(name.c_str());
    auto accessor = hana::second(it);
    py_class.def_readwrite(public_name.c_str(), member_pointer_trait<decltype(accessor)>().pointer());
  });

  py_class.def_readonly_static("__tag__", &DataType::tag);
  py_class.def_readonly_static("__has_data__", &DataType::has_data);

  py_class.def_property_readonly("__uid__", &DataType::uid);

  py_class.def("__repr__", &DataType::to_string);
  py_class.def("__hash__", &DataType::uid);
  py_class.def("__eq__", [&](DataType &a, DataType &b) { return a.uid() == b.uid(); });
  py_class.def("__sizeof__", [&](const DataType &target) { return sizeof(target); });
  py_class.def("__parse__", [&](DataType &target, std::string &s) { target.parse(s.c_str(), s.length()); });

  // KF-ADR-019f86da-4f90-7499-9152-520599d089ae Decision 3: expose the raw frame_header struct bytes as a
  // read-only, zero-copy Python buffer for native frame inspection. Only
  // frame_header opts in; callers must keep the view within the live header's
  // lifetime.
  if constexpr (std::is_same_v<DataType, kungfu::yijinjing::types::frame_header>) {
    py_class.def_buffer([](DataType &self) -> py::buffer_info {
      return py::buffer_info(reinterpret_cast<uint8_t *>(&self), static_cast<py::ssize_t>(sizeof(uint8_t)),
                             py::format_descriptor<uint8_t>::format(), static_cast<py::ssize_t>(sizeof(DataType)),
                             /*readonly=*/true);
    });
  }
}

void bind_types(py::module &m) {
  auto m_types = m.def_submodule("types");
  auto m_state = m.def_submodule("state");

  hana::for_each(CorePublicDataTypes, [&](auto pair) {
    using DataType = typename decltype(+hana::second(pair))::type;
    bind_data_type<DataType>(m_types, hana::first(pair).c_str());
  });

  hana::for_each(CorePublicStateDataTypes, [&](auto pair) {
    using DataType = typename decltype(+hana::second(pair))::type;
    py::class_<kungfu::state<DataType>>(m_state, hana::first(pair).c_str())
        .def_readonly("source", &kungfu::state<DataType>::source)
        .def_readonly("update_time", &kungfu::state<DataType>::update_time)
        .def_readonly("data", &kungfu::state<DataType>::data);
  });
}
} // namespace kungfu::yijinjing::pybind
