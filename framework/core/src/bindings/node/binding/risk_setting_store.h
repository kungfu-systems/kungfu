// SPDX-License-Identifier: Apache-2.0

//
// Created by Keren Dong on 2020/2/25.
//

#ifndef KUNGFU_NODE_RISKSETTING_H
#define KUNGFU_NODE_RISKSETTING_H

#include <kungfu/yijinjing/cache/profile.h>
#include <kungfu/yijinjing/io.h>

#include "common.h"
#include "operators.h"

namespace kungfu::node {
class RiskSettingStore : public Napi::ObjectWrap<RiskSettingStore> {
public:
  explicit RiskSettingStore(const Napi::CallbackInfo &info);

  ~RiskSettingStore() override = default;

  Napi::Value SetRiskSetting(const Napi::CallbackInfo &info);

  Napi::Value GetRiskSetting(const Napi::CallbackInfo &info);

  Napi::Value GetAllRiskSetting(const Napi::CallbackInfo &info);

  Napi::Value SetAllRiskSetting(const Napi::CallbackInfo &info);

  Napi::Value RemoveRiskSetting(const Napi::CallbackInfo &info);

  static void Init(Napi::Env env, Napi::Object exports);

  static Napi::Value NewInstance(Napi::Value arg);

private:
  serialize::JsGet get = {};
  serialize::JsSet set = {};
  yijinjing::data::locator_ptr locator_;
  cache::profile profile_;

  static Napi::FunctionReference constructor;
  static void cleanup() {
    SPDLOG_INFO("RiskSettingStore reset");
    RiskSettingStore::constructor.Reset();
  }
};
} // namespace kungfu::node

#endif // KUNGFU_NODE_CONFIGURATION_H
