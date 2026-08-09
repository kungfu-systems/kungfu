// SPDX-License-Identifier: Apache-2.0

//
// Created by Keren Dong on 2020/3/30.
//

#include "operators.h"

using namespace kungfu::rx;
using namespace kungfu::yijinjing;
using namespace kungfu::yijinjing::enums;
using namespace kungfu::yijinjing::types;
using namespace kungfu::runtime;
using namespace kungfu::yijinjing::data;
using namespace kungfu::runtime::live;

namespace kungfu::node::serialize {
void InitObjectReference(const Napi::CallbackInfo &info, Napi::ObjectReference &data) {
  InitObjectReference(info.Env(), data);
}

void InitStateMap(const Napi::CallbackInfo &info, Napi::ObjectReference &state, const std::string &name) {
  InitStateMap(info.Env(), state, name);
}

void InitObjectReference(Napi::Env env, Napi::ObjectReference &data) {
  data = Napi::ObjectReference::New(Napi::Object::New(env), 1);
}

void InitStateMap(Napi::Env env, Napi::ObjectReference &state, const std::string &name) {
  (void)env;
  boost::hana::for_each(yijinjing::StateDataTypes, [&](auto it) {
    auto name = std::string(boost::hana::first(it).c_str());
    state.Set(name, DataTable::NewInstance(state.Value()));
  });
  state.Value().DefineProperty(Napi::PropertyDescriptor::Value("state_name", Napi::String::New(state.Env(), name)));
}

} // namespace kungfu::node::serialize
