//  SPDX-License-Identifier: Apache-2.0

//
// Created by Keren Dong on 2021/12/15.
//

#ifndef KUNGFU_EXTENSION_H
#define KUNGFU_EXTENSION_H

#include <kungfu/common.h>
#include <pybind11/pybind11.h>

#define GET_MODULE_NAME_STR(N) #N
#define GET_MODULE_NAME(N) GET_MODULE_NAME_STR(N)

#define KUNGFU_EXTENSION(...) PYBIND11_MODULE(KUNGFU_MODULE_NAME, m)

#define KUNGFU_DEFINE_SERVICE(ServiceType)                                                                             \
  m.def("service",                                                                                                     \
        [&](kungfu::yijinjing::data::locator_ptr locator, const std::string &group, const std::string &name,           \
            kungfu::longfist::enums::mode m, bool low_latency = false, const std::string &arguments = "{}") {          \
          return std::static_pointer_cast<kungfu::practice::apprentice>(                                    \
              std::make_shared<ServiceType>(locator, group, name, m, low_latency, arguments));                         \
        })

#define KUNGFU_DEFINE_CACHE_TOOL(ToolType)                                                                             \
  m.def("tool", [&](kungfu::longfist::enums::category category, std::string group, std::string name,                   \
                    int64_t begin_time, int64_t end_time, kungfu::yijinjing::data::locator_ptr locator) {              \
    return std::static_pointer_cast<kungfu::wingchun::tool::CacheTool>(                                                \
        std::make_shared<ToolType>(category, group, name, begin_time, end_time, locator, true));                       \
  })

#define KUNGFU_DEFINE_MD(MarketDataType)                                                                               \
  m.def("md", [&](kungfu::wingchun::broker::BrokerVendor &vendor) {                                                    \
    return std::static_pointer_cast<kungfu::wingchun::broker::MarketData>(std::make_shared<MarketDataType>(vendor));   \
  })

#define KUNGFU_DEFINE_TD(TraderType)                                                                                   \
  m.def("td", [&](kungfu::wingchun::broker::BrokerVendor &vendor) {                                                    \
    return std::static_pointer_cast<kungfu::wingchun::broker::Trader>(std::make_shared<TraderType>(vendor));           \
  })

#define KUNGFU_DEFINE_STRATEGY(StrategyType)                                                                           \
  m.def("strategy", [&]() {                                                                                            \
    return std::static_pointer_cast<kungfu::wingchun::strategy::Strategy>(std::make_shared<StrategyType>());           \
  })

#define KUNGFU_MAIN_STRATEGY(StrategyType)                                                                             \
  class StrategyType;                                                                                                  \
  PYBIND11_MODULE(KUNGFU_MODULE_NAME, m) {                                                                             \
    m.def("strategy", [&]() {                                                                                          \
      typedef kungfu::yijinjing::data::location location;                                                              \
      typedef kungfu::yijinjing::data::locator locator;                                                                \
      typedef kungfu::longfist::enums::mode mode;                                                                      \
      typedef kungfu::longfist::enums::category category;                                                              \
      std::string module_name = GET_MODULE_NAME(KUNGFU_MODULE_NAME);                                                   \
      auto lr = std::make_shared<locator>();                                                                           \
      std::string s_group(module_name);                                                                                \
      std::string s_name(module_name);                                                                                 \
      char *env_group = std::getenv("KF_STG_GROUP");                                                                   \
      if (env_group != NULL) {                                                                                         \
        s_group = env_group;                                                                                           \
      }                                                                                                                \
      char *env_name = std::getenv("KF_STG_NAME");                                                                     \
      if (env_name != NULL) {                                                                                          \
        s_name = env_name;                                                                                             \
      }                                                                                                                \
      auto home = location::make_shared(mode::LIVE, category::STRATEGY, s_group, s_name, lr);                          \
      KUNGFU_SETUP_LOGGER(home, module_name);                                                                          \
      return std::static_pointer_cast<kungfu::wingchun::strategy::Strategy>(std::make_shared<StrategyType>());         \
    });                                                                                                                \
  };                                                                                                                   \
  class StrategyType : public kungfu::wingchun::strategy::Strategy

#define KUNGFU_MAIN_OPERATOR(OperatorType)                                                                             \
  class OperatorType;                                                                                                  \
  PYBIND11_MODULE(KUNGFU_MODULE_NAME, m) {                                                                             \
    m.def("operator", [&]() {                                                                                          \
      typedef kungfu::yijinjing::data::location location;                                                              \
      typedef kungfu::yijinjing::data::locator locator;                                                                \
      typedef kungfu::longfist::enums::mode mode;                                                                      \
      typedef kungfu::longfist::enums::category category;                                                              \
      std::string module_name = GET_MODULE_NAME(KUNGFU_MODULE_NAME);                                                   \
      auto lr = std::make_shared<locator>();                                                                           \
      std::string s_group(module_name);                                                                                \
      std::string s_name(module_name);                                                                                 \
      char *env_group = std::getenv("KF_OP_GROUP");                                                                    \
      if (env_group != NULL) {                                                                                         \
        s_group = env_group;                                                                                           \
      }                                                                                                                \
      char *env_name = std::getenv("KF_OP_NAME");                                                                      \
      if (env_name != NULL) {                                                                                          \
        s_name = env_name;                                                                                             \
      }                                                                                                                \
      auto home = location::make_shared(mode::LIVE, category::OPERATOR, s_group, s_name, lr);                          \
      KUNGFU_SETUP_LOGGER(home, module_name);                                                                          \
      return std::static_pointer_cast<kungfu::wingchun::op::Operator>(std::make_shared<OperatorType>());               \
    });                                                                                                                \
  };                                                                                                                   \
  class OperatorType : public kungfu::wingchun::op::Operator

