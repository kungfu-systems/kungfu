// SPDX-License-Identifier: Apache-2.0

//
// Created by Keren Dong on 2020/2/15.
//

#ifndef KUNGFU_NODE_SCHEMA_H
#define KUNGFU_NODE_SCHEMA_H

#include "common.h"
#include "operators.h"

namespace kungfu::node {
class Schema : public Napi::ObjectWrap<Schema> {
public:
  explicit Schema(const Napi::CallbackInfo &info);

  static void Init(Napi::Env env, Napi::Object exports);

  Napi::Value GetCarrierTypes(const Napi::CallbackInfo &info);

  void InitCarrierTypes(const Napi::CallbackInfo &info);

  Napi::Value GetTypes(const Napi::CallbackInfo &info);

  void InitTypes(const Napi::CallbackInfo &info);

  void NoSet(const Napi::CallbackInfo &info, const Napi::Value &value);

private:
  Napi::ObjectReference types_ref_;
  Napi::ObjectReference carrier_types_ref_;

  static Napi::FunctionReference constructor;
  static void cleanup() {
    SPDLOG_INFO("Schema reset");
    Schema::constructor.Reset();
  }
};
} // namespace kungfu::node

#endif // KUNGFU_NODE_SCHEMA_H
