// SPDX-License-Identifier: Apache-2.0

//
// Created by Keren Dong on 2022/12/3.
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
JsPublishState::JsPublishState(apprentice &app, Napi::ObjectReference &state) : app_(app), state_(state) {}

void JsPublishState::operator()(Napi::Object object) {
  auto now = yijinjing::time::now_in_nano();
  auto location = app_.get_live_home();
  auto type_name = object.Get("type").ToString().Utf8Value();
  boost::hana::for_each(longfist::StateDataTypes, [&](auto it) {
    using DataType = typename decltype(+boost::hana::second(it))::type;
    if (strcmp(DataType::type_name.c_str(), type_name.c_str()) == 0) {
      DataType data{};
      get(object, data);
      auto uid_key = fmt::format("{:016x}", data.uid());
      if (not object.HasOwnProperty("uid_key")) {
        object.DefineProperties(
            {Napi::PropertyDescriptor::Value("uid_key", Napi::String::New(object.Env(), uid_key)),
             Napi::PropertyDescriptor::Value("source", Napi::Number::New(object.Env(), location->uid)),
             Napi::PropertyDescriptor::Value("dest", Napi::Number::New(object.Env(), 0))});
      }
      object.Set("uid_key", Napi::String::New(state_.Env(), uid_key));
      object.Set("source", Napi::Number::New(state_.Env(), location->uid));
      object.Set("dest", Napi::Number::New(state_.Env(), 0));
      object.Set("ts", Napi::BigInt::New(state_.Env(), now));
      state_.Get(type_name).ToObject().Set(uid_key, object);
      app_.write_to(0, data, location::PUBLIC);
    }
  });
}

} // namespace kungfu::node::serialize