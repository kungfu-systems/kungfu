// SPDX-License-Identifier: Apache-2.0

#include "action_recorder.h"

#include <vector>

using kungfu::runtime::action::record_options;
using kungfu::runtime::action::record_receipt;

namespace kungfu::node {

Napi::FunctionReference ActionRecorder::constructor = {};

namespace {

uint64_t read_uint64(const Napi::Value &value) {
  if (value.IsBigInt()) {
    bool lossless = false;
    return value.As<Napi::BigInt>().Uint64Value(&lossless);
  }
  if (value.IsNumber()) {
    return static_cast<uint64_t>(value.As<Napi::Number>().Int64Value());
  }
  return 0;
}

record_options read_options(const Napi::CallbackInfo &info, size_t index) {
  record_options options{};
  if (info.Length() <= index || info[index].IsEmpty() || info[index].IsUndefined()) {
    return options;
  }
  if (!info[index].IsObject()) {
    throw Napi::TypeError::New(info.Env(), "ActionRecorder options must be an object");
  }

  auto object = info[index].As<Napi::Object>();
  if (object.Has("genTime")) {
    options.gen_time = static_cast<int64_t>(read_uint64(object.Get("genTime")));
  }
  if (object.Has("triggerTime")) {
    options.trigger_time = static_cast<int64_t>(read_uint64(object.Get("triggerTime")));
  }
  if (object.Has("parentFrameUid")) {
    options.parent_frame_uid = read_uint64(object.Get("parentFrameUid"));
  }
  if (object.Has("streamId")) {
    options.stream_id = read_uint64(object.Get("streamId"));
  }
  if (object.Has("chainToLast")) {
    options.chain_to_last = object.Get("chainToLast").ToBoolean().Value();
  }
  return options;
}

std::vector<uint8_t> read_bytes(const Napi::CallbackInfo &info, size_t index) {
  if (info.Length() <= index || info[index].IsEmpty() || info[index].IsUndefined()) {
    throw Napi::TypeError::New(info.Env(), "payload must be a Buffer or Uint8Array");
  }

  auto value = info[index];
  if (value.IsBuffer()) {
    auto buffer = value.As<Napi::Buffer<uint8_t>>();
    return {buffer.Data(), buffer.Data() + buffer.Length()};
  }
  if (value.IsTypedArray()) {
    auto typed_array = value.As<Napi::TypedArray>();
    if (typed_array.TypedArrayType() == napi_uint8_array) {
      auto uint8_array = value.As<Napi::Uint8Array>();
      auto data = static_cast<uint8_t *>(uint8_array.ArrayBuffer().Data()) + uint8_array.ByteOffset();
      return {data, data + uint8_array.ByteLength()};
    }
  }

  throw Napi::TypeError::New(info.Env(), "payload must be a Buffer or Uint8Array");
}

Napi::Object to_receipt_object(Napi::Env env, const record_receipt &receipt) {
  auto object = Napi::Object::New(env);
  object.Set("frameUid", Napi::BigInt::New(env, receipt.frame_uid));
  object.Set("triggerFrameUid", Napi::BigInt::New(env, receipt.trigger_frame_uid));
  object.Set("streamId", Napi::BigInt::New(env, receipt.stream_id));
  object.Set("genTime", Napi::BigInt::New(env, receipt.gen_time));
  object.Set("triggerTime", Napi::BigInt::New(env, receipt.trigger_time));
  object.Set("carrierType", Napi::Number::New(env, receipt.carrier_type));
  object.Set("source", Napi::Number::New(env, receipt.source));
  object.Set("initialSource", Napi::Number::New(env, receipt.initial_source));
  object.Set("dest", Napi::Number::New(env, receipt.dest));
  object.Set("dataLength", Napi::Number::New(env, receipt.data_length));
  object.Set("dataType", Napi::Number::New(env, receipt.data_type));
  object.Set("integrityVersion", Napi::Number::New(env, receipt.integrity_version));
  object.Set("checksumAlgorithm", Napi::String::New(env, runtime::action::FRAME_CHECKSUM_ALGORITHM_FNV1A64));
  object.Set("payloadChecksum", Napi::BigInt::New(env, receipt.payload_checksum));
  object.Set("frameChecksum", Napi::BigInt::New(env, receipt.frame_checksum));
  return object;
}

} // namespace

ActionRecorder::ActionRecorder(const Napi::CallbackInfo &info) : ObjectWrap(info) {
  if (!IsValid(info, 0, &Napi::Value::IsString) || !IsValid(info, 1, &Napi::Value::IsString) ||
      !IsValid(info, 2, &Napi::Value::IsString)) {
    throw Napi::TypeError::New(info.Env(), "ActionRecorder(runtimeDir, group, name, destId?, streamId?)");
  }

  const auto runtime_dir = info[0].As<Napi::String>().Utf8Value();
  const auto group = info[1].As<Napi::String>().Utf8Value();
  const auto name = info[2].As<Napi::String>().Utf8Value();
  const auto dest_id =
      IsValid(info, 3) ? static_cast<uint32_t>(read_uint64(info[3])) : yijinjing::data::location::PUBLIC;
  const auto stream_id = IsValid(info, 4) ? read_uint64(info[4]) : 0;
  recorder_ = std::make_unique<runtime::action::action_recorder>(runtime_dir, group, name, dest_id, stream_id);
}

Napi::Value ActionRecorder::RecordBytes(const Napi::CallbackInfo &info) {
  if (!IsValid(info, 0, &Napi::Value::IsNumber)) {
    throw Napi::TypeError::New(info.Env(), "recordBytes(carrierType, payload, options?)");
  }
  const auto carrier_type = info[0].As<Napi::Number>().Int32Value();
  const auto payload = read_bytes(info, 1);
  const auto options = read_options(info, 2);
  return to_receipt_object(info.Env(), recorder_->record_bytes(carrier_type, payload, options));
}

Napi::Value ActionRecorder::RecordJson(const Napi::CallbackInfo &info) {
  if (!IsValid(info, 0, &Napi::Value::IsNumber) || !IsValid(info, 1, &Napi::Value::IsString)) {
    throw Napi::TypeError::New(info.Env(), "recordJson(carrierType, jsonPayload, options?)");
  }
  const auto carrier_type = info[0].As<Napi::Number>().Int32Value();
  const auto payload = info[1].As<Napi::String>().Utf8Value();
  const auto options = read_options(info, 2);
  return to_receipt_object(info.Env(), recorder_->record_json(carrier_type, payload, options));
}

Napi::Value ActionRecorder::Mark(const Napi::CallbackInfo &info) {
  if (!IsValid(info, 0, &Napi::Value::IsNumber)) {
    throw Napi::TypeError::New(info.Env(), "mark(carrierType, options?)");
  }
  const auto carrier_type = info[0].As<Napi::Number>().Int32Value();
  const auto options = read_options(info, 1);
  return to_receipt_object(info.Env(), recorder_->mark(carrier_type, options));
}

Napi::Value ActionRecorder::LastFrameUid(const Napi::CallbackInfo &info) {
  return Napi::BigInt::New(info.Env(), recorder_->last_frame_uid());
}

void ActionRecorder::Init(Napi::Env env, Napi::Object exports) {
  Napi::HandleScope scope(env);
  env.AddCleanupHook(cleanup);

  Napi::Function func = DefineClass(env, "ActionRecorder",
                                    {
                                        InstanceMethod("recordBytes", &ActionRecorder::RecordBytes),
                                        InstanceMethod("recordJson", &ActionRecorder::RecordJson),
                                        InstanceMethod("mark", &ActionRecorder::Mark),
                                        InstanceMethod("lastFrameUid", &ActionRecorder::LastFrameUid),
                                    });

  constructor = Napi::Persistent(func);
  constructor.SuppressDestruct();
  exports.Set("ActionRecorder", func);
  exports.Set("FRAME_CHECKSUM_ALGORITHM_FNV1A64",
              Napi::String::New(env, runtime::action::FRAME_CHECKSUM_ALGORITHM_FNV1A64));
}

} // namespace kungfu::node
