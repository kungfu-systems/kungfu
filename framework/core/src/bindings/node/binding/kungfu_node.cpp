// SPDX-License-Identifier: Apache-2.0

//
// Created by Keren Dong on 2019/12/25.
//

#ifdef _MSC_VER

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif

#include <regex>
#include <stdio.h>
#include <string.h>
#include <windows.h>

// Must include delayimp.h after windows.h
#include <delayimp.h>

static FARPROC WINAPI load_exe_hook(unsigned int event, DelayLoadInfo *info) {
  HMODULE m;
  if (event != dliNotePreLoadLibrary)
    return NULL;

  if (_stricmp(info->szDll, "NODE.EXE") != 0)
    return NULL;

  char buf[1024];
  auto length = GetModuleFileNameA(NULL, buf, sizeof(buf));
  std::string main_exe_name(buf);
  std::regex kungfu_exe("kungfu.exe");

  auto name_end = buf + length - strlen("kungfu.exe");
  auto libnode_dll = std::regex_replace(main_exe_name, kungfu_exe, "libnode.dll");

  m = _stricmp(name_end, "kungfu.exe") != 0 ? GetModuleHandle(NULL) : GetModuleHandleA(libnode_dll.c_str());
  return (FARPROC)m;
}

decltype(__pfnDliNotifyHook2) __pfnDliNotifyHook2 = load_exe_hook;

#endif // _MSC_VER

#include <kungfu/common.h>
#include <kungfu/runtime/durability.h>
#include <kungfu/runtime/io.h>
#include <kungfu/runtime/storage/binding_reflection.h>
#include <kungfu/runtime/storage/hana_view.h>
#include <kungfu/runtime/storage/json_edge.h>
#include <kungfu/yijinjing/hash.h>
#include <kungfu/yijinjing/storage/content_hash.h>

#include "action_recorder.h"
#include "app_container.h"
#include "config_store.h"
#include "data_table.h"
#include "history.h"
#include "io.h"
#include "journal.h"
#include "schema.h"
#include "watcher.h"

#include <kungfu/runtime/util/stacktrace.h>

using namespace kungfu::yijinjing;
using namespace kungfu::yijinjing::enums;
using namespace kungfu::yijinjing::types;
using namespace kungfu::runtime;
using namespace kungfu::yijinjing::data;
using namespace kungfu::node;

