// SPDX-License-Identifier: Apache-2.0

//
// Created by Keren Dong on 2020/4/8.
//

#include "data_table.h"
#include "common.h"

namespace kungfu::node {
Napi::FunctionReference DataTable::constructor = {};

DataTable::DataTable(const Napi::CallbackInfo &info) : ObjectWrap(info) {}

Napi::Value DataTable::Filter(const Napi::CallbackInfo &info) {
  if (info.Length() != 2) {
    return {};
  }
  if (not IsValid(info, 0, &Napi::Value::IsString)) {
    return {};
  }
  auto key = info[0].ToString().Utf8Value();
  auto result = constructor.New({info.This()});
  auto names = Value().GetPropertyNames();
  for (int i = 0; i < names.Length(); i++) {
    auto name = names.Get(i);
    auto data = Value().Get(name).ToObject();
    if (data.Get(key) == info[1]) {
      result.Set(name, data);
    }
  }
  return result;
}

Napi::Value DataTable::NoFilter(const Napi::CallbackInfo &info) {
  if (info.Length() != 2) {
    return {};
  }
  if (not IsValid(info, 0, &Napi::Value::IsString)) {
    return {};
  }
  auto key = info[0].ToString().Utf8Value();
  auto result = constructor.New({info.This()});
  auto names = Value().GetPropertyNames();
  for (int i = 0; i < names.Length(); i++) {
    auto name = names.Get(i);
    auto data = Value().Get(name).ToObject();
    if (data.Get(key) != info[1]) {
      result.Set(name, data);
    }
  }
  return result;
}

Napi::Value DataTable::List(const Napi::CallbackInfo &info) {
  auto names = Value().GetPropertyNames();
  auto result = Napi::Array::New(info.Env(), names.Length());
  for (int i = 0; i < names.Length(); i++) {
    result.Set(i, Value().Get(names.Get(i)).ToObject());
  }
  return result;
}

Napi::Value DataTable::Merge(const Napi::CallbackInfo &info) {
  for (int i = 0; i < info.Length(); i++) {
    if (not IsValid(info, i, &Napi::Value::IsObject)) {
      return {};
    }
  }
  auto result = constructor.New({info.This()});
  auto add_all = [&](auto &&target) {
    auto names = target.GetPropertyNames();
    for (int i = 0; i < names.Length(); i++) {
      auto name = names.Get(i);
      result.Set(name, target.Get(name).ToObject());
    }
  };
  add_all(Value().ToObject());
  for (int i = 0; i < info.Length(); i++) {
    if (info[i].IsObject()) {
      add_all(info[i].ToObject());
    }
  }
  return result;
}

Napi::Value DataTable::Range(const Napi::CallbackInfo &info) {
  if (not IsValid(info, 0, &Napi::Value::IsString)) {
    return {};
  }
  if (not IsValid(info, 1)) {
    return {};
  }
  auto key = info[0].ToString().Utf8Value();
  auto result = constructor.New({info.This()});
  auto names = Value().GetPropertyNames();
  for (int i = 0; i < names.Length(); i++) {
    auto name = names.Get(i);
    auto data = Value().Get(name).ToObject();
    auto value = data.Get(key);
    auto add = [&](const auto &val, const auto &lower_bound, const auto &upper_bound) {
      if (val >= lower_bound and (val <= upper_bound or upper_bound == lower_bound)) {
        result.Set(name, data);
      }
    };
    if (value.IsNumber() and IsValid(info, 1, &Napi::Value::IsNumber)) {
      auto val = value.ToNumber().Int32Value();
      auto lower_bound = info[1].ToNumber().Int32Value();
      auto upper_bound = IsValid(info, 2, &Napi::Value::IsNumber) ? info[2].ToNumber().Int32Value() : INT32_MAX;
      add(val, lower_bound, upper_bound);
    }
    if (value.IsBigInt() and IsValid(info, 1, &Napi::Value::IsBigInt)) {
      auto val = GetBigInt(value);
      auto lower_bound = GetBigInt(info, 1);
      auto upper_bound = IsValid(info, 2, &Napi::Value::IsBigInt) ? GetBigInt(info, 2) : INT64_MAX;
      add(val, lower_bound, upper_bound);
    }
    if (value.IsBigInt() and IsValid(info, 1, &Napi::Value::IsString)) {
      bool lossless;
      auto val = value.As<Napi::BigInt>().Int64Value(&lossless);
      auto lower_bound = TryParseTime(info, 1);
      auto upper_bound = IsValid(info, 2, &Napi::Value::IsString) ? TryParseTime(info, 2) : lower_bound;
      add(val, lower_bound, upper_bound);
    }
    if (value.IsString() and IsValid(info, 1, &Napi::Value::IsString)) {
      auto val = value.ToString().Utf8Value();
      auto lower_bound = info[1].ToString().Utf8Value();
      auto upper_bound = IsValid(info, 2, &Napi::Value::IsString) ? info[2].ToString().Utf8Value() : lower_bound;
      add(val, lower_bound, upper_bound);
    }
  }
  return result;
}

Napi::Value DataTable::Sort(const Napi::CallbackInfo &info) {
  if (not IsValid(info, 0, &Napi::Value::IsString)) {
    return {};
  }

  auto key = info[0].ToString().Utf8Value();
  auto names = Value().GetPropertyNames();
  auto predicate = [&](auto &a, auto &b) {
    auto va = a.Get(key);
    auto vb = b.Get(key);
    if (va.IsNumber()) {
      return va.ToNumber().Int32Value() > vb.ToNumber().Int32Value();
    }
    if (va.IsBigInt()) {
      return GetBigInt(va) > GetBigInt(vb);
    }
    if (va.IsString()) {
      return va.ToString().Utf8Value() > vb.ToString().Utf8Value();
    }
    return va > vb;
  };

  std::vector<Napi::Object> sorted = {};
  for (int i = 0; i < names.Length(); i++) {
    auto name = names.Get(i);
    auto data = Value().Get(name).ToObject();
    sorted.insert(std::upper_bound(sorted.begin(), sorted.end(), data, predicate), data);
  }

  auto result = Napi::Array::New(info.Env(), sorted.size());
  for (int i = 0; i < sorted.size(); i++) {
    result.Set(i, sorted[i]);
  }
  return result;
}

void DataTable::Init(Napi::Env env, Napi::Object exports) {
  Napi::HandleScope scope(env);
  env.AddCleanupHook(cleanup);

  Napi::Function func = DefineClass(env, "DataTable",
                                    {
                                        InstanceMethod("filter", &DataTable::Filter),     //
                                        InstanceMethod("nofilter", &DataTable::NoFilter), //
                                        InstanceMethod("list", &DataTable::List),         //
                                        InstanceMethod("merge", &DataTable::Merge),       //
                                        InstanceMethod("range", &DataTable::Range),       //
                                        InstanceMethod("sort", &DataTable::Sort)          //
                                    });

  constructor = Napi::Persistent(func);
  constructor.SuppressDestruct();

  exports.Set("DataTable", func);
}

Napi::Value DataTable::NewInstance(const Napi::Value arg) { return constructor.New({arg}); }
} // namespace kungfu::node
