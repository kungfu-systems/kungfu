// SPDX-License-Identifier: Apache-2.0

//
// Created by Keren Dong on 2020/3/17.
//

#ifndef KUNGFU_NODE_HISTORY_H
#define KUNGFU_NODE_HISTORY_H

#include "common.h"

#include <kungfu/yijinjing/cache/profile.h>
#include <kungfu/yijinjing/common.h>

namespace kungfu::node {
class History : public Napi::ObjectWrap<History> {
public:
  explicit History(const Napi::CallbackInfo &info);

  ~History() override = default;

  static void Init(Napi::Env env, Napi::Object exports);

  Napi::Value SelectPeriod(const Napi::CallbackInfo &info);

  static Napi::Value NewInstance(Napi::Value arg);

private:
  yijinjing::data::locator_ptr locator_;
  yijinjing::data::location_ptr ledger_location_;
  yijinjing::data::location_ptr renderer_location_;
  cache::profile profile_;
  static Napi::FunctionReference constructor;
  static void cleanup() {
    SPDLOG_INFO("History reset");
    History::constructor.Reset();
  }
};
} // namespace kungfu::node

#endif // KUNGFU_NODE_HISTORY_H
