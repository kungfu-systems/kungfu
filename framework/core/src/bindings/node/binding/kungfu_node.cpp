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
#include <kungfu/runtime/io.h>
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
#include "session_store.h"
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
  SessionStore::Init(env, exports);
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
