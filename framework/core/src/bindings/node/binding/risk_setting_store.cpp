// SPDX-License-Identifier: Apache-2.0

//
// Created by Keren Dong on 2020/2/25.
//

#include "risk_setting_store.h"
#include "io.h"

using namespace kungfu::longfist;
using namespace kungfu::longfist::enums;
using namespace kungfu::longfist::types;
using namespace kungfu::yijinjing;
using namespace kungfu::yijinjing::data;

namespace kungfu::node {
Napi::FunctionReference RiskSettingStore::constructor = {};

RiskSettingStore::RiskSettingStore(const Napi::CallbackInfo &info)
    : ObjectWrap(info), locator_(IODevice::ExtractRuntimeLocatorByIndex(info, 0)), profile_(locator_) {}

inline RiskSetting getConfigFromJs(const Napi::CallbackInfo &info, const locator_ptr &locator) {
  RiskSetting query = {};
  auto config_location = IODevice::ExtractLocation(info, 0, locator);
  if (config_location) {
    query.location_uid = config_location->uid;
    query.role = config_location->role;
    query.group = config_location->group;
    query.name = config_location->name;
    query.mode = config_location->mode;
  }
  return query;
}

Napi::Value RiskSettingStore::SetRiskSetting(const Napi::CallbackInfo &info) {
  RiskSetting risk_setting = getConfigFromJs(info, locator_);
  int valueIndex = info[0].IsObject() ? 1 : 4;
  if (info[0].IsObject()) {
    risk_setting.value = info[0].ToObject().Get("value").ToString().Utf8Value();
  } else {
    risk_setting.value = info[valueIndex].ToString().Utf8Value();
  }
  try {
    profile_.set(risk_setting);
  } catch (const std::exception &ex) {
    SPDLOG_ERROR("failed to SetRiskSetting {}", ex.what());
    return Napi::Boolean::New(info.Env(), false);
  }

  return Napi::Boolean::New(info.Env(), true);
}

Napi::Value RiskSettingStore::GetRiskSetting(const Napi::CallbackInfo &info) {
  auto result = Napi::Object::New(info.Env());
  try {
    auto risk_setting = profile_.get(getConfigFromJs(info, locator_));
    set(risk_setting, result);
  } catch (const std::exception &ex) {
    SPDLOG_ERROR("failed to GetRiskSetting {}", ex.what());
    return Napi::Boolean::New(info.Env(), false);
  }

  return result;
}

Napi::Value RiskSettingStore::SetAllRiskSetting(const Napi::CallbackInfo &info) {
  try {
    if (info[0].IsArray()) {
      auto args = info[0].As<Napi::Array>();
      std::vector<RiskSetting> risk_settings;
      for (int i = 0; i < args.Length(); i++) {
        auto location =
            location::make_shared(get_mode_by_name(args.Get(i).ToObject().Get("mode").ToString().Utf8Value()),
                                  get_location_role_by_name(args.Get(i).ToObject().Get("role").ToString().Utf8Value()),
                                  args.Get(i).ToObject().Get("group").ToString().Utf8Value(),
                                  args.Get(i).ToObject().Get("name").ToString().Utf8Value(), locator_);

        if (location) {
          RiskSetting risk_setting = {};
          risk_setting.location_uid = location->uid;
          risk_setting.role = location->role;
          risk_setting.group = location->group;
          risk_setting.name = location->name;
          risk_setting.mode = location->mode;
          risk_setting.risk_name = args.Get(i).ToObject().Get("risk_name").ToString().Utf8Value();
          risk_setting.value = args.Get(i).ToObject().Get("value").ToString().Utf8Value();
          risk_settings.push_back(risk_setting);
        };
      }

      try {
        profile_.remove_all<RiskSetting>();
        for (auto risk_setting : risk_settings) {
          profile_.set(risk_setting);
        }
      } catch (const std::exception &ex) {
        SPDLOG_ERROR("failed to SetAllRiskSetting {}", ex.what());
        return Napi::Boolean::New(info.Env(), false);
      }

      return Napi::Boolean::New(info.Env(), true);
    }
  } catch (const std::exception &ex) {
    SPDLOG_ERROR("failed to set risk_settings {}", ex.what());
  }
  return Napi::Boolean::New(info.Env(), false);
}

Napi::Value RiskSettingStore::GetAllRiskSetting(const Napi::CallbackInfo &info) {
  auto table = Napi::Object::New(info.Env());
  try {
    for (const auto &risk_setting : profile_.get_all(RiskSetting{})) {
      auto uid = fmt::format("{:016x}", risk_setting.uid());
      auto object = Napi::Object::New(info.Env());
      set(risk_setting, object);
      table.Set(uid, object);
    }
  } catch (const std::exception &ex) {
    SPDLOG_ERROR("failed to GetAllRiskSetting {}", ex.what());
    yijinjing::util::print_stack_trace();
    return Napi::Boolean::New(info.Env(), false);
  }

  return table;
}

Napi::Value RiskSettingStore::RemoveRiskSetting(const Napi::CallbackInfo &info) {
  try {
    profile_.remove(profile_.get(getConfigFromJs(info, locator_)));
  } catch (const std::exception &ex) {
    SPDLOG_ERROR("failed to RemoveRiskSetting {}", ex.what());
    return Napi::Boolean::New(info.Env(), false);
  }
  return Napi::Boolean::New(info.Env(), true);
}

void RiskSettingStore::Init(Napi::Env env, Napi::Object exports) {
  Napi::HandleScope scope(env);
  env.AddCleanupHook(cleanup);

  Napi::Function func = DefineClass(env, "RiskSettingStore",
                                    {
                                        InstanceMethod("setRiskSetting", &RiskSettingStore::SetRiskSetting),
                                        InstanceMethod("getRiskSetting", &RiskSettingStore::GetRiskSetting),
                                        InstanceMethod("getAllRiskSetting", &RiskSettingStore::GetAllRiskSetting),
                                        InstanceMethod("setAllRiskSetting", &RiskSettingStore::SetAllRiskSetting),
                                        InstanceMethod("removeRiskSetting", &RiskSettingStore::RemoveRiskSetting),
                                    });

  constructor = Napi::Persistent(func);
  constructor.SuppressDestruct();

  exports.Set("RiskSettingStore", func);
}

Napi::Value RiskSettingStore::NewInstance(const Napi::Value arg) { return constructor.New({arg}); }
} // namespace kungfu::node
