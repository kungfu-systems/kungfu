// SPDX-License-Identifier: Apache-2.0

#ifndef KUNGFU_NODE_ACTION_RECORDER_H
#define KUNGFU_NODE_ACTION_RECORDER_H

#include "common.h"

#include <kungfu/runtime/action_recorder.h>

#include <memory>

namespace kungfu::node {

class ActionRecorder : public Napi::ObjectWrap<ActionRecorder> {
public:
  explicit ActionRecorder(const Napi::CallbackInfo &info);

  Napi::Value RecordBytes(const Napi::CallbackInfo &info);

  Napi::Value RecordJson(const Napi::CallbackInfo &info);

  Napi::Value Mark(const Napi::CallbackInfo &info);

  Napi::Value LastFrameUid(const Napi::CallbackInfo &info);

  static void Init(Napi::Env env, Napi::Object exports);

private:
  static Napi::FunctionReference constructor;
  static void cleanup() {
    SPDLOG_INFO("ActionRecorder reset");
    ActionRecorder::constructor.Reset();
  }

  std::unique_ptr<runtime::action::action_recorder> recorder_;
};

} // namespace kungfu::node

#endif // KUNGFU_NODE_ACTION_RECORDER_H
