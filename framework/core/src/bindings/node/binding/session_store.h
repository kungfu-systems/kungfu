#ifndef KUNGFU_NODE_SESSION_STORE_H
#define KUNGFU_NODE_SESSION_STORE_H

#include "common.h"
#include "io.h"
#include "operators.h"
#include <kungfu/yijinjing/index/session.h>
#include <kungfu/yijinjing/io.h>
#include <kungfu/yijinjing/time.h>

namespace kungfu::node {

class SessionStore : public Napi::ObjectWrap<SessionStore> {
public:
  explicit SessionStore(const Napi::CallbackInfo &info);

  ~SessionStore();

  Napi::Value GetAllSessions(const Napi::CallbackInfo &info);

  Napi::Value GetSessionsForLocation(const Napi::CallbackInfo &info);

  static void Init(Napi::Env, Napi::Object exports);

  static Napi::Value NewInstance(Napi::Value arg);

private:
  serialize::JsSet set;
  yijinjing::io_device_ptr io_device_;

  Napi::Value ParseSessions(const Napi::CallbackInfo &info, index::SessionVector sessions) {
    size_t session_size = sessions.size();
    auto list = Napi::Array::New(info.Env(), session_size);
    for (int i = 0; i < session_size; i++) {
      const auto &session = sessions[i];
      auto session_obj = Napi::Object::New(info.Env());
      set(session, session_obj);
      session_obj.Set(Napi::String::New(info.Env(), "index"), Napi::Number::New(info.Env(), i));
      list.Set(i, session_obj);
    }
    return list;
  }

  static Napi::FunctionReference constructor;
  static void cleanup() {
    SPDLOG_INFO("SessionStore reset");
    SessionStore::constructor.Reset();
  }
};

} // namespace kungfu::node

#endif // KUNGFU_NODE_SESSION_STORE_H