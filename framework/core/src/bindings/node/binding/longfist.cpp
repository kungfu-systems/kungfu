// SPDX-License-Identifier: Apache-2.0

//
// Created by Keren Dong on 2020/2/15.
//

#include <kungfu/common.h>
#include <kungfu/longfist/longfist.h>

#include "longfist.h"

using namespace kungfu::longfist;
using namespace kungfu::longfist::types;

namespace kungfu::node {
Napi::FunctionReference Longfist::constructor = {};

Longfist::Longfist(const Napi::CallbackInfo &info)
    : ObjectWrap(info),                                                                  //
      types_ref_(Napi::ObjectReference::New(Napi::Object::New(info.Env()), 1)),          //
      carrier_types_ref_(Napi::ObjectReference::New(Napi::Object::New(info.Env()), 1)) { //
  InitTypes(info);
  InitCarrierTypes(info);
}

void Longfist::Init(Napi::Env env, Napi::Object exports) {
  Napi::HandleScope scope(env);
  env.AddCleanupHook(cleanup);

  Napi::Function func =
      DefineClass(env, "Longfist",
                  {
                      InstanceAccessor("types", &Longfist::GetTypes, &Longfist::NoSet),               //
                      InstanceAccessor("carrierTypes", &Longfist::GetCarrierTypes, &Longfist::NoSet), //
                  });

  constructor = Napi::Persistent(func);
  constructor.SuppressDestruct();

  exports.Set("Longfist", func);
}

Napi::Value Longfist::GetCarrierTypes(const Napi::CallbackInfo &info) { return carrier_types_ref_.Value(); }

void Longfist::InitCarrierTypes(const Napi::CallbackInfo &info) {
  boost::hana::for_each(CorePublicDataTypes, [&](auto it) {
    using DataType = typename decltype(+boost::hana::second(it))::type;
    carrier_types_ref_.Set(int(DataType::tag), Napi::String::New(info.Env(), DataType::type_name.c_str()));
  });
}

Napi::Value Longfist::GetTypes(const Napi::CallbackInfo &info) { return types_ref_.Value(); }

void Longfist::InitTypes(const Napi::CallbackInfo &info) {
  boost::hana::for_each(CorePublicDataTypes, [&](auto it) {
    auto name = boost::hana::first(it);
    using DataType = typename decltype(+boost::hana::second(it))::type;
    static const auto make = serialize::JsMake<DataType>(name.c_str());
    types_ref_.Set(Napi::String::New(info.Env(), name.c_str()), Napi::Function::New(info.Env(), make));
  });
}

void Longfist::NoSet(const Napi::CallbackInfo &info, const Napi::Value &value) {
  SPDLOG_WARN("do not manipulate longfist internals");
}

} // namespace kungfu::node
