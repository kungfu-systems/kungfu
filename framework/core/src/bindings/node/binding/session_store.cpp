#include "session_store.h"

using namespace kungfu::longfist;
using namespace kungfu::longfist::types;
using namespace kungfu::longfist::enums;
using namespace kungfu::yijinjing;
using namespace kungfu::yijinjing::data;

namespace kungfu::node {

Napi::FunctionReference SessionStore::constructor = {};

SessionStore::SessionStore(const Napi::CallbackInfo &info)
    : ObjectWrap(info),                                                                                      //
      io_device_(std::make_shared<io_device>(                                                                //
          IODevice::ExtractLocation(info, 0, IODevice::ExtractRuntimeLocatorByIndex(info, 1)), false, true)) //
{};

SessionStore::~SessionStore() { io_device_.reset(); }

// Session lookups read the index storage, which can throw under
// cross-process contention (e.g. SQLITE_BUSY past the busy timeout). A plain
// std::exception escaping a napi callback terminates the whole process;
// rethrow as a JS-catchable error instead.
Napi::Value SessionStore::GetAllSessions(const Napi::CallbackInfo &info) {
  try {
    auto session_finder = std::make_shared<index::session_finder>(io_device_);
    auto sessions = session_finder->find_sessions(time::restore_start(), INT64_MAX);
    return ParseSessions(info, sessions);
  } catch (const std::exception &ex) {
    SPDLOG_ERROR("failed to GetAllSessions {}", ex.what());
    throw Napi::Error::New(info.Env(), ex.what());
  }
}

Napi::Value SessionStore::GetSessionsForLocation(const Napi::CallbackInfo &info) {
  try {
    auto session_finder = std::make_shared<index::session_finder>(io_device_);
    auto location = IODevice::ExtractLocation(info, 0, io_device_->get_locator());
    auto sessions = session_finder->find_sessions_for(location, time::restore_start(), INT64_MAX);
    return ParseSessions(info, sessions);
  } catch (const std::exception &ex) {
    SPDLOG_ERROR("failed to GetSessionsForLocation {}", ex.what());
    throw Napi::Error::New(info.Env(), ex.what());
  }
}

void SessionStore::Init(Napi::Env env, Napi::Object exports) {
  Napi::HandleScope scope(env);
  env.AddCleanupHook(cleanup);

  Napi::Function func = DefineClass(env, "SessionStore",
                                    {
                                        InstanceMethod("getAllSessions", &SessionStore::GetAllSessions),
                                        InstanceMethod("getSessionsForLocation", &SessionStore::GetSessionsForLocation),
                                    });

  constructor = Napi::Persistent(func);
  constructor.SuppressDestruct();

  exports.Set("SessionStore", func);
}

Napi::Value SessionStore::NewInstance(const Napi::Value arg) { return constructor.New({arg}); }

} // namespace kungfu::node