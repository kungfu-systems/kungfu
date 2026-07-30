// SPDX-License-Identifier: Apache-2.0

//
// Created by Keren Dong on 2020/4/8.
//

#ifndef KUNGFU_NODE_COMMON_H
#define KUNGFU_NODE_COMMON_H

#include <kungfu/yijinjing/time.h>
#include <napi.h>

namespace kungfu::node {
inline bool IsValid(const Napi::CallbackInfo &info, int i) {
  return info.Length() > i and not info[i].IsEmpty() and not info[i].IsUndefined();
}

template <typename MemberPtr = bool (Napi::Value::*)() const>
inline bool IsValid(const Napi::CallbackInfo &info, int i, MemberPtr ptr) {
  return info.Length() > i and not info[i].IsEmpty() and not info[i].IsUndefined() and (info[i].*ptr)();
}

template <typename MemberPtr = bool (Napi::Value::*)() const>
inline bool IsValid(const Napi::Array &info, int i, MemberPtr ptr) {
  return info.Length() > i and not info[i].IsEmpty() and not info[i].IsUndefined() and (info[i].*ptr)();
}

inline int64_t TryParseTime(const Napi::CallbackInfo &info, int i) {
  typedef yijinjing::time time;
  if (IsValid(info, i, &Napi::Value::IsString)) {
    auto time_string = info[i].ToString().Utf8Value();
    return time::strptime(time_string, {KUNGFU_DATETIME_FORMAT, KUNGFU_COMPACT_DATE_FORMAT, KUNGFU_TIMESTAMP_FORMAT});
  }
  return INT64_MAX;
}

inline int64_t GetBigInt(const Napi::Value &value) {
  if (value.IsNumber()) {
    return value.ToNumber().Int32Value();
  }
  if (value.IsBigInt()) {
    bool lossless;
    return value.As<Napi::BigInt>().Int64Value(&lossless);
  }
  return INT64_MAX;
}

inline int64_t GetBigInt(const Napi::CallbackInfo &info, int i) { return GetBigInt(info[i]); }

inline bool GetBool(const Napi::CallbackInfo &info, int i) {
  if (not IsValid(info, i, &Napi::Value::IsBoolean)) {
    throw Napi::Error::New(info.Env(), "Invalid bool argument index: " + std::to_string(i));
  }
  return info[i].As<Napi::Boolean>().Value();
}

inline int32_t GetNumber(const Napi::CallbackInfo &info, int i) {
  if (not IsValid(info, i, &Napi::Value::IsNumber)) {
    throw Napi::Error::New(info.Env(), "Invalid number argument index: " + std::to_string(i));
  }
  return info[i].As<Napi::Number>().Int32Value();
}

} // namespace kungfu::node
#endif // KUNGFU_NODE_COMMON_H
