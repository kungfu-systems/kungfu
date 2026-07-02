// SPDX-License-Identifier: Apache-2.0

#ifndef KUNGFU_NODE_BAKSET_INSTRUMENT_H
#define KUNGFU_NODE_BAKSET_INSTRUMENT_H

#include "common.h"
#include "operators.h"

#include <kungfu/yijinjing/cache/profile.h>
#include <kungfu/yijinjing/io.h>
#include <kungfu/yijinjing/util/util.h>

namespace kungfu::node {
class BasketInstrumentStore : public Napi::ObjectWrap<BasketInstrumentStore> {
public:
  explicit BasketInstrumentStore(const Napi::CallbackInfo &info);

  ~BasketInstrumentStore() override = default;

  Napi::Value SetAllBasketInstruments(const Napi::CallbackInfo &info);

  Napi::Value GetAllBasketInstrument(const Napi::CallbackInfo &info);

  Napi::Value RemoveAllBasketInstruments(const Napi::CallbackInfo &info);

  Napi::Value RemoveAllBasketInstrumentsByBasket(const Napi::CallbackInfo &info);

  Napi::Value SetBasketInstrument(const Napi::CallbackInfo &info);

  Napi::Value SetBasketInstruments(const Napi::CallbackInfo &info);

  static void Init(Napi::Env env, Napi::Object exports);

  static Napi::Value NewInstance(Napi::Value arg);

private:
  serialize::JsGet get = {};
  serialize::JsSet set = {};
  yijinjing::data::locator_ptr locator_;
  cache::profile profile_;

  static Napi::FunctionReference constructor;
  static void cleanup() {
    SPDLOG_INFO("BasketInstrumentStore reset");
    BasketInstrumentStore::constructor.Reset();
  }
};
} // namespace kungfu::node

#endif // KUNGFU_NODE_BAKSET_INSTRUMENT_H
