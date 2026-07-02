// SPDX-License-Identifier: Apache-2.0

//
// Created by Keren Dong on 2020/3/17.
//

#include <sstream>

#include "history.h"
#include "io.h"
#include "operators.h"

using namespace kungfu::rx;
using namespace kungfu::longfist;
using namespace kungfu::longfist::enums;
using namespace kungfu::longfist::types;
using namespace kungfu::cache;
using namespace kungfu::yijinjing;
using namespace kungfu::yijinjing::data;

namespace kungfu::node {
Napi::FunctionReference History::constructor = {};

History::History(const Napi::CallbackInfo &info)
    : ObjectWrap(info), locator_(IODevice::ExtractRuntimeLocatorByIndex(info, 0)),
      ledger_location_(location::make_shared(mode::LIVE, category::SYSTEM, "service", "ledger", locator_)),
      renderer_location_(location::make_shared(mode::LIVE, category::SYSTEM, "node", "renderer-app", locator_)),
      profile_(locator_) {}

Napi::Value History::SelectPeriod(const Napi::CallbackInfo &info) {
  auto parse_time = [&](auto i) { return yijinjing::time::strptime(info[i].ToString().Utf8Value(), KUNGFU_HISTORY_DAY_FORMAT); };
  try {
    int64_t from = parse_time(0);
    int64_t to = info.Length() > 1 ? parse_time(1) : from + yijinjing::time_unit::NANOSECONDS_PER_DAY;
    SPDLOG_INFO("select period from {} to {}", yijinjing::time::strftime(from), yijinjing::time::strftime(to));
    Napi::ObjectReference result_ref = Napi::ObjectReference::New(Napi::Object::New(info.Env()));
    serialize::InitStateMap(info, result_ref, "history");
    for (const auto &config : profile_.get_all(Config{})) {
      auto state_location = location::make_shared(config, locator_);
      serialize::JsRestoreState(result_ref, state_location)(from, to);
    }
    serialize::JsRestoreState(result_ref, renderer_location_)(from, to);
    serialize::JsRestoreState(result_ref, ledger_location_)(from, to);
    return result_ref.Value();
  } catch (const std::exception &ex) {
    SPDLOG_ERROR("failed to select: {}", ex.what());
    yijinjing::util::print_stack_trace();
    return Napi::Boolean::New(info.Env(), false);
  }
}

void History::Init(Napi::Env env, Napi::Object exports) {
  Napi::HandleScope scope(env);
  env.AddCleanupHook(cleanup);

  Napi::Function func = DefineClass(env, "History", {InstanceMethod("selectPeriod", &History::SelectPeriod)});

  constructor = Napi::Persistent(func);
  constructor.SuppressDestruct();

  exports.Set("History", func);
}

Napi::Value History::NewInstance(const Napi::Value arg) { return constructor.New({arg}); }
} // namespace kungfu::node
