// SPDX-License-Identifier: Apache-2.0

//
// Created by Keren Dong on 2020/2/25.
//

#ifndef KUNGFU_NODE_CONFIGURATION_H
#define KUNGFU_NODE_CONFIGURATION_H

#include <kungfu/yijinjing/cache/profile.h>
#include <kungfu/yijinjing/io.h>

#include "common.h"
#include "operators.h"

namespace kungfu::node {
class ConfigStore : public Napi::ObjectWrap<ConfigStore> {
public:
  explicit ConfigStore(const Napi::CallbackInfo &info);

  ~ConfigStore() override = default;

  Napi::Value SetConfig(const Napi::CallbackInfo &info);

  Napi::Value GetConfig(const Napi::CallbackInfo &info);

  Napi::Value GetAllConfig(const Napi::CallbackInfo &info);

  Napi::Value RemoveConfig(const Napi::CallbackInfo &info);

  static void Init(Napi::Env env, Napi::Object exports);

  static Napi::Value NewInstance(Napi::Value arg);

private:
  serialize::JsSet set;
  yijinjing::data::locator_ptr locator_;
  cache::profile profile_;

  static Napi::FunctionReference constructor;
  static void cleanup() {
    SPDLOG_INFO("ConfigStore reset");
    ConfigStore::constructor.Reset();
  }

  friend class Watcher;
};
} // namespace kungfu::node

#endif // KUNGFU_NODE_CONFIGURATION_H
