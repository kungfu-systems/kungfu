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

Napi::Value FormatStringToHashHex(const Napi::CallbackInfo &info) {
  return Napi::String::New(info.Env(), fmt::format("{:08x}", Hash32(info)));
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
  exports.Set("formatStringToHashHex", Napi::Function::New(env, FormatStringToHashHex));
  exports.Set("CONTENT_HASH_ALGORITHM_SHA256",
              Napi::String::New(env, yijinjing::storage::CONTENT_HASH_ALGORITHM_SHA256));
  exports.Set("CONTENT_HASH_ALGORITHM_BLAKE3",
              Napi::String::New(env, yijinjing::storage::CONTENT_HASH_ALGORITHM_BLAKE3));
  exports.Set("computeContentHashValue", Napi::Function::New(env, ComputeContentHashValue));
  exports.Set("computeContentHash", Napi::Function::New(env, ComputeContentHash));
  exports.Set("parseContentHash", Napi::Function::New(env, ParseContentHash));
  exports.Set("formatContentHash", Napi::Function::New(env, FormatContentHash));
  exports.Set("verifyContentHash", Napi::Function::New(env, VerifyContentHash));
  exports.Set("formatTime", Napi::Function::New(env, FormatTime));
  exports.Set("parseTime", Napi::Function::New(env, ParseTime));
  exports.Set("shutdown", Napi::Function::New(env, Shutdown));
  InitAppContainer(env, exports);
  return exports;
}
} // namespace kungfu::node

NODE_API_MODULE(kungfu, InitAll)
