// SPDX-License-Identifier: Apache-2.0

#ifndef KUNGFU_NODE_BAKSET_H
#define KUNGFU_NODE_BAKSET_H

#include "common.h"
#include "operators.h"

#include <kungfu/yijinjing/cache/profile.h>
#include <kungfu/yijinjing/io.h>
#include <kungfu/yijinjing/util/util.h>

namespace kungfu::node {
class BasketStore : public Napi::ObjectWrap<BasketStore> {
public:
  explicit BasketStore(const Napi::CallbackInfo &info);

  ~BasketStore() override = default;

  Napi::Value SetAllBasket(const Napi::CallbackInfo &info);

  Napi::Value SetBasket(const Napi::CallbackInfo &info);

  Napi::Value SetBaskets(const Napi::CallbackInfo &info);

  Napi::Value GetAllBasket(const Napi::CallbackInfo &info);

  static void Init(Napi::Env env, Napi::Object exports);

  static Napi::Value NewInstance(Napi::Value arg);

private:
  serialize::JsGet get = {};
  serialize::JsSet set = {};
  yijinjing::data::locator_ptr locator_;
  cache::profile profile_;

  static Napi::FunctionReference constructor;
  static void cleanup() {
    SPDLOG_INFO("BasketStore reset");
    BasketStore::constructor.Reset();
  }
};
} // namespace kungfu::node

#endif // KUNGFU_NODE_BAKSET_H
