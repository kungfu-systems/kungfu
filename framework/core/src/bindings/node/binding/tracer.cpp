#include "io.h"
#include "journal.h"

using namespace kungfu::runtime;
using namespace kungfu::yijinjing::data;
using namespace kungfu::runtime::journal;
using namespace kungfu::yijinjing::types;
using namespace kungfu::yijinjing::enums;

namespace kungfu::node {

Napi::FunctionReference Tracer::constructor = {};

Tracer::Tracer(const Napi::CallbackInfo &info)
    : ObjectWrap(info),                                                                           //
      tracer(IODevice::ExtractLocation(info, 0, IODevice::ExtractRuntimeLocatorByIndex(info, 1)), //
             GetBool(info, 2),                                                                    //
             GetBool(info, 3),                                                                    //
             GetBigInt(info, 4),                                                                  //
             GetBigInt(info, 5)) {
  SPDLOG_INFO("Tracer Init");
}

Tracer::~Tracer() { SPDLOG_INFO("Tracer destructor"); }

Napi::Value Tracer::DataAvailable(const Napi::CallbackInfo &info) {
  return Napi::Boolean::New(Env(), data_available());
}

Napi::Value Tracer::CurrentFrame(const Napi::CallbackInfo &info) {
  auto frame = Frame::NewInstance(info.This());
  Napi::ObjectWrap<Frame>::Unwrap(frame.As<Napi::Object>())->SetFrame(current_frame());
  return frame;
}

Napi::Value Tracer::CurrentFrameId(const Napi::CallbackInfo &info) {
  return Napi::BigInt::New(info.Env(), current_frame_id());
}

Napi::Value Tracer::CurrentPageId(const Napi::CallbackInfo &info) {
  return Napi::Number::New(info.Env(), current_page_id());
}

Napi::Value Tracer::Now(const Napi::CallbackInfo &info) { return Napi::BigInt::New(info.Env(), time::now_in_nano()); }

void Tracer::SeekToTime(const Napi::CallbackInfo &info) {
  if (not IsValid(info, 0, &Napi::Value::IsBigInt)) {
    throw Napi::Error::New(info.Env(), "Invalid bigint argument");
  }

  auto target_time = GetBigInt(info, 0);
  seek_to_time(target_time);
}

void Tracer::Next(const Napi::CallbackInfo &info) { next(); }

void Tracer::Init(Napi::Env env, Napi::Object exports) {
  Napi::HandleScope scope(env);
  env.AddCleanupHook(cleanup);

  Napi::Function func = DefineClass(env, "Tracer",
                                    {
                                        InstanceMethod("currentFrame", &Tracer::CurrentFrame),     //
                                        InstanceMethod("currentFrameId", &Tracer::CurrentFrameId), //
                                        InstanceMethod("currentPageId", &Tracer::CurrentPageId),   //
                                        InstanceMethod("dataAvailable", &Tracer::DataAvailable),   //
                                        InstanceMethod("next", &Tracer::Next),                     //
                                        InstanceMethod("now", &Tracer::Now),                       //
                                        InstanceMethod("seekToTime", &Tracer::SeekToTime),         //
                                    });
  constructor = Napi::Persistent(func);
  constructor.SuppressDestruct();

  exports.Set("Tracer", func);
}

Napi::Value Tracer::NewInstance(const Napi::Value arg) { return constructor.New({arg}); }

} // namespace kungfu::node