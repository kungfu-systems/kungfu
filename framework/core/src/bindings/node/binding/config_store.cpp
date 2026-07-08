// SPDX-License-Identifier: Apache-2.0

//
// Created by Keren Dong on 2020/2/25.
//

#include "config_store.h"
#include "io.h"

#include <kungfu/runtime/util/stacktrace.h>

using namespace kungfu::yijinjing;
using namespace kungfu::yijinjing::types;
using namespace kungfu::yijinjing::enums;
using namespace kungfu::runtime;
using namespace kungfu::yijinjing::data;

namespace kungfu::node {
Napi::FunctionReference ConfigStore::constructor = {};

ConfigStore::ConfigStore(const Napi::CallbackInfo &info)
    : ObjectWrap(info), locator_(IODevice::ExtractRuntimeLocatorByIndex(info, 0)), profile_(locator_) {}

inline Config getConfigFromJs(const Napi::CallbackInfo &info, const locator_ptr &locator) {
  Config query = {};
  auto config_location = IODevice::ExtractLocation(info, 0, locator);
  if (config_location) {
    query = config_location->to<Config>();
  }
  return query;
}

Napi::Value ConfigStore::SetConfig(const Napi::CallbackInfo &info) {
  Config config = getConfigFromJs(info, locator_);
  int valueIndex = info[0].IsObject() ? 1 : 4;
  if (info[0].IsObject()) {
    config.value = info[0].ToObject().Get("value").ToString().Utf8Value();
  } else {
    config.value = info[valueIndex].ToString().Utf8Value();
  }
  try {
    profile_.set(config);
  } catch (const std::exception &ex) {
    SPDLOG_ERROR("failed to SetConfig {}", ex.what());
    runtime::util::print_stack_trace();
    return Napi::Boolean::New(info.Env(), false);
  }
  return Napi::Boolean::New(info.Env(), true);
}

Napi::Value ConfigStore::GetConfig(const Napi::CallbackInfo &info) {
  auto result = Napi::Object::New(info.Env());
  try {
    auto config = profile_.get(getConfigFromJs(info, locator_));
    set(config, result);
  } catch (const std::exception &ex) {
    SPDLOG_ERROR("failed to GetConfig {}", ex.what());
    runtime::util::print_stack_trace();
    return Napi::Boolean::New(info.Env(), false);
  }
  return result;
}

Napi::Value ConfigStore::GetAllConfig(const Napi::CallbackInfo &info) {
  auto table = Napi::Object::New(info.Env());
  try {
    for (const auto &config : profile_.get_all(Config{})) {
      auto uid = fmt::format("{:016x}", config.uid());
      auto object = Napi::Object::New(info.Env());
      set(config, object);
      table.Set(uid, object);
    }
  } catch (const std::exception &ex) {
    SPDLOG_ERROR("failed to GetAllConfig {}", ex.what());
    runtime::util::print_stack_trace();
    return Napi::Boolean::New(info.Env(), false);
  }

  return table;
}

Napi::Value ConfigStore::RemoveConfig(const Napi::CallbackInfo &info) {
  try {
    profile_.remove(profile_.get(getConfigFromJs(info, locator_)));
  } catch (const std::exception &ex) {
    SPDLOG_ERROR("failed to RemoveConfig {}", ex.what());
    runtime::util::print_stack_trace();
    return Napi::Boolean::New(info.Env(), false);
  }
  return Napi::Boolean::New(info.Env(), true);
}

void ConfigStore::Init(Napi::Env env, Napi::Object exports) {
  Napi::HandleScope scope(env);
  env.AddCleanupHook(cleanup);

  Napi::Function func = DefineClass(env, "ConfigStore",
                                    {
                                        InstanceMethod("setConfig", &ConfigStore::SetConfig),
                                        InstanceMethod("getConfig", &ConfigStore::GetConfig),
                                        InstanceMethod("getAllConfig", &ConfigStore::GetAllConfig),
                                        InstanceMethod("removeConfig", &ConfigStore::RemoveConfig),
                                    });

  constructor = Napi::Persistent(func);
  constructor.SuppressDestruct();

  exports.Set("ConfigStore", func);
}

Napi::Value ConfigStore::NewInstance(const Napi::Value arg) { return constructor.New({arg}); }
} // namespace kungfu::node