namespace kungfu::node {
std::string ToHex(const std::string &bytes) {
  std::string hex;
  hex.reserve(bytes.size() * 2);
  for (const auto byte : bytes) {
    hex += fmt::format("{:02x}", static_cast<unsigned char>(byte));
  }
  return hex;
}

uint32_t Hash32(const Napi::CallbackInfo &info) {
  if (IsValid(info, 0, &Napi::Value::IsString)) {
    auto arg = info[0].ToString().Utf8Value();
    return fast_hash_32(reinterpret_cast<const unsigned char *>(arg.c_str()), arg.length());
  }

  if (IsValid(info, 0, &Napi::Value::IsNumber)) {
    auto arg = static_cast<const int32_t>(info[0].ToNumber().Int32Value());
    return hash<decltype(arg)>{}(arg);
  }

  throw Napi::Error::New(info.Env(), "Invalid argument");
}

Napi::Value Hash(const Napi::CallbackInfo &info) { return Napi::Number::New(info.Env(), Hash32(info)); }

Napi::Value Hash64(const Napi::CallbackInfo &info) {
  if (IsValid(info, 0, &Napi::Value::IsString)) {
    auto arg = info[0].ToString().Utf8Value();
    return Napi::BigInt::New(info.Env(), fast_hash_str_64(arg));
  }

  if (IsValid(info, 0, &Napi::Value::IsNumber)) {
    auto arg = static_cast<const int32_t>(info[0].ToNumber().Int32Value());
    return Napi::BigInt::New(info.Env(), hash<decltype(arg)>{}(arg));
  }

  throw Napi::Error::New(info.Env(), "Invalid argument");
}

Napi::Value FormatStringToHashHex(const Napi::CallbackInfo &info) {
  return Napi::String::New(info.Env(), fmt::format("{:08x}", Hash32(info)));
}

Napi::Value FormatStringToHash128Hex(const Napi::CallbackInfo &info) {
  if (!IsValid(info, 0, &Napi::Value::IsString)) {
    throw Napi::TypeError::New(info.Env(), "formatStringToHash128Hex(string)");
  }
  return Napi::String::New(info.Env(), ToHex(fast_hash_string_128(info[0].ToString().Utf8Value())));
}

std::string ContentBytes(const Napi::CallbackInfo &info, size_t index) {
  if (info.Length() <= index || info[index].IsEmpty() || info[index].IsUndefined()) {
    throw Napi::TypeError::New(info.Env(), "payload must be a string, Buffer, or Uint8Array");
  }

  auto value = info[index];
  if (value.IsString()) {
    return value.As<Napi::String>().Utf8Value();
  }
  if (value.IsBuffer()) {
    auto buffer = value.As<Napi::Buffer<uint8_t>>();
    return {reinterpret_cast<const char *>(buffer.Data()), buffer.Length()};
  }
  if (value.IsTypedArray()) {
    auto typed_array = value.As<Napi::TypedArray>();
    if (typed_array.TypedArrayType() == napi_uint8_array) {
      auto uint8_array = value.As<Napi::Uint8Array>();
      auto data = static_cast<uint8_t *>(uint8_array.ArrayBuffer().Data()) + uint8_array.ByteOffset();
      return {reinterpret_cast<const char *>(data), uint8_array.ByteLength()};
    }
  }

  throw Napi::TypeError::New(info.Env(), "payload must be a string, Buffer, or Uint8Array");
}

std::string ContentAlgorithm(const Napi::CallbackInfo &info, size_t index) {
  return IsValid(info, index, &Napi::Value::IsString) ? info[index].As<Napi::String>().Utf8Value()
                                                      : yijinjing::storage::CONTENT_HASH_ALGORITHM_SHA256;
}

Napi::Value ComputeContentHashValue(const Napi::CallbackInfo &info) {
  auto payload = ContentBytes(info, 0);
  return Napi::String::New(info.Env(),
                           yijinjing::storage::compute_content_hash_value(payload, ContentAlgorithm(info, 1)));
}

Napi::Value ComputeContentHash(const Napi::CallbackInfo &info) {
  auto payload = ContentBytes(info, 0);
  return Napi::String::New(info.Env(), yijinjing::storage::format_content_hash(yijinjing::storage::compute_content_hash(
                                           payload, ContentAlgorithm(info, 1))));
}

Napi::Value ParseContentHash(const Napi::CallbackInfo &info) {
  if (!IsValid(info, 0, &Napi::Value::IsString)) {
    throw Napi::TypeError::New(info.Env(), "parseContentHash(formatted)");
  }
  const auto parsed = yijinjing::storage::parse_content_hash(info[0].As<Napi::String>().Utf8Value());
  auto object = Napi::Object::New(info.Env());
  object.Set("algorithm", Napi::String::New(info.Env(), parsed.algorithm));
  object.Set("value", Napi::String::New(info.Env(), parsed.value));
  return object;
}

Napi::Value FormatContentHash(const Napi::CallbackInfo &info) {
  if (!IsValid(info, 0, &Napi::Value::IsString) || !IsValid(info, 1, &Napi::Value::IsString)) {
    throw Napi::TypeError::New(info.Env(), "formatContentHash(algorithm, value)");
  }
  auto hash = yijinjing::storage::make_content_hash(info[1].As<Napi::String>().Utf8Value(),
                                                    info[0].As<Napi::String>().Utf8Value());
  return Napi::String::New(info.Env(), yijinjing::storage::format_content_hash(hash));
}

Napi::Value JsonToValue(Napi::Env env, const nlohmann::json &value) {
  auto json = env.Global().Get("JSON").As<Napi::Object>();
  auto parse = json.Get("parse").As<Napi::Function>();
  return parse.Call(json, {Napi::String::New(env, value.dump(-1, ' ', false))});
}

nlohmann::json ValueToJson(Napi::Env env, const Napi::Value &value, const std::string &label) {
  auto json = env.Global().Get("JSON").As<Napi::Object>();
  auto stringify = json.Get("stringify").As<Napi::Function>();
  auto serialized = stringify.Call(json, {value});
  if (!serialized.IsString()) {
    throw Napi::TypeError::New(env, label + " must be JSON-serializable");
  }
  return nlohmann::json::parse(serialized.As<Napi::String>().Utf8Value());
}

nlohmann::json OptionalObjectArg(const Napi::CallbackInfo &info, size_t index, const std::string &label) {
  if (!IsValid(info, index) || info[index].IsNull()) {
    return nlohmann::json::object();
  }
  auto parsed = ValueToJson(info.Env(), info[index], label);
  if (!parsed.is_object()) {
    throw Napi::TypeError::New(info.Env(), label + " must be an object");
  }
  return parsed;
}

nlohmann::json RequiredObjectArg(const Napi::CallbackInfo &info, size_t index, const std::string &label) {
  if (!IsValid(info, index) || info[index].IsNull()) {
    throw Napi::TypeError::New(info.Env(), label + " must be an object");
  }
  auto parsed = ValueToJson(info.Env(), info[index], label);
  if (!parsed.is_object()) {
    throw Napi::TypeError::New(info.Env(), label + " must be an object");
  }
  return parsed;
}

template <typename> inline constexpr bool dependent_false_v = false;

template <typename T> Napi::Value HanaViewToValue(Napi::Env env, const T &value) {
  using value_t = std::decay_t<T>;
  if constexpr (std::is_same_v<value_t, bool>) {
    return Napi::Boolean::New(env, value);
  } else if constexpr (std::is_integral_v<value_t> && sizeof(value_t) <= sizeof(uint32_t)) {
    return Napi::Number::New(env, static_cast<double>(value));
  } else if constexpr (std::is_integral_v<value_t> && std::is_signed_v<value_t>) {
    return Napi::BigInt::New(env, static_cast<int64_t>(value));
  } else if constexpr (std::is_integral_v<value_t>) {
    return Napi::BigInt::New(env, static_cast<uint64_t>(value));
  } else if constexpr (std::is_floating_point_v<value_t>) {
    return Napi::Number::New(env, value);
  } else if constexpr (std::is_enum_v<value_t>) {
    return Napi::Number::New(env, static_cast<double>(static_cast<std::underlying_type_t<value_t>>(value)));
  } else if constexpr (std::is_same_v<value_t, std::string>) {
    return Napi::String::New(env, value);
  } else if constexpr (kungfu::is_array_of_v<value_t, char>) {
    return Napi::String::New(env, value.value);
  } else if constexpr (kungfu::is_array_of_others_v<value_t, char>) {
    auto result = Napi::Array::New(env, value_t::length);
    for (size_t index = 0; index < value_t::length; ++index)
      result.Set(index, HanaViewToValue(env, value[index]));
    return result;
  } else if constexpr (runtime::storage_binding::is_optional_v<value_t>) {
    return value.has_value() ? HanaViewToValue(env, *value) : env.Null();
  } else if constexpr (runtime::storage_binding::is_vector_v<value_t>) {
    auto result = Napi::Array::New(env, value.size());
    for (size_t index = 0; index < value.size(); ++index)
      result.Set(index, HanaViewToValue(env, value[index]));
    return result;
  } else if constexpr (runtime::storage_binding::is_variant_v<value_t>) {
    return std::visit([env](const auto &item) { return HanaViewToValue(env, item); }, value);
  } else if constexpr (runtime::storage_binding::is_hana_view_v<value_t>) {
    auto result = Napi::Object::New(env);
    runtime::storage_binding::for_each_field(
        value, [&](const auto &name, const auto &field) { result.Set(name, HanaViewToValue(env, field)); });
    return result;
  } else {
    static_assert(dependent_false_v<value_t>, "unsupported Hana binding value");
  }
}

Napi::Value StorageStatusTyped(const Napi::CallbackInfo &info) {
  if (!IsValid(info, 0, &Napi::Value::IsString)) {
    throw Napi::TypeError::New(info.Env(), "storageStatusTyped(runtimeDir, sourceId?)");
  }
  runtime::storage_service_api::storage_status_request request{};
  request.runtime_dir = info[0].As<Napi::String>().Utf8Value();
  if (IsValid(info, 1, &Napi::Value::IsString))
    request.source_id = info[1].As<Napi::String>().Utf8Value();
  return HanaViewToValue(info.Env(), runtime::storage_service_api::default_storage_service().status(request));
}

Napi::Value StorageQueryTyped(const Napi::CallbackInfo &info) {
  if (!IsValid(info, 0, &Napi::Value::IsString) || !IsValid(info, 1, &Napi::Value::IsString)) {
    throw Napi::TypeError::New(info.Env(), "storageQueryTyped(runtimeDir, query, options?)");
  }
  runtime::storage_service_api::storage_query_request request{};
  request.runtime_dir = info[0].As<Napi::String>().Utf8Value();
  request.query = runtime::storage_service_api::parse_storage_query_kind(info[1].As<Napi::String>().Utf8Value());
  if (IsValid(info, 2, &Napi::Value::IsObject)) {
    const auto options = info[2].As<Napi::Object>();
    if (options.Has("source_id") && options.Get("source_id").IsString())
      request.source_id = options.Get("source_id").As<Napi::String>().Utf8Value();
    if (options.Has("entry_kind") && options.Get("entry_kind").IsString())
      request.entry_kind = options.Get("entry_kind").As<Napi::String>().Utf8Value();
    if (options.Has("episode_id")) {
      const auto episode_id = options.Get("episode_id");
      if (episode_id.IsBigInt()) {
        bool lossless = false;
        request.episode_id = episode_id.As<Napi::BigInt>().Uint64Value(&lossless);
        if (!lossless)
          throw Napi::RangeError::New(info.Env(), "episode_id must fit in an unsigned 64-bit integer");
      } else {
        request.episode_id = episode_id.ToNumber().Int64Value();
      }
    }
    if (options.Has("limit"))
      request.limit = options.Get("limit").ToNumber().Int64Value();
    if (options.Has("since") && options.Get("since").IsString())
      request.range.since = options.Get("since").As<Napi::String>().Utf8Value();
    if (options.Has("until") && options.Get("until").IsString())
      request.range.until = options.Get("until").As<Napi::String>().Utf8Value();
  }
  return HanaViewToValue(info.Env(), runtime::storage_service_api::default_storage_service().query(request));
}

Napi::Value StorageGcPlanTyped(const Napi::CallbackInfo &info) {
  if (!IsValid(info, 0, &Napi::Value::IsString))
    throw Napi::TypeError::New(info.Env(), "storageGcPlanTyped(runtimeDir, options?)");
  runtime::storage_service_api::storage_gc_plan_request request{};
  request.runtime_dir = info[0].As<Napi::String>().Utf8Value();
  if (IsValid(info, 1, &Napi::Value::IsObject)) {
    const auto options = info[1].As<Napi::Object>();
    if (options.Has("source_id") && options.Get("source_id").IsString())
      request.source_id = options.Get("source_id").As<Napi::String>().Utf8Value();
    if (options.Has("dry_run") && options.Get("dry_run").IsBoolean())
      request.dry_run = options.Get("dry_run").As<Napi::Boolean>().Value();
  }
  return HanaViewToValue(info.Env(), runtime::storage_service_api::default_storage_service().gc_plan(request));
}

Napi::Value StorageRebuildIndexTyped(const Napi::CallbackInfo &info) {
  if (!IsValid(info, 0, &Napi::Value::IsString))
    throw Napi::TypeError::New(info.Env(), "storageRebuildIndexTyped(runtimeDir, options?)");
  runtime::storage_service_api::storage_rebuild_index_request request{};
  request.runtime_dir = info[0].As<Napi::String>().Utf8Value();
  if (IsValid(info, 1, &Napi::Value::IsObject)) {
    const auto options = info[1].As<Napi::Object>();
    if (options.Has("source_id") && options.Get("source_id").IsString())
      request.source_id = options.Get("source_id").As<Napi::String>().Utf8Value();
    if (options.Has("dry_run") && options.Get("dry_run").IsBoolean())
      request.dry_run = options.Get("dry_run").As<Napi::Boolean>().Value();
  }
  return HanaViewToValue(info.Env(), runtime::storage_service_api::default_storage_service().rebuild_index(request));
}

Napi::Value StorageCompactPlanTyped(const Napi::CallbackInfo &info) {
  if (!IsValid(info, 0, &Napi::Value::IsString))
    throw Napi::TypeError::New(info.Env(), "storageCompactPlanTyped(runtimeDir, options?)");
  runtime::storage_service_api::storage_compact_plan_request request{};
  request.runtime_dir = info[0].As<Napi::String>().Utf8Value();
  if (IsValid(info, 1, &Napi::Value::IsObject)) {
    const auto options = info[1].As<Napi::Object>();
    if (options.Has("source_id") && options.Get("source_id").IsString())
      request.source_id = options.Get("source_id").As<Napi::String>().Utf8Value();
    if (options.Has("dry_run") && options.Get("dry_run").IsBoolean())
      request.dry_run = options.Get("dry_run").As<Napi::Boolean>().Value();
  }
  return HanaViewToValue(info.Env(), runtime::storage_service_api::default_storage_service().compact_plan(request));
}

uint64_t Uint64Option(Napi::Env env, const Napi::Object &options, const char *name) {
  if (!options.Has(name))
    return 0;
  const auto value = options.Get(name);
  if (value.IsBigInt()) {
    bool lossless = false;
    const auto result = value.As<Napi::BigInt>().Uint64Value(&lossless);
    if (!lossless)
      throw Napi::RangeError::New(env, std::string(name) + " must fit in an unsigned 64-bit integer");
    return result;
  }
  return static_cast<uint64_t>(value.ToNumber().Int64Value());
}

uint32_t Uint32Option(const Napi::Object &options, const char *name) {
  return options.Has(name) ? options.Get(name).ToNumber().Uint32Value() : 0;
}

int64_t Int64Option(const Napi::Object &options, const char *name) {
  if (!options.Has(name))
    return 0;
  const auto value = options.Get(name);
  if (value.IsBigInt()) {
    bool lossless = false;
    const auto result = value.As<Napi::BigInt>().Int64Value(&lossless);
    if (!lossless)
      throw Napi::RangeError::New(options.Env(), std::string(name) + " must fit in a signed 64-bit integer");
    return result;
  }
  return value.ToNumber().Int64Value();
}

std::string StringOption(const Napi::Object &options, const char *name) {
  return options.Has(name) && options.Get(name).IsString() ? options.Get(name).As<Napi::String>().Utf8Value() : "";
}

Napi::Value DurabilityVisibleReceiptTyped(const Napi::CallbackInfo &info) {
  if (!IsValid(info, 0, &Napi::Value::IsObject))
    throw Napi::TypeError::New(info.Env(), "durabilityVisibleReceiptTyped(options)");
  const auto options = info[0].As<Napi::Object>();
  const auto requested_profile = StringOption(options, "requested_profile");
  runtime::durability::durability_request request{
      Uint64Option(info.Env(), options, "request_id"),
      {Uint64Option(info.Env(), options, "stream_id"), Uint64Option(info.Env(), options, "container_epoch"),
       Uint64Option(info.Env(), options, "sequence"), Uint64Option(info.Env(), options, "frame_uid")},
      runtime::durability::parse_durability_profile(requested_profile.empty() ? "visible" : requested_profile),
  };
  return HanaViewToValue(info.Env(), runtime::durability::make_receipt_view(runtime::durability::make_visible_receipt(
                                         request, Int64Option(options, "completed_at"))));
}

Napi::Value StorageEpisodeBeginTyped(const Napi::CallbackInfo &info) {
  if (!IsValid(info, 0, &Napi::Value::IsString) || !IsValid(info, 1, &Napi::Value::IsObject))
    throw Napi::TypeError::New(info.Env(), "storageEpisodeBeginTyped(runtimeDir, options)");
  const auto options = info[1].As<Napi::Object>();
  runtime::storage_service_api::storage_episode_begin_request request{};
  request.runtime_dir = info[0].As<Napi::String>().Utf8Value();
  request.options = {Uint64Option(info.Env(), options, "episode_id"),
                     Uint64Option(info.Env(), options, "parent_episode_id"),
                     Uint64Option(info.Env(), options, "root_trigger_frame_uid"),
                     Uint32Option(options, "location_uid"),
                     Int64Option(options, "begin_time"),
                     StringOption(options, "title"),
                     StringOption(options, "actor"),
                     StringOption(options, "source")};
  return HanaViewToValue(info.Env(), runtime::storage_service_api::default_storage_service().episode_begin(request));
}

Napi::Value StorageEpisodeHeartbeatTyped(const Napi::CallbackInfo &info) {
  if (!IsValid(info, 0, &Napi::Value::IsString) || !IsValid(info, 1, &Napi::Value::IsObject))
    throw Napi::TypeError::New(info.Env(), "storageEpisodeHeartbeatTyped(runtimeDir, options)");
  const auto options = info[1].As<Napi::Object>();
  runtime::storage_service_api::storage_episode_heartbeat_request request{};
  request.runtime_dir = info[0].As<Napi::String>().Utf8Value();
  request.options = {Uint64Option(info.Env(), options, "episode_id"),
                     Uint32Option(options, "location_uid"),
                     Int64Option(options, "update_time"),
                     Uint64Option(info.Env(), options, "last_frame_uid"),
                     Uint64Option(info.Env(), options, "frame_count"),
                     StringOption(options, "note")};
  return HanaViewToValue(info.Env(),
                         runtime::storage_service_api::default_storage_service().episode_heartbeat(request));
}

Napi::Value StorageEpisodeAttachFrameTyped(const Napi::CallbackInfo &info) {
  if (!IsValid(info, 0, &Napi::Value::IsString) || !IsValid(info, 1, &Napi::Value::IsObject))
    throw Napi::TypeError::New(info.Env(), "storageEpisodeAttachFrameTyped(runtimeDir, options)");
  const auto options = info[1].As<Napi::Object>();
  runtime::storage_service_api::storage_episode_frame_attach_request request{};
  request.runtime_dir = info[0].As<Napi::String>().Utf8Value();
  request.options = {Uint64Option(info.Env(), options, "episode_id"),
                     Uint32Option(options, "location_uid"),
                     Uint64Option(info.Env(), options, "frame_uid"),
                     Uint64Option(info.Env(), options, "trigger_frame_uid"),
                     Uint64Option(info.Env(), options, "stream_id"),
                     Int64Option(options, "gen_time"),
                     Int64Option(options, "trigger_time"),
                     static_cast<int32_t>(Int64Option(options, "carrier_type")),
                     Uint32Option(options, "source"),
                     Uint32Option(options, "dest"),
                     Uint32Option(options, "data_length"),
                     Uint32Option(options, "integrity_version"),
                     Uint64Option(info.Env(), options, "payload_checksum"),
                     Uint64Option(info.Env(), options, "frame_checksum")};
  return HanaViewToValue(info.Env(),
                         runtime::storage_service_api::default_storage_service().episode_attach_frame(request));
}

Napi::Value StorageEpisodeAttachRefTyped(const Napi::CallbackInfo &info) {
  if (!IsValid(info, 0, &Napi::Value::IsString) || !IsValid(info, 1, &Napi::Value::IsObject))
    throw Napi::TypeError::New(info.Env(), "storageEpisodeAttachRefTyped(runtimeDir, options)");
  const auto options = info[1].As<Napi::Object>();
  const auto ref_kind = StringOption(options, "ref_kind");
  runtime::storage_service_api::storage_episode_ref_attach_request request{};
  request.runtime_dir = info[0].As<Napi::String>().Utf8Value();
  request.options = {Uint64Option(info.Env(), options, "episode_id"),
                     Uint32Option(options, "location_uid"),
                     ref_kind == "payload"   ? EpisodeRefKind::Payload
                     : ref_kind == "schema"  ? EpisodeRefKind::Schema
                     : ref_kind == "episode" ? EpisodeRefKind::Episode
                                             : EpisodeRefKind::InputFrame,
                     Uint64Option(info.Env(), options, "ref_uid"),
                     Int64Option(options, "update_time"),
                     StringOption(options, "ref_id"),
                     StringOption(options, "ref_hash")};
  return HanaViewToValue(info.Env(),
                         runtime::storage_service_api::default_storage_service().episode_attach_ref(request));
}

Napi::Value StorageEpisodeCloseTyped(const Napi::CallbackInfo &info) {
  if (!IsValid(info, 0, &Napi::Value::IsString) || !IsValid(info, 1, &Napi::Value::IsObject))
    throw Napi::TypeError::New(info.Env(), "storageEpisodeCloseTyped(runtimeDir, options)");
  const auto options = info[1].As<Napi::Object>();
  const auto aborted = options.Has("aborted") && options.Get("aborted").ToBoolean().Value();
  runtime::storage_service_api::storage_episode_close_request request{};
  request.runtime_dir = info[0].As<Napi::String>().Utf8Value();
  request.options = {Uint64Option(info.Env(), options, "episode_id"),
                     Uint32Option(options, "location_uid"),
                     aborted ? EpisodeStatus::Aborted : EpisodeStatus::Ended,
                     Int64Option(options, "end_time"),
                     Uint64Option(info.Env(), options, "last_frame_uid"),
                     Uint64Option(info.Env(), options, "frame_count"),
                     StringOption(options, "reason")};
  const auto &service = runtime::storage_service_api::default_storage_service();
  return HanaViewToValue(info.Env(), aborted ? service.episode_abort(request) : service.episode_end(request));
}

Napi::Value StorageEpisodeRecoverTyped(const Napi::CallbackInfo &info) {
  if (!IsValid(info, 0, &Napi::Value::IsString) || !IsValid(info, 1, &Napi::Value::IsObject))
    throw Napi::TypeError::New(info.Env(), "storageEpisodeRecoverTyped(runtimeDir, options)");
  const auto options = info[1].As<Napi::Object>();
  runtime::storage_service_api::storage_episode_recover_request request{};
  request.runtime_dir = info[0].As<Napi::String>().Utf8Value();
  request.options = {Uint64Option(info.Env(), options, "episode_id"), Uint32Option(options, "location_uid"),
                     Int64Option(options, "end_time"), StringOption(options, "reason")};
  return HanaViewToValue(info.Env(), runtime::storage_service_api::default_storage_service().episode_recover(request));
}

Napi::Value StorageEpisodeProjectionRebuildTyped(const Napi::CallbackInfo &info) {
  if (!IsValid(info, 0, &Napi::Value::IsString))
    throw Napi::TypeError::New(info.Env(), "storageEpisodeProjectionRebuildTyped(runtimeDir)");
  return HanaViewToValue(info.Env(), runtime::storage_service_api::default_storage_service().episode_projection_rebuild(
                                         {info[0].As<Napi::String>().Utf8Value()}));
}

Napi::Value StorageEpisodeListTyped(const Napi::CallbackInfo &info) {
  if (!IsValid(info, 0, &Napi::Value::IsString))
    throw Napi::TypeError::New(info.Env(), "storageEpisodeListTyped(runtimeDir, options?)");
  runtime::storage_service_api::storage_episode_list_request request{};
  request.runtime_dir = info[0].As<Napi::String>().Utf8Value();
  if (IsValid(info, 1, &Napi::Value::IsObject)) {
    const auto options = info[1].As<Napi::Object>();
    request.location_uid = Uint32Option(options, "location_uid");
    request.limit = options.Has("limit") ? Uint64Option(info.Env(), options, "limit") : uint64_t{100};
  }
  return HanaViewToValue(info.Env(), runtime::storage_service_api::default_storage_service().episode_list(request));
}

Napi::Value StorageEpisodeInspectTyped(const Napi::CallbackInfo &info) {
  if (!IsValid(info, 0, &Napi::Value::IsString) || !IsValid(info, 1, &Napi::Value::IsObject))
    throw Napi::TypeError::New(info.Env(), "storageEpisodeInspectTyped(runtimeDir, options)");
  runtime::storage_service_api::storage_episode_inspect_request request{};
  request.runtime_dir = info[0].As<Napi::String>().Utf8Value();
  request.episode_id = Uint64Option(info.Env(), info[1].As<Napi::Object>(), "episode_id");
  return HanaViewToValue(info.Env(), runtime::storage_service_api::default_storage_service().episode_inspect(request));
}

Napi::Value StorageSourceRegisterTyped(const Napi::CallbackInfo &info) {
  if (!IsValid(info, 0, &Napi::Value::IsString) || !IsValid(info, 1, &Napi::Value::IsObject))
    throw Napi::TypeError::New(info.Env(), "storageSourceRegisterTyped(runtimeDir, options)");
  const auto options = info[1].As<Napi::Object>();
  const auto kind = StringOption(options, "kind");
  runtime::storage_service_api::storage_source_register_request request{};
  request.runtime_dir = info[0].As<Napi::String>().Utf8Value();
  request.options = {StringOption(options, "source_id"),
                     kind == "imported_bundle"  ? SourceKind::ImportedBundle
                     : kind == "kungfu_runtime" ? SourceKind::KungfuRuntime
                     : kind == "adapter"        ? SourceKind::Adapter
                                                : SourceKind::Local,
                     StringOption(options, "coordinate"),
                     StringOption(options, "head"),
                     Uint32Option(options, "location_uid"),
                     Int64Option(options, "register_time")};
  return HanaViewToValue(info.Env(), runtime::storage_service_api::default_storage_service().source_register(request));
}

Napi::Value StorageSourceUpdateHeadTyped(const Napi::CallbackInfo &info) {
  if (!IsValid(info, 0, &Napi::Value::IsString) || !IsValid(info, 1, &Napi::Value::IsObject))
    throw Napi::TypeError::New(info.Env(), "storageSourceUpdateHeadTyped(runtimeDir, options)");
  const auto options = info[1].As<Napi::Object>();
  runtime::storage_service_api::storage_source_head_update_request request{};
  request.runtime_dir = info[0].As<Napi::String>().Utf8Value();
  request.options = {StringOption(options, "source_id"),
                     Uint32Option(options, "location_uid"),
                     Int64Option(options, "update_time"),
                     Uint64Option(info.Env(), options, "first_frame_uid"),
                     Uint64Option(info.Env(), options, "last_frame_uid"),
                     Int64Option(options, "since"),
                     Int64Option(options, "until"),
                     StringOption(options, "head"),
                     StringOption(options, "inventory_hash_algo"),
                     StringOption(options, "inventory_hash")};
  return HanaViewToValue(info.Env(),
                         runtime::storage_service_api::default_storage_service().source_update_head(request));
}

Napi::Value StorageSourceRecordAcceptedRangeTyped(const Napi::CallbackInfo &info) {
  if (!IsValid(info, 0, &Napi::Value::IsString) || !IsValid(info, 1, &Napi::Value::IsObject))
    throw Napi::TypeError::New(info.Env(), "storageSourceRecordAcceptedRangeTyped(runtimeDir, options)");
  const auto options = info[1].As<Napi::Object>();
  const auto status = StringOption(options, "status");
  runtime::storage_service_api::storage_source_accepted_range_request request{};
  request.runtime_dir = info[0].As<Napi::String>().Utf8Value();
  request.options = {StringOption(options, "source_id"),
                     StringOption(options, "manifest_id"),
                     Uint32Option(options, "location_uid"),
                     Int64Option(options, "accept_time"),
                     Uint64Option(info.Env(), options, "first_frame_uid"),
                     Uint64Option(info.Env(), options, "last_frame_uid"),
                     Int64Option(options, "since"),
                     Int64Option(options, "until"),
                     status == "degraded" ? SourceVerificationStatus::Degraded
                     : status == "failed" ? SourceVerificationStatus::Failed
                                          : SourceVerificationStatus::Ok};
  return HanaViewToValue(info.Env(),
                         runtime::storage_service_api::default_storage_service().source_record_accepted_range(request));
}

Napi::Value StorageSourceListTyped(const Napi::CallbackInfo &info) {
  if (!IsValid(info, 0, &Napi::Value::IsString))
    throw Napi::TypeError::New(info.Env(), "storageSourceListTyped(runtimeDir)");
  return HanaViewToValue(info.Env(), runtime::storage_service_api::default_storage_service().source_list(
                                         {info[0].As<Napi::String>().Utf8Value()}));
}

Napi::Value StorageSourceInspectTyped(const Napi::CallbackInfo &info) {
  if (!IsValid(info, 0, &Napi::Value::IsString) || !IsValid(info, 1, &Napi::Value::IsObject))
    throw Napi::TypeError::New(info.Env(), "storageSourceInspectTyped(runtimeDir, options)");
  return HanaViewToValue(
      info.Env(), runtime::storage_service_api::default_storage_service().source_inspect(
                      {info[0].As<Napi::String>().Utf8Value(), StringOption(info[1].As<Napi::Object>(), "source_id")}));
}

Napi::Value StorageSourceRegistryFsckTyped(const Napi::CallbackInfo &info) {
  if (!IsValid(info, 0, &Napi::Value::IsString))
    throw Napi::TypeError::New(info.Env(), "storageSourceRegistryFsckTyped(runtimeDir, options?)");
  const auto source_id =
      IsValid(info, 1, &Napi::Value::IsObject) ? StringOption(info[1].As<Napi::Object>(), "source_id") : std::string{};
  return HanaViewToValue(info.Env(), runtime::storage_service_api::default_storage_service().source_registry_fsck(
                                         {info[0].As<Napi::String>().Utf8Value(), source_id}));
}

Napi::Value StorageSourceRegistryRebuildTyped(const Napi::CallbackInfo &info) {
  if (!IsValid(info, 0, &Napi::Value::IsString))
    throw Napi::TypeError::New(info.Env(), "storageSourceRegistryRebuildTyped(runtimeDir)");
  return HanaViewToValue(info.Env(), runtime::storage_service_api::default_storage_service().source_registry_rebuild(
                                         {info[0].As<Napi::String>().Utf8Value()}));
}

Napi::Value StorageLayoutTyped(const Napi::CallbackInfo &info) {
  if (!IsValid(info, 0, &Napi::Value::IsString))
    throw Napi::TypeError::New(info.Env(), "storageLayoutTyped(runtimeDir, options?)");
  runtime::storage_service_api::storage_layout_request request{};
  request.runtime_dir = info[0].As<Napi::String>().Utf8Value();
  if (IsValid(info, 1, &Napi::Value::IsObject)) {
    const auto options = info[1].As<Napi::Object>();
    request.runtime_home = StringOption(options, "runtime_home");
    request.config_home = StringOption(options, "config_home");
    request.provider = StringOption(options, "provider");
  }
  return HanaViewToValue(info.Env(), runtime::storage_service_api::default_storage_service().layout(request));
}

Napi::Value StorageFsckTyped(const Napi::CallbackInfo &info) {
  if (!IsValid(info, 0, &Napi::Value::IsString))
    throw Napi::TypeError::New(info.Env(), "storageFsckTyped(runtimeDir, options?)");
  runtime::storage_service_api::storage_fsck_request request{};
  request.runtime_dir = info[0].As<Napi::String>().Utf8Value();
  if (IsValid(info, 1, &Napi::Value::IsObject)) {
    const auto options = info[1].As<Napi::Object>();
    if (options.Has("source_id") && options.Get("source_id").IsString())
      request.source_id = options.Get("source_id").As<Napi::String>().Utf8Value();
    request.episode_id = Uint64Option(info.Env(), options, "episode_id");
    if (options.Has("verify_frames") && options.Get("verify_frames").IsBoolean())
      request.verify_frames = options.Get("verify_frames").As<Napi::Boolean>().Value();
  }
  request.scope = request.episode_id != 0 || request.verify_frames
                      ? runtime::storage_service_api::storage_fsck_scope::Episode
                      : (request.source_id.empty() ? runtime::storage_service_api::storage_fsck_scope::All
                                                   : runtime::storage_service_api::storage_fsck_scope::Source);
  return HanaViewToValue(info.Env(), runtime::storage_service_api::default_storage_service().fsck(request));
}

Napi::Value StorageRepairPlanTyped(const Napi::CallbackInfo &info) {
  if (!IsValid(info, 0, &Napi::Value::IsString))
    throw Napi::TypeError::New(info.Env(), "storageRepairPlanTyped(runtimeDir, options?)");
  runtime::storage_service_api::storage_repair_plan_request request{};
  request.runtime_dir = info[0].As<Napi::String>().Utf8Value();
  if (IsValid(info, 1, &Napi::Value::IsObject)) {
    const auto options = info[1].As<Napi::Object>();
    if (options.Has("source_id") && options.Get("source_id").IsString())
      request.source_id = options.Get("source_id").As<Napi::String>().Utf8Value();
    request.episode_id = Uint64Option(info.Env(), options, "episode_id");
    if (options.Has("verify_frames") && options.Get("verify_frames").IsBoolean())
      request.verify_frames = options.Get("verify_frames").As<Napi::Boolean>().Value();
    if (options.Has("dry_run") && options.Get("dry_run").IsBoolean())
      request.dry_run = options.Get("dry_run").As<Napi::Boolean>().Value();
  }
  request.scope = request.episode_id != 0 || request.verify_frames
                      ? runtime::storage_service_api::storage_fsck_scope::Episode
                      : (request.source_id.empty() ? runtime::storage_service_api::storage_fsck_scope::All
                                                   : runtime::storage_service_api::storage_fsck_scope::Source);
  return HanaViewToValue(info.Env(), runtime::storage_service_api::default_storage_service().repair_plan(request));
}

Napi::Value StorageServiceCapabilities(const Napi::CallbackInfo &info) {
  return JsonToValue(info.Env(), runtime::storage_service_api::storage_service_capabilities());
}

Napi::Value MakeStorageServiceRequest(const Napi::CallbackInfo &info) {
  if (!IsValid(info, 0, &Napi::Value::IsString) || !IsValid(info, 1, &Napi::Value::IsString)) {
    throw Napi::TypeError::New(info.Env(), "makeStorageServiceRequest(operation, runtimeDir, options?)");
  }
  return JsonToValue(info.Env(), runtime::storage_service_api::make_storage_service_request(
                                     info[0].As<Napi::String>().Utf8Value(), info[1].As<Napi::String>().Utf8Value(),
                                     OptionalObjectArg(info, 2, "options")));
}

Napi::Value RunStorageServiceOperation(const Napi::CallbackInfo &info) {
  if (!IsValid(info, 0, &Napi::Value::IsString) || !IsValid(info, 1, &Napi::Value::IsString)) {
    throw Napi::TypeError::New(info.Env(), "runStorageServiceOperation(operation, runtimeDir, options?)");
  }
  return JsonToValue(info.Env(), runtime::storage_service_api::run_storage_service_operation(
                                     info[0].As<Napi::String>().Utf8Value(), info[1].As<Napi::String>().Utf8Value(),
                                     OptionalObjectArg(info, 2, "options")));
}

Napi::Value AcceptStorageManifest(const Napi::CallbackInfo &info) {
  if (!IsValid(info, 0, &Napi::Value::IsString)) {
    throw Napi::TypeError::New(info.Env(), "acceptStorageManifest(runtimeDir, manifest)");
  }
  return JsonToValue(info.Env(), runtime::storage_service_api::accept_storage_manifest(
                                     info[0].As<Napi::String>().Utf8Value(), RequiredObjectArg(info, 1, "manifest")));
}

Napi::Value LoadStorageLatestManifest(const Napi::CallbackInfo &info) {
  if (!IsValid(info, 0, &Napi::Value::IsString) || !IsValid(info, 1, &Napi::Value::IsString)) {
    throw Napi::TypeError::New(info.Env(), "loadStorageLatestManifest(runtimeDir, sourceId)");
  }
  return JsonToValue(info.Env(), runtime::storage_service_api::load_storage_latest_manifest(
                                     info[0].As<Napi::String>().Utf8Value(), info[1].As<Napi::String>().Utf8Value()));
}

Napi::Value ExportStorageRecords(const Napi::CallbackInfo &info) {
  if (!IsValid(info, 0, &Napi::Value::IsString) || !IsValid(info, 1, &Napi::Value::IsString)) {
    throw Napi::TypeError::New(info.Env(), "exportStorageRecords(runtimeDir, sourceId, range?)");
  }
  return JsonToValue(info.Env(), runtime::storage_service_api::export_storage_records(
                                     info[0].As<Napi::String>().Utf8Value(), info[1].As<Napi::String>().Utf8Value(),
                                     OptionalObjectArg(info, 2, "range")));
}

Napi::Value WriteStoragePayloadBytes(const Napi::CallbackInfo &info) {
  if (!IsValid(info, 0, &Napi::Value::IsString) || !IsValid(info, 1, &Napi::Value::IsString)) {
    throw Napi::TypeError::New(info.Env(), "writeStoragePayloadBytes(runtimeDir, digest, payload)");
  }
  return Napi::String::New(info.Env(), runtime::storage_service_api::write_storage_payload_bytes(
                                           info[0].As<Napi::String>().Utf8Value(),
                                           info[1].As<Napi::String>().Utf8Value(), ContentBytes(info, 2)));
}

Napi::Value ContentStorePutIfAbsent(const Napi::CallbackInfo &info) {
  if (!IsValid(info, 0, &Napi::Value::IsString) || !IsValid(info, 1, &Napi::Value::IsString)) {
    throw Napi::TypeError::New(info.Env(), "contentStorePutIfAbsent(runtimeDir, namespace, payload, expectedHash?)");
  }
  const auto expected =
      IsValid(info, 3, &Napi::Value::IsString) ? info[3].As<Napi::String>().Utf8Value() : std::string();
  return JsonToValue(info.Env(), runtime::storage_service_api::content_store_put_if_absent(
                                     info[0].As<Napi::String>().Utf8Value(), info[1].As<Napi::String>().Utf8Value(),
                                     ContentBytes(info, 2), expected));
}

Napi::Value ContentStoreHas(const Napi::CallbackInfo &info) {
  if (!IsValid(info, 0, &Napi::Value::IsString) || !IsValid(info, 1, &Napi::Value::IsString) ||
      !IsValid(info, 2, &Napi::Value::IsString)) {
    throw Napi::TypeError::New(info.Env(), "contentStoreHas(runtimeDir, namespace, contentHash)");
  }
  return Napi::Boolean::New(info.Env(),
                            runtime::storage_service_api::content_store_has(info[0].As<Napi::String>().Utf8Value(),
                                                                            info[1].As<Napi::String>().Utf8Value(),
                                                                            info[2].As<Napi::String>().Utf8Value()));
}

Napi::Value ContentStoreVerify(const Napi::CallbackInfo &info) {
  if (!IsValid(info, 0, &Napi::Value::IsString) || !IsValid(info, 1, &Napi::Value::IsString) ||
      !IsValid(info, 2, &Napi::Value::IsString)) {
    throw Napi::TypeError::New(info.Env(), "contentStoreVerify(runtimeDir, namespace, contentHash)");
  }
  return JsonToValue(info.Env(), runtime::storage_service_api::content_store_verify(
                                     info[0].As<Napi::String>().Utf8Value(), info[1].As<Napi::String>().Utf8Value(),
                                     info[2].As<Napi::String>().Utf8Value()));
}

Napi::Value ContentStoreGet(const Napi::CallbackInfo &info) {
  if (!IsValid(info, 0, &Napi::Value::IsString) || !IsValid(info, 1, &Napi::Value::IsString) ||
      !IsValid(info, 2, &Napi::Value::IsString)) {
    throw Napi::TypeError::New(info.Env(), "contentStoreGet(runtimeDir, namespace, contentHash)");
  }
  const auto bytes = runtime::storage_service_api::content_store_get(info[0].As<Napi::String>().Utf8Value(),
                                                                     info[1].As<Napi::String>().Utf8Value(),
                                                                     info[2].As<Napi::String>().Utf8Value());
  return Napi::Buffer<uint8_t>::Copy(info.Env(), reinterpret_cast<const uint8_t *>(bytes.data()), bytes.size());
}

Napi::Value ContentStoreCapabilities(const Napi::CallbackInfo &info) {
  if (!IsValid(info, 0, &Napi::Value::IsString)) {
    throw Napi::TypeError::New(info.Env(), "contentStoreCapabilities(runtimeDir)");
  }
  return JsonToValue(info.Env(),
                     runtime::storage_service_api::content_store_capabilities(info[0].As<Napi::String>().Utf8Value()));
}

Napi::Value VerifyContentHash(const Napi::CallbackInfo &info) {
  auto payload = ContentBytes(info, 0);
  if (!IsValid(info, 1, &Napi::Value::IsString)) {
    throw Napi::TypeError::New(info.Env(), "verifyContentHash(payload, expected, algorithm?)");
  }
  const auto expected = info[1].As<Napi::String>().Utf8Value();
  const auto parsed = IsValid(info, 2, &Napi::Value::IsString)
                          ? yijinjing::storage::make_content_hash(expected, info[2].As<Napi::String>().Utf8Value())
                          : yijinjing::storage::parse_content_hash(expected);
  return Napi::Boolean::New(info.Env(), yijinjing::storage::verify_content_hash(payload, parsed));
}

Napi::Value FormatTime(const Napi::CallbackInfo &info) {
  if (not IsValid(info, 0, &Napi::Value::IsBigInt)) {
    return {};
  }
  auto format = IsValid(info, 1, &Napi::Value::IsString) ? info[1].ToString().Utf8Value() : KUNGFU_DATETIME_FORMAT;
  return Napi::String::New(info.Env(), time::strftime(GetBigInt(info, 0), format));
}

Napi::Value ParseTime(const Napi::CallbackInfo &info) {
  if (not IsValid(info, 0, &Napi::Value::IsString) and IsValid(info, 1, &Napi::Value::IsString)) {
    return Napi::BigInt::New(info.Env(), TryParseTime(info, 0));
  }
  auto time_string = info[0].ToString().Utf8Value();
  auto format = info[1].ToString().Utf8Value();
  return Napi::BigInt::New(info.Env(), time::strptime(time_string, format));
}

void Shutdown(const Napi::CallbackInfo &info) { ensure_sqlite_shutdown(); }

// Last-resort diagnostics: when an exception escapes a thread or a noexcept
// boundary the process dies either way, but without this handler it dies
// silently. Print the exception text and the throwing thread's native stack
// first, so field reports carry the actual failure site. The stack comes
// from yijinjing's stackwalker, which covers every platform we ship
// (dbghelp/StackWalker on Windows, execinfo with demangling elsewhere).
[[noreturn]] static void terminate_with_backtrace() {
  if (auto captured = std::current_exception()) {
    try {
      std::rethrow_exception(captured);
    } catch (const std::exception &ex) {
      SPDLOG_CRITICAL("terminating on uncaught exception: {}", ex.what());
      fprintf(stderr, "terminating on uncaught exception: %s\n", ex.what());
    } catch (...) {
      fprintf(stderr, "terminating on uncaught non-std exception\n");
    }
  }
  // No arguments: the parameter differs per platform (FILE* on POSIX,
  // EXCEPTION_POINTERS* on Windows) and both defaults are what we want.
  runtime::util::print_stack_trace();
  abort();
}

Napi::Object InitAll(Napi::Env env, Napi::Object exports) {
  std::set_terminate(terminate_with_backtrace);
  ensure_sqlite_initilize();
  Schema::Init(env, exports);
  History::Init(env, exports);
  ConfigStore::Init(env, exports);
  Frame::Init(env, exports);
  Reader::Init(env, exports);
  Assemble::Init(env, exports);
  ActionRecorder::Init(env, exports);
  IODevice::Init(env, exports);
  DataTable::Init(env, exports);
  Watcher::Init(env, exports);
  Tracer::Init(env, exports);
  exports.Set("hash", Napi::Function::New(env, Hash));
  exports.Set("hash64", Napi::Function::New(env, Hash64));
  exports.Set("formatStringToHashHex", Napi::Function::New(env, FormatStringToHashHex));
  exports.Set("formatStringToHash128Hex", Napi::Function::New(env, FormatStringToHash128Hex));
  exports.Set("FAST_HASH_ALGORITHM", Napi::String::New(env, FAST_HASH_ALGORITHM));
  exports.Set("FAST_HASH_ALGORITHM_64", Napi::String::New(env, FAST_HASH_ALGORITHM_64));
  exports.Set("FAST_HASH_ALGORITHM_128", Napi::String::New(env, FAST_HASH_ALGORITHM_128));
  exports.Set("CONTENT_HASH_ALGORITHM_SHA256",
              Napi::String::New(env, yijinjing::storage::CONTENT_HASH_ALGORITHM_SHA256));
  exports.Set("CONTENT_HASH_ALGORITHM_BLAKE3",
              Napi::String::New(env, yijinjing::storage::CONTENT_HASH_ALGORITHM_BLAKE3));
  exports.Set("computeContentHashValue", Napi::Function::New(env, ComputeContentHashValue));
  exports.Set("computeContentHash", Napi::Function::New(env, ComputeContentHash));
  exports.Set("parseContentHash", Napi::Function::New(env, ParseContentHash));
  exports.Set("formatContentHash", Napi::Function::New(env, FormatContentHash));
  exports.Set("verifyContentHash", Napi::Function::New(env, VerifyContentHash));
  exports.Set("storageServiceCapabilities", Napi::Function::New(env, StorageServiceCapabilities));
  exports.Set("durabilityVisibleReceiptTyped", Napi::Function::New(env, DurabilityVisibleReceiptTyped));
  exports.Set("storageStatusTyped", Napi::Function::New(env, StorageStatusTyped));
  exports.Set("storageQueryTyped", Napi::Function::New(env, StorageQueryTyped));
  exports.Set("storageGcPlanTyped", Napi::Function::New(env, StorageGcPlanTyped));
  exports.Set("storageRebuildIndexTyped", Napi::Function::New(env, StorageRebuildIndexTyped));
  exports.Set("storageCompactPlanTyped", Napi::Function::New(env, StorageCompactPlanTyped));
  exports.Set("storageFsckTyped", Napi::Function::New(env, StorageFsckTyped));
  exports.Set("storageRepairPlanTyped", Napi::Function::New(env, StorageRepairPlanTyped));
  exports.Set("storageEpisodeBeginTyped", Napi::Function::New(env, StorageEpisodeBeginTyped));
  exports.Set("storageEpisodeHeartbeatTyped", Napi::Function::New(env, StorageEpisodeHeartbeatTyped));
  exports.Set("storageEpisodeAttachFrameTyped", Napi::Function::New(env, StorageEpisodeAttachFrameTyped));
  exports.Set("storageEpisodeAttachRefTyped", Napi::Function::New(env, StorageEpisodeAttachRefTyped));
  exports.Set("storageEpisodeCloseTyped", Napi::Function::New(env, StorageEpisodeCloseTyped));
  exports.Set("storageEpisodeRecoverTyped", Napi::Function::New(env, StorageEpisodeRecoverTyped));
  exports.Set("storageEpisodeProjectionRebuildTyped", Napi::Function::New(env, StorageEpisodeProjectionRebuildTyped));
  exports.Set("storageEpisodeListTyped", Napi::Function::New(env, StorageEpisodeListTyped));
  exports.Set("storageEpisodeInspectTyped", Napi::Function::New(env, StorageEpisodeInspectTyped));
  exports.Set("storageSourceRegisterTyped", Napi::Function::New(env, StorageSourceRegisterTyped));
  exports.Set("storageSourceUpdateHeadTyped", Napi::Function::New(env, StorageSourceUpdateHeadTyped));
  exports.Set("storageSourceRecordAcceptedRangeTyped", Napi::Function::New(env, StorageSourceRecordAcceptedRangeTyped));
  exports.Set("storageSourceListTyped", Napi::Function::New(env, StorageSourceListTyped));
  exports.Set("storageSourceInspectTyped", Napi::Function::New(env, StorageSourceInspectTyped));
  exports.Set("storageSourceRegistryFsckTyped", Napi::Function::New(env, StorageSourceRegistryFsckTyped));
  exports.Set("storageSourceRegistryRebuildTyped", Napi::Function::New(env, StorageSourceRegistryRebuildTyped));
  exports.Set("storageLayoutTyped", Napi::Function::New(env, StorageLayoutTyped));
  exports.Set("makeStorageServiceRequest", Napi::Function::New(env, MakeStorageServiceRequest));
  exports.Set("runStorageServiceOperation", Napi::Function::New(env, RunStorageServiceOperation));
  exports.Set("acceptStorageManifest", Napi::Function::New(env, AcceptStorageManifest));
  exports.Set("loadStorageLatestManifest", Napi::Function::New(env, LoadStorageLatestManifest));
  exports.Set("exportStorageRecords", Napi::Function::New(env, ExportStorageRecords));
  exports.Set("writeStoragePayloadBytes", Napi::Function::New(env, WriteStoragePayloadBytes));
  exports.Set("contentStorePutIfAbsent", Napi::Function::New(env, ContentStorePutIfAbsent));
  exports.Set("contentStoreHas", Napi::Function::New(env, ContentStoreHas));
  exports.Set("contentStoreVerify", Napi::Function::New(env, ContentStoreVerify));
  exports.Set("contentStoreGet", Napi::Function::New(env, ContentStoreGet));
  exports.Set("contentStoreCapabilities", Napi::Function::New(env, ContentStoreCapabilities));
  exports.Set("formatTime", Napi::Function::New(env, FormatTime));
  exports.Set("parseTime", Napi::Function::New(env, ParseTime));
  exports.Set("shutdown", Napi::Function::New(env, Shutdown));
  InitAppContainer(env, exports);
  return exports;
}
} // namespace kungfu::node

NODE_API_MODULE(kungfu, InitAll)
