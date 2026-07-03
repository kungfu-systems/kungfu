// SPDX-License-Identifier: Apache-2.0

//
// Created by Keren Dong on 2020/1/1.
//

#include "journal.h"
#include "io.h"
#include <cmath>

using namespace kungfu::yijinjing;
using namespace kungfu::yijinjing::data;
using namespace kungfu::yijinjing::journal;
using namespace kungfu::longfist::types;

namespace kungfu::node {

Napi::FunctionReference Frame::constructor = {};

Frame::Frame(const Napi::CallbackInfo &info) : ObjectWrap(info) {}

void Frame::SetFrame(yijinjing::journal::frame_ptr frame) { frame_ = std::move(frame); }

Napi::Value Frame::DataLength(const Napi::CallbackInfo &info) {
  return Napi::Number::New(info.Env(), frame_->data_length());
}

Napi::Value Frame::GenTime(const Napi::CallbackInfo &info) { return Napi::BigInt::New(info.Env(), frame_->gen_time()); }

Napi::Value Frame::TriggerTime(const Napi::CallbackInfo &info) {
  return Napi::BigInt::New(info.Env(), frame_->trigger_time());
}

Napi::Value Frame::MsgType(const Napi::CallbackInfo &info) { return Napi::Number::New(info.Env(), frame_->msg_type()); }

Napi::Value Frame::Source(const Napi::CallbackInfo &info) { return Napi::Number::New(info.Env(), frame_->source()); }

Napi::Value Frame::Dest(const Napi::CallbackInfo &info) { return Napi::Number::New(info.Env(), frame_->dest()); }

Napi::Value Frame::InitialSource(const Napi::CallbackInfo &info) {
  return Napi::Number::New(info.Env(), frame_->initial_source());
}

Napi::Value Frame::Data(const Napi::CallbackInfo &info) {
  auto result = Napi::Object::New(info.Env());
  // have to be AllDataTypes, for data size is not 0
  boost::hana::for_each(longfist::AllDataTypes, [&](auto it) {
    using DataType = typename decltype(+boost::hana::second(it))::type;
    if (frame_->msg_type() == DataType::tag) {
      serialize::JsSet{}(frame_->data<DataType>(), result);
      result.DefineProperties({
          Napi::PropertyDescriptor::Value("tag", Napi::Number::New(result.Env(), DataType::tag)),
          Napi::PropertyDescriptor::Value("type", Napi::String::New(result.Env(), DataType::type_name.c_str())) //
      });
    }
  });
  return result;
}

Napi::Value Frame::DataAsString(const Napi::CallbackInfo &info) {
  std::string result = "";
  // have to be AllDataTypes, for data size is not 0
  boost::hana::for_each(longfist::AllDataTypes, [&](auto it) {
    using DataType = typename decltype(+boost::hana::second(it))::type;
    if (frame_->msg_type() == DataType::tag) {
      result = frame_->data<DataType>().to_string();
    }
  });
  return Napi::String::New(info.Env(), result);
}

Napi::Value Frame::DataBytes(const Napi::CallbackInfo &info) {
  // raw payload bytes: the decode path for open-layer frames (e.g. rewind
  // events), whose schemas are not in the compiled longfist registry above
  return Napi::Buffer<uint8_t>::Copy(info.Env(), reinterpret_cast<const uint8_t *>(frame_->data_address()),
                                     frame_->data_length());
}

void Frame::Init(Napi::Env env, Napi::Object exports) {
  Napi::HandleScope scope(env);
  env.AddCleanupHook(cleanup);

  Napi::Function func = DefineClass(env, "Frame",
                                    {
                                        InstanceMethod("dataLength", &Frame::DataLength),       //
                                        InstanceMethod("genTime", &Frame::GenTime),             //
                                        InstanceMethod("triggerTime", &Frame::TriggerTime),     //
                                        InstanceMethod("msgType", &Frame::MsgType),             //
                                        InstanceMethod("source", &Frame::Source),               //
                                        InstanceMethod("dest", &Frame::Dest),                   //
                                        InstanceMethod("initialSource", &Frame::InitialSource), //
                                        InstanceMethod("data", &Frame::Data),                   //
                                        InstanceMethod("dataAsString", &Frame::DataAsString),   //
                                        InstanceMethod("dataBytes", &Frame::DataBytes)          //
                                    });

  constructor = Napi::Persistent(func);
  constructor.SuppressDestruct();
  exports.Set("Frame", func);
}

Napi::Value Frame::NewInstance(const Napi::Value arg) { return constructor.New({arg}); }

bool lossless;
Napi::FunctionReference Reader::constructor = {};
Reader::Reader(const Napi::CallbackInfo &info)
    : ObjectWrap(info), reader(true, false, std::make_shared<bus>(false)),
      io_device_(std::make_shared<io_device>(IODevice::ExtractLocation(info, 0, IODevice::GetDefaultRuntimeLocator()),
                                             false, true)) {}

Napi::Value Reader::ToString(const Napi::CallbackInfo &info) { return Napi::String::New(info.Env(), "Reader.js"); }

Napi::Value Reader::CurrentFrame(const Napi::CallbackInfo &info) {
  auto frame = Frame::NewInstance(info.This());
  Napi::ObjectWrap<Frame>::Unwrap(frame.As<Napi::Object>())->SetFrame(current_frame());
  return frame;
}

Napi::Value Reader::SeekToTime(const Napi::CallbackInfo &info) {
  seek_to_time(GetBigInt(info, 0));
  return {};
}

Napi::Value Reader::DataAvailable(const Napi::CallbackInfo &info) {
  return Napi::Boolean::New(info.Env(), data_available());
}

Napi::Value Reader::Next(const Napi::CallbackInfo &info) {
  next();
  return {};
}

Napi::Value Reader::Join(const Napi::CallbackInfo &info) {
  auto category = longfist::enums::get_category_by_name(info[0].As<Napi::String>().Utf8Value());
  auto group = info[1].As<Napi::String>().Utf8Value();
  auto name = info[2].As<Napi::String>().Utf8Value();
  auto mode = longfist::enums::get_mode_by_name(info[3].As<Napi::String>().Utf8Value());
  uint32_t dest_id = info[4].As<Napi::Number>().Int32Value();
  auto from_time = GetBigInt(info, 5);
  join(std::make_shared<location>(mode, category, group, name, io_device_->get_live_home()->locator), dest_id,
       from_time);
  return {};
}

void Reader::Init(Napi::Env env, Napi::Object exports) {
  Napi::HandleScope scope(env);
  env.AddCleanupHook(cleanup);

  Napi::Function func = DefineClass(env, "Reader",
                                    {
                                        InstanceMethod("toString", &Reader::ToString),           //
                                        InstanceMethod("currentFrame", &Reader::CurrentFrame),   //
                                        InstanceMethod("seekToTime", &Reader::SeekToTime),       //
                                        InstanceMethod("dataAvailable", &Reader::DataAvailable), //
                                        InstanceMethod("next", &Reader::Next),                   //
                                        InstanceMethod("join", &Reader::Join),                   //
                                    });

  constructor = Napi::Persistent(func);
  constructor.SuppressDestruct();

  exports.Set("Reader", func);
}

Napi::Value Reader::NewInstance(const Napi::Value arg) { return constructor.New({arg}); }

Napi::FunctionReference Assemble::constructor = {};

Assemble::Assemble(const Napi::CallbackInfo &info) : ObjectWrap(info), assemble(IODevice::ExtractLocators(info)) {}

Napi::Value Assemble::CurrentFrame(const Napi::CallbackInfo &info) {
  auto frame = Frame::NewInstance(info.This());
  Napi::ObjectWrap<Frame>::Unwrap(frame.As<Napi::Object>())->SetFrame(current_frame());
  return frame;
}

Napi::Value Assemble::SeekToTime(const Napi::CallbackInfo &info) {
  if (not IsValid(info, 0, &Napi::Value::IsBigInt)) {
    return {};
  }
  auto time = GetBigInt(info, 0);
  for (auto &reader : readers_) {
    reader->seek_to_time(time);
  }
  return {};
}

Napi::Value Assemble::DataAvailable(const Napi::CallbackInfo &info) {
  return Napi::Boolean::New(info.Env(), data_available());
}

Napi::Value Assemble::Next(const Napi::CallbackInfo &info) {
  next();
  return {};
}

void Assemble::Init(Napi::Env env, Napi::Object exports) {
  Napi::HandleScope scope(env);
  env.AddCleanupHook(cleanup);

  Napi::Function func = DefineClass(env, "Assemble",
                                    {
                                        InstanceMethod("currentFrame", &Assemble::CurrentFrame),   //
                                        InstanceMethod("seekToTime", &Assemble::SeekToTime),       //
                                        InstanceMethod("dataAvailable", &Assemble::DataAvailable), //
                                        InstanceMethod("next", &Assemble::Next),                   //
                                    });

  constructor = Napi::Persistent(func);
  constructor.SuppressDestruct();

  exports.Set("Assemble", func);
}
} // namespace kungfu::node