#define KUNGFU_MAIN_MATCHER(MatcherType)                                                                               \
  class MatcherType;                                                                                                   \
  PYBIND11_MODULE(KUNGFU_MODULE_NAME, m) {                                                                             \
    m.def("matcher", [&]() {                                                                                           \
      typedef kungfu::yijinjing::data::location location;                                                              \
      typedef kungfu::yijinjing::data::locator locator;                                                                \
      typedef kungfu::longfist::enums::mode mode;                                                                      \
      typedef kungfu::longfist::enums::category category;                                                              \
      std::string module_name = GET_MODULE_NAME(KUNGFU_MODULE_NAME);                                                   \
      auto lr = std::make_shared<locator>();                                                                           \
      std::string s_group(module_name);                                                                                \
      std::string s_name(module_name);                                                                                 \
      char *env_group = std::getenv("KF_STG_GROUP");                                                                   \
      if (env_group != NULL) {                                                                                         \
        s_group = env_group;                                                                                           \
      }                                                                                                                \
      char *env_name = std::getenv("KF_STG_NAME");                                                                     \
      if (env_name != NULL) {                                                                                          \
        s_name = env_name;                                                                                             \
      }                                                                                                                \
      auto home = location::make_shared(mode::LIVE, category::STRATEGY, s_group, s_name, lr);                          \
      KUNGFU_SETUP_LOGGER(home, module_name);                                                                          \
      return std::static_pointer_cast<kungfu::wingchun::strategy::Matcher>(std::make_shared<MatcherType>());           \
    });                                                                                                                \
  };                                                                                                                   \
  class MatcherType : public kungfu::wingchun::strategy::Matcher

#define KUNGFU_MAIN_TOOL(ToolType)                                                                                     \
  class ToolType;                                                                                                      \
  PYBIND11_MODULE(KUNGFU_MODULE_NAME, m) {                                                                             \
    m.def("tool", [&](kungfu::longfist::enums::category category, std::string group, std::string name,                 \
                      int64_t begin_time, int64_t end_time, kungfu::yijinjing::data::locator_ptr locator) {            \
      return std::static_pointer_cast<kungfu::wingchun::tool::CacheTool>(                                              \
          std::make_shared<ToolType>(category, group, name, begin_time, end_time, locator, true));                     \
    });                                                                                                                \
  };                                                                                                                   \
  class ToolType : public kungfu::wingchun::tool::CacheTool

#define KUNGFU_MAIN_SLICE_TOOL(SliceToolType)                                                                          \
  class SliceToolType;                                                                                                 \
  PYBIND11_MODULE(KUNGFU_MODULE_NAME, m) {                                                                             \
    m.def("slice_tool", [&](kungfu::longfist::enums::category category, std::string group, std::string name,           \
                            SliceIndexer_ptr indexer, bool overwrite, std::string argument, std::size_t size) {        \
      return std::static_pointer_cast<kungfu::wingchun::tool::SliceTool>(std::make_shared<SliceToolType>(              \
          category, std::move(group), std::move(name), indexer, overwrite, std::move(argument), size));                \
    });                                                                                                                \
  };                                                                                                                   \
  class SliceToolType : public kungfu::wingchun::tool::SliceTool

#define KUNGFU_MAIN_REPORT(ReportType)                                                                                 \
  class ReportType;                                                                                                    \
  PYBIND11_MODULE(KUNGFU_MODULE_NAME, m) {                                                                             \
    m.def("report",                                                                                                    \
          [&]() { return std::static_pointer_cast<kungfu::wingchun::tool::Report>(std::make_shared<ReportType>()); }); \
  };                                                                                                                   \
  class ReportType : public kungfu::wingchun::tool::Report

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
    return str(src.value).release();
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

namespace kungfu {
template <typename DataType> void bind_data_type(pybind11::module &m_types, const char *type_name) {
  auto py_class = pybind11::class_<DataType, std::shared_ptr<DataType>>(m_types, type_name);
  py_class.def(pybind11::init<>());
  py_class.def(pybind11::init<const std::string &>());

  boost::hana::for_each(boost::hana::accessors<DataType>(), [&](auto it) {
    auto name = boost::hana::first(it);
    auto accessor = boost::hana::second(it);
    py_class.def_readwrite(name.c_str(), member_pointer_trait<decltype(accessor)>().pointer());
  });

  py_class.def_readonly_static("__tag__", &DataType::tag);
  py_class.def_readonly_static("__has_data__", &DataType::has_data);

  py_class.def_property_readonly("__uid__", &DataType::uid);

  py_class.def("__repr__", &DataType::to_string);
  py_class.def("__hash__", &DataType::uid);
  py_class.def("__eq__", [&](DataType &a, DataType &b) { return a.uid() == b.uid(); });
  py_class.def("__sizeof__", [&](const DataType &target) { return sizeof(target); });
  py_class.def("__parse__", [&](DataType &target, std::string &s) { target.parse(s.c_str(), s.length()); });
}
} // namespace kungfu

#endif // KUNGFU_EXTENSION_H
