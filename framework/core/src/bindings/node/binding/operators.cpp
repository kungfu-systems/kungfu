// SPDX-License-Identifier: Apache-2.0

//
// Created by Keren Dong on 2020/3/30.
//

#include "operators.h"

using namespace kungfu::rx;
using namespace kungfu::longfist;
using namespace kungfu::longfist::enums;
using namespace kungfu::longfist::types;
using namespace kungfu::yijinjing;
using namespace kungfu::yijinjing::data;
using namespace kungfu::practice;

namespace kungfu::node::serialize {
void InitObjectReference(const Napi::CallbackInfo &info, Napi::ObjectReference &data) {
  data = Napi::ObjectReference::New(Napi::Object::New(info.Env()), 1);
}

void InitStateMap(const Napi::CallbackInfo &info, Napi::ObjectReference &state, const std::string &name) {
  boost::hana::for_each(longfist::StateDataTypes, [&](auto it) {
    auto name = std::string(boost::hana::first(it).c_str());
    state.Set(name, DataTable::NewInstance(state.Value()));
  });
  state.Value().DefineProperty(Napi::PropertyDescriptor::Value("state_name", Napi::String::New(state.Env(), name)));
}

void RefreshTradingDataInStateMap(Napi::ObjectReference &state, const std::string &name) {
  boost::hana::for_each(longfist::RefreshRequiredDataTypes, [&](auto it) {
    using DataType = typename decltype(+boost::hana::second(it))::type;
    auto hana_type = boost::hana::type_c<DataType>;
    auto type_name = std::string(boost::hana::first(it).c_str());
    state.Set(type_name, DataTable::NewInstance(state.Value()));
  });
}

} // namespace kungfu::node::serialize