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

std::string read_string(const Napi::Object &object, const char *key) {
  return object.Has(key) && object.Get(key).IsString() ? object.Get(key).As<Napi::String>().Utf8Value() : std::string{};
}

uint64_t read_uint64(const Napi::Object &object, const char *key, uint64_t fallback = 0) {
  return object.Has(key) ? read_uint64(object.Get(key)) : fallback;
}

int64_t read_int64(const Napi::Object &object, const char *key, int64_t fallback = 0) {
  return object.Has(key) ? static_cast<int64_t>(read_uint64(object.Get(key))) : fallback;
}

std::vector<uint8_t> read_bytes_value(const Napi::Value &value) {
  if (value.IsBuffer()) {
    const auto buffer = value.As<Napi::Buffer<uint8_t>>();
    return {buffer.Data(), buffer.Data() + buffer.Length()};
  }
  if (value.IsTypedArray()) {
    const auto typed_array = value.As<Napi::TypedArray>();
    if (typed_array.TypedArrayType() == napi_uint8_array) {
      const auto array = value.As<Napi::Uint8Array>();
      const auto data = static_cast<uint8_t *>(array.ArrayBuffer().Data()) + array.ByteOffset();
      return {data, data + array.ByteLength()};
    }
  }
  if (value.IsArray()) {
    const auto array = value.As<Napi::Array>();
    std::vector<uint8_t> result;
    result.reserve(array.Length());
    for (uint32_t index = 0; index < array.Length(); ++index)
      result.push_back(static_cast<uint8_t>(array.Get(index).As<Napi::Number>().Uint32Value()));
    return result;
  }
  return {};
}

runtime::action::record_options action_options_from_value(const Napi::CallbackInfo &info, size_t index) {
  return read_options(info, index);
}

view::action::payload_encoding read_payload_encoding(const Napi::Value &value) {
  using encoding = view::action::payload_encoding;
  if (value.IsNumber())
    return static_cast<encoding>(value.As<Napi::Number>().Uint32Value());
  const auto name = value.IsString() ? value.As<Napi::String>().Utf8Value() : std::string{};
  if (name == "flatbuffers")
    return encoding::FlatBuffers;
  if (name == "json")
    return encoding::Json;
  if (name == "content-reference")
    return encoding::ContentReference;
  if (name == "opaque")
    return encoding::Opaque;
  return encoding::None;
}

view::action::envelope read_action_envelope(const Napi::Object &object) {
  using namespace view::action;
  envelope result{};
  result.version = static_cast<uint16_t>(read_uint64(object, "version", ACTION_ENVELOPE_VERSION));
  result.action_type = read_string(object, "action_type");
  if (!object.Has("schema_ref") || !object.Get("schema_ref").IsObject())
    throw Napi::TypeError::New(object.Env(), "action envelope requires schema_ref");
  const auto schema = object.Get("schema_ref").As<Napi::Object>();
  result.schema_ref = {read_string(schema, "id"), static_cast<uint32_t>(read_uint64(schema, "version", 1))};
  if (object.Has("actor") && object.Get("actor").IsObject()) {
    const auto value = object.Get("actor").As<Napi::Object>();
    result.actor = actor_metadata{read_string(value, "id"), read_string(value, "kind"),
                                  read_string(value, "storage_source_id"), read_string(value, "source_type")};
  }
  if (object.Has("session") && object.Get("session").IsObject()) {
    const auto value = object.Get("session").As<Napi::Object>();
    result.session = session_metadata{read_string(value, "run_id"), read_string(value, "import_id")};
  }
  if (object.Has("source") && object.Get("source").IsObject()) {
    const auto value = object.Get("source").As<Napi::Object>();
    result.source =
        source_metadata{read_string(value, "kind"), read_string(value, "source_id"), read_string(value, "source_path"),
                        read_string(value, "source_time"), static_cast<uint32_t>(read_uint64(value, "schema_version"))};
  }
  if (object.Has("batch") && object.Get("batch").IsObject()) {
    const auto value = object.Get("batch").As<Napi::Object>();
    result.batch = batch_metadata{read_string(value, "repo_root"),
                                  read_string(value, "repo_head"),
                                  static_cast<uint32_t>(read_uint64(value, "schema_version")),
                                  read_uint64(value, "missions"),
                                  read_uint64(value, "goals"),
                                  read_uint64(value, "markers"),
                                  read_uint64(value, "warnings")};
  }
  if (object.Has("journal") && object.Get("journal").IsObject()) {
    const auto value = object.Get("journal").As<Napi::Object>();
    result.journal =
        journal_metadata{read_uint64(value, "frame_uid"),
                         read_uint64(value, "trigger_frame_uid"),
                         read_uint64(value, "stream_id"),
                         read_int64(value, "gen_time"),
                         read_int64(value, "trigger_time"),
                         static_cast<int32_t>(read_int64(value, "carrier_type", ACTION_ENVELOPE_CARRIER_TYPE)),
                         static_cast<uint32_t>(read_uint64(value, "source")),
                         static_cast<uint32_t>(read_uint64(value, "initial_source")),
                         static_cast<uint32_t>(read_uint64(value, "dest")),
                         static_cast<uint32_t>(read_uint64(value, "data_length")),
                         static_cast<int8_t>(read_int64(value, "data_type")),
                         static_cast<uint32_t>(read_uint64(value, "integrity_version")),
                         read_string(value, "checksum_algorithm"),
                         read_uint64(value, "payload_checksum"),
                         read_uint64(value, "frame_checksum")};
  }
  if (object.Has("payload") && object.Get("payload").IsObject()) {
    const auto value = object.Get("payload").As<Napi::Object>();
    result.payload =
        payload_view{read_payload_encoding(value.Has("encoding") ? value.Get("encoding") : value.Env().Undefined()),
                     value.Has("data") ? read_bytes_value(value.Get("data")) : std::vector<uint8_t>{},
                     read_string(value, "hash_algorithm"),
                     read_string(value, "hash"),
                     read_uint64(value, "byte_len"),
                     read_string(value, "content_type"),
                     read_string(value, "state")};
  }
  return result;
}

Napi::Object action_envelope_to_object(Napi::Env env, const view::action::envelope &value) {
  auto result = Napi::Object::New(env);
  result.Set("version", value.version);
  result.Set("action_type", value.action_type);
  auto schema = Napi::Object::New(env);
  schema.Set("id", value.schema_ref.id);
  schema.Set("version", value.schema_ref.version);
  result.Set("schema_ref", schema);
  if (value.actor.has_value()) {
    auto object = Napi::Object::New(env);
    object.Set("id", value.actor->id);
    object.Set("kind", value.actor->kind);
    object.Set("storage_source_id", value.actor->storage_source_id);
    object.Set("source_type", value.actor->source_type);
    result.Set("actor", object);
  }
  if (value.session.has_value()) {
    auto object = Napi::Object::New(env);
    object.Set("run_id", value.session->run_id);
    object.Set("import_id", value.session->import_id);
    result.Set("session", object);
  }
  if (value.source.has_value()) {
    auto object = Napi::Object::New(env);
    object.Set("kind", value.source->kind);
    object.Set("source_id", value.source->source_id);
    object.Set("source_path", value.source->source_path);
    object.Set("source_time", value.source->source_time);
    object.Set("schema_version", value.source->schema_version);
    result.Set("source", object);
  }
  if (value.batch.has_value()) {
    auto object = Napi::Object::New(env);
    object.Set("repo_root", value.batch->repo_root);
    object.Set("repo_head", value.batch->repo_head);
    object.Set("schema_version", value.batch->schema_version);
    object.Set("missions", Napi::BigInt::New(env, value.batch->missions));
    object.Set("goals", Napi::BigInt::New(env, value.batch->goals));
    object.Set("markers", Napi::BigInt::New(env, value.batch->markers));
    object.Set("warnings", Napi::BigInt::New(env, value.batch->warnings));
    result.Set("batch", object);
  }
  if (value.journal.has_value()) {
    auto object = Napi::Object::New(env);
    object.Set("frame_uid", Napi::BigInt::New(env, value.journal->frame_uid));
    object.Set("trigger_frame_uid", Napi::BigInt::New(env, value.journal->trigger_frame_uid));
    object.Set("stream_id", Napi::BigInt::New(env, value.journal->stream_id));
    object.Set("gen_time", Napi::BigInt::New(env, value.journal->gen_time));
    object.Set("trigger_time", Napi::BigInt::New(env, value.journal->trigger_time));
    object.Set("carrier_type", value.journal->carrier_type);
    object.Set("source", value.journal->source);
    object.Set("initial_source", value.journal->initial_source);
    object.Set("dest", value.journal->dest);
    object.Set("data_length", value.journal->data_length);
    object.Set("data_type", value.journal->data_type);
    object.Set("integrity_version", value.journal->integrity_version);
    object.Set("checksum_algorithm", value.journal->checksum_algorithm);
    object.Set("payload_checksum", Napi::BigInt::New(env, value.journal->payload_checksum));
    object.Set("frame_checksum", Napi::BigInt::New(env, value.journal->frame_checksum));
    result.Set("journal", object);
  }
  if (value.payload.has_value()) {
    auto object = Napi::Object::New(env);
    object.Set("encoding", static_cast<uint8_t>(value.payload->encoding));
    object.Set("data", Napi::Buffer<uint8_t>::Copy(env, value.payload->data.data(), value.payload->data.size()));
    object.Set("hash_algorithm", value.payload->hash_algorithm);
    object.Set("hash", value.payload->hash);
    object.Set("byte_len", Napi::BigInt::New(env, value.payload->byte_len));
    object.Set("content_type", value.payload->content_type);
    object.Set("state", value.payload->state);
    result.Set("payload", object);
  }
  return result;
}

Napi::Value EncodeActionEnvelope(const Napi::CallbackInfo &info) {
  if (!IsValid(info, 0, &Napi::Value::IsObject))
    throw Napi::TypeError::New(info.Env(), "encodeActionEnvelope(value)");
  const auto encoded = view::action::encode(read_action_envelope(info[0].As<Napi::Object>()));
  return Napi::Buffer<uint8_t>::Copy(info.Env(), encoded.data(), encoded.size());
}

Napi::Value DecodeActionEnvelope(const Napi::CallbackInfo &info) {
  if (!IsValid(info, 0))
    throw Napi::TypeError::New(info.Env(), "decodeActionEnvelope(value)");
  const auto encoded = read_bytes_value(info[0]);
  const auto decoded = view::action::decode(encoded);
  return decoded.has_value() ? action_envelope_to_object(info.Env(), *decoded) : info.Env().Null();
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
  object.Set("checksumAlgorithm", Napi::String::New(env, receipt.checksum_algorithm));
  object.Set("payloadChecksum", Napi::BigInt::New(env, receipt.payload_checksum));
  object.Set("frameChecksum", Napi::BigInt::New(env, receipt.frame_checksum));
  return object;
}

} // namespace

ActionRecorder::ActionRecorder(const Napi::CallbackInfo &info) : ObjectWrap(info) {
  if (!IsValid(info, 0, &Napi::Value::IsString) || !IsValid(info, 1, &Napi::Value::IsString) ||
      !IsValid(info, 2, &Napi::Value::IsString)) {
    throw Napi::TypeError::New(info.Env(), "ActionRecorder(runtimeDir, namespace, name, destId?, streamId?)");
  }

  const auto runtime_dir = info[0].As<Napi::String>().Utf8Value();
  const auto namespace_ = info[1].As<Napi::String>().Utf8Value();
  const auto name = info[2].As<Napi::String>().Utf8Value();
  const auto dest_id =
      IsValid(info, 3) ? static_cast<uint32_t>(read_uint64(info[3])) : yijinjing::data::location::PUBLIC;
  const auto stream_id = IsValid(info, 4) ? read_uint64(info[4]) : 0;
  recorder_ = std::make_unique<runtime::action::action_recorder>(runtime_dir, namespace_, name, dest_id, stream_id);
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

Napi::Value ActionRecorder::RecordAction(const Napi::CallbackInfo &info) {
  if (!IsValid(info, 0, &Napi::Value::IsObject))
    throw Napi::TypeError::New(info.Env(), "recordAction(value, options?)");
  return to_receipt_object(info.Env(), recorder_->record_action(read_action_envelope(info[0].As<Napi::Object>()),
                                                                action_options_from_value(info, 1)));
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
                                        InstanceMethod("recordAction", &ActionRecorder::RecordAction),
                                        InstanceMethod("mark", &ActionRecorder::Mark),
                                        InstanceMethod("lastFrameUid", &ActionRecorder::LastFrameUid),
                                    });

  constructor = Napi::Persistent(func);
  constructor.SuppressDestruct();
  exports.Set("ActionRecorder", func);
  exports.Set("encodeActionEnvelope", Napi::Function::New(env, EncodeActionEnvelope));
  exports.Set("decodeActionEnvelope", Napi::Function::New(env, DecodeActionEnvelope));
  exports.Set("ACTION_ENVELOPE_CARRIER_TYPE", Napi::Number::New(env, view::action::ACTION_ENVELOPE_CARRIER_TYPE));
  exports.Set("FRAME_INTEGRITY_VERSION_V1", Napi::Number::New(env, runtime::action::FRAME_INTEGRITY_VERSION_V1));
  exports.Set("FRAME_INTEGRITY_VERSION_V2", Napi::Number::New(env, runtime::action::FRAME_INTEGRITY_VERSION_V2));
  exports.Set("DEFAULT_FRAME_INTEGRITY_VERSION",
              Napi::Number::New(env, runtime::action::DEFAULT_FRAME_INTEGRITY_VERSION));
  exports.Set("FRAME_CHECKSUM_ALGORITHM_FNV1A64",
              Napi::String::New(env, runtime::action::FRAME_CHECKSUM_ALGORITHM_FNV1A64));
  exports.Set("FRAME_CHECKSUM_ALGORITHM_CRC32C",
              Napi::String::New(env, runtime::action::FRAME_CHECKSUM_ALGORITHM_CRC32C));
  exports.Set("DEFAULT_FRAME_CHECKSUM_ALGORITHM",
              Napi::String::New(env, runtime::action::DEFAULT_FRAME_CHECKSUM_ALGORITHM));
}

} // namespace kungfu::node
