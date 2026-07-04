// SPDX-License-Identifier: Apache-2.0

//
// Created by Keren Dong on 2020/2/11.
//

#ifndef KUNGFU_NODE_SERIALIZE_H
#define KUNGFU_NODE_SERIALIZE_H

#include "common.h"
#include "data_table.h"

#include <kungfu/common.h>
#include <kungfu/longfist/longfist.h>
#include <kungfu/yijinjing/cache/backend.h>
#include <kungfu/yijinjing/practice/apprentice.h>
#include <kungfu/yijinjing/time.h>

namespace kungfu::node::serialize {
template <typename DataType> class JsMake {

public:
  explicit JsMake(const char *_type_name) : type_name(_type_name) {}

  Napi::Value operator()(const Napi::CallbackInfo &info) {
    auto now = yijinjing::time::now_in_nano();
    auto object = Napi::Object::New(info.Env());
    object.DefineProperties({
        Napi::PropertyDescriptor::Value("tag", Napi::Number::New(info.Env(), DataType::tag)),
        Napi::PropertyDescriptor::Value("type", Napi::String::New(info.Env(), type_name)),
        Napi::PropertyDescriptor::Value("ts", Napi::BigInt::New(object.Env(), now)) // format keeper
    });
    boost::hana::for_each(boost::hana::accessors<DataType>(), [&](auto it) {
      auto name = boost::hana::first(it);
      auto accessor = boost::hana::second(it);
      using ValueType = std::decay_t<std::invoke_result_t<decltype(accessor), const DataType &>>;
      InitValue<ValueType>(object, name.c_str());
    });
    return object;
  }

private:
  const char *type_name;

  template <typename ValueType>
  std::enable_if_t<std::is_enum_v<ValueType> and not std::is_convertible_v<ValueType, int>>
  InitValue(Napi::Object &object, const char *name) {
    object.Set(name, Napi::Number::New(object.Env(), 0));
  }

  template <typename ValueType>
  std::enable_if_t<std::is_same_v<ValueType, bool>> InitValue(Napi::Object &object, const char *name) {
    object.Set(name, Napi::Boolean::New(object.Env(), false));
  }

  template <typename ValueType>
  std::enable_if_t<kungfu::is_signed_int_v<ValueType> or kungfu::is_unsigned_int_v<ValueType>>
  InitValue(Napi::Object &object, const char *name) {
    object.Set(name, Napi::Number::New(object.Env(), 0));
  }

  template <typename ValueType>
  std::enable_if_t<kungfu::is_signed_bigint_v<ValueType>> InitValue(Napi::Object &object, const char *name) {
    object.Set(name, Napi::BigInt::New(object.Env(), (int64_t)0));
  }

  template <typename ValueType>
  std::enable_if_t<kungfu::is_unsigned_bigint_v<ValueType>> InitValue(Napi::Object &object, const char *name) {
    object.Set(name, Napi::BigInt::New(object.Env(), (uint64_t)0));
  }

  template <typename ValueType>
  std::enable_if_t<std::is_floating_point_v<ValueType>> InitValue(Napi::Object &object, const char *name) {
    object.Set(name, Napi::Number::New(object.Env(), 0));
  }

  template <typename ValueType>
  std::enable_if_t<kungfu::is_array_of_v<ValueType, char>> InitValue(Napi::Object &object, const char *name) {
    object.Set(name, Napi::String::New(object.Env(), ""));
  }

  template <typename ValueType>
  std::enable_if_t<kungfu::is_array_of_others_v<ValueType, char>> InitValue(Napi::Object &object, const char *name) {
    object.Set(name, Napi::Array::New(object.Env(), ValueType::length));
  }

  template <typename ValueType>
  std::enable_if_t<kungfu::is_vector_v<ValueType>> InitValue(Napi::Object &object, const char *name) {
    object.Set(name, Napi::Array::New(object.Env(), ValueType::length));
  }

  template <typename ValueType>
  std::enable_if_t<std::is_same_v<ValueType, std::string>> InitValue(Napi::Object &object, const char *name) {
    object.Set(name, Napi::String::New(object.Env(), ""));
  }
};

class JsSet {
public:
  template <typename DataType> void operator()(const DataType &data, Napi::Object &object) {
    boost::hana::for_each(boost::hana::accessors<DataType>(), [&](auto it) {
      auto name = boost::hana::first(it);
      auto accessor = boost::hana::second(it);
      Set(object, name.c_str(), accessor(data));
    });
  }

  template <typename DataType>
  void operator()(const DataType &data, Napi::ObjectReference &state, uint32_t source, uint32_t dest, int64_t ts) {
    auto type_name = DataType::type_name.c_str();
    auto uid_key = fmt::format("{:016x}", data.uid());
    auto table = state.Get(type_name).ToObject();
    if (not table.Has(uid_key)) {
      auto object = Napi::Object::New(table.Env());
      object.DefineProperties({
          Napi::PropertyDescriptor::Value("tag", Napi::Number::New(table.Env(), DataType::tag)),
          Napi::PropertyDescriptor::Value("type", Napi::String::New(table.Env(), type_name)),
          Napi::PropertyDescriptor::Value("uid_key", Napi::String::New(table.Env(), uid_key)),
          Napi::PropertyDescriptor::Value("source", Napi::Number::New(table.Env(), source)),
          Napi::PropertyDescriptor::Value("dest", Napi::Number::New(table.Env(), dest)),
          Napi::PropertyDescriptor::Value("ts", Napi::BigInt::New(table.Env(), ts)) // format keeper
      });
      table.Set(uid_key, object);
    }
    auto object = table.Get(uid_key).ToObject();
    operator()(data, object);
    object.Set("source", Napi::Number::New(table.Env(), source));
    object.Set("dest", Napi::Number::New(table.Env(), dest));
    object.Set("ts", Napi::BigInt::New(table.Env(), ts));
  }

private:
  template <typename ValueType>
  std::enable_if_t<std::is_enum_v<ValueType> and not std::is_convertible_v<ValueType, int>>
  Set(Napi::Object &object, const char *name, const ValueType &value) {
    object.Set(name, Napi::Number::New(object.Env(), static_cast<int>(value)));
  }

  template <typename ValueType>
  std::enable_if_t<std::is_same_v<ValueType, bool>> Set(Napi::Object &object, const char *name,
                                                        const ValueType &value) {
    object.Set(name, Napi::Boolean::New(object.Env(), value));
  }

  template <typename ValueType>
  std::enable_if_t<kungfu::is_signed_int_v<ValueType> or kungfu::is_unsigned_int_v<ValueType>>
  Set(Napi::Object &object, const char *name, const ValueType &value) {
    object.Set(name, Napi::Number::New(object.Env(), value));
  }

  template <typename ValueType>
  std::enable_if_t<kungfu::is_signed_bigint_v<ValueType> or kungfu::is_unsigned_bigint_v<ValueType>>
  Set(Napi::Object &object, const char *name, const ValueType &value) {
    object.Set(name, Napi::BigInt::New(object.Env(), value));
  }

  template <typename ValueType>
  std::enable_if_t<std::is_floating_point_v<ValueType>> Set(Napi::Object &object, const char *name,
                                                            const ValueType &value) {
    object.Set(name, Napi::Number::New(object.Env(), value));
  }

  template <typename ValueType>
  std::enable_if_t<kungfu::is_array_of_v<ValueType, char>> Set(Napi::Object &object, const char *name,
                                                               const ValueType &value) {
    object.Set(name, Napi::String::New(object.Env(), value.value, strlen(value.value)));
  }

  template <typename ValueType>
  std::enable_if_t<kungfu::is_array_of_others_v<ValueType, char> or kungfu::is_vector_v<ValueType>>
  Set(Napi::Object &object, const char *name, const ValueType &value) {
    auto array = Napi::Array::New(object.Env(), ValueType::length);
    for (int i = 0; i < ValueType::length; i++) {
      array.Set(i, ToNapiValue(object, value[i]));
    }
    object.Set(name, array);
  }

  template <typename ValueType>
  std::enable_if_t<std::is_same_v<ValueType, std::string>> Set(Napi::Object &object, const char *name,
                                                               const ValueType &value) {
    object.Set(name, Napi::String::New(object.Env(), value));
  }

  template <typename ValueType>
  std::enable_if_t<kungfu::is_signed_int_v<ValueType> or std::is_floating_point_v<ValueType>, Napi::Value>
  ToNapiValue(Napi::Object &object, const ValueType &value) {
    return Napi::Number::New(object.Env(), value);
  }

  template <typename ValueType>
  std::enable_if_t<kungfu::is_signed_bigint_v<ValueType>, Napi::Value> ToNapiValue(Napi::Object &object,
                                                                                   const ValueType &value) {
    return Napi::BigInt::New(object.Env(), value);
  }

  template <typename ValueType>
  std::enable_if_t<std::is_same_v<ValueType, std::string>, Napi::Value> ToNapiValue(Napi::Object &object,
                                                                                    const ValueType &value) {
    return Napi::String::New(object.Env(), value);
  }
};

class JsGet {
public:
  template <typename DataType> void operator()(const Napi::Object &object, DataType &data) {
    boost::hana::for_each(boost::hana::accessors<DataType>(), [&](auto it) {
      auto name = boost::hana::first(it);
      auto accessor = boost::hana::second(it);
      using ValueType = std::decay_t<std::invoke_result_t<decltype(accessor), const DataType &>>;
      Get(const_cast<ValueType &>(accessor(data)), name.c_str(), object);
    });
  }

private:
  template <typename ValueType>
  std::enable_if_t<std::is_enum_v<ValueType> and not std::is_convertible_v<ValueType, int>>
  Get(ValueType &value, const char *name, const Napi::Object &object) {
    value = static_cast<ValueType>(object.Get(name).ToNumber().Int32Value());
  }

  template <typename ValueType>
  std::enable_if_t<std::is_same_v<ValueType, bool>> Get(ValueType &value, const char *name,
                                                        const Napi::Object &object) {
    value = object.Get(name).ToBoolean().Value();
  }

  template <typename ValueType>
  std::enable_if_t<kungfu::is_signed_int_v<ValueType>> Get(ValueType &value, const char *name,
                                                           const Napi::Object &object) {
    value = object.Get(name).ToNumber().Int32Value();
  }

  template <typename ValueType>
  std::enable_if_t<kungfu::is_unsigned_int_v<ValueType>> Get(ValueType &value, const char *name,
                                                             const Napi::Object &object) {
    value = object.Get(name).ToNumber().Uint32Value();
  }

  template <typename ValueType>
  std::enable_if_t<kungfu::is_signed_bigint_v<ValueType>> Get(ValueType &value, const char *name,
                                                              const Napi::Object &object) {
    if (object.Get(name).IsNumber()) {
      value = object.Get(name).ToNumber().Int32Value();
    }
    if (object.Get(name).IsBigInt()) {
      bool lossless;
      value = object.Get(name).As<Napi::BigInt>().Int64Value(&lossless);
    }
  }

  template <typename ValueType>
  std::enable_if_t<kungfu::is_unsigned_bigint_v<ValueType>> Get(ValueType &value, const char *name,
                                                                const Napi::Object &object) {
    if (object.Get(name).IsNumber()) {
      value = object.Get(name).ToNumber().Uint32Value();
    }
    if (object.Get(name).IsBigInt()) {
      bool lossless;
      value = object.Get(name).As<Napi::BigInt>().Uint64Value(&lossless);
    }
  }

  template <typename ValueType>
  std::enable_if_t<std::is_floating_point_v<ValueType>> Get(ValueType &value, const char *name,
                                                            const Napi::Object &object) {
    value = object.Get(name).ToNumber().DoubleValue();
  }

  template <typename ValueType>
  std::enable_if_t<kungfu::is_array_of_v<ValueType, char>> Get(ValueType &value, const char *name,
                                                               const Napi::Object &object) {
    auto v = object.Get(name).ToString().Utf8Value();
    kungfu::copy_string(value.value, v.c_str());
  }

  template <typename ValueType>
  std::enable_if_t<kungfu::is_array_of_others_v<ValueType, char>> Get(ValueType &value, const char *name,
                                                                      const Napi::Object &object) {
    auto buf = object.Get(name).As<Napi::ArrayBuffer>();
    memcpy(value.value, buf.Data(), buf.ByteLength());
  }

  template <typename ValueType> void Get(std::vector<ValueType> &value, const char *name, const Napi::Object &object) {
    auto buf = object.Get(name).As<Napi::ArrayBuffer>();
    for (int i = 0; i < buf.ByteLength(); i += sizeof(ValueType)) {
      auto addr = reinterpret_cast<uintptr_t>(buf.Data()) + i;
      value.push_back(*reinterpret_cast<ValueType *>(addr));
    }
  }

  template <typename ValueType>
  std::enable_if_t<std::is_same_v<ValueType, std::string>> Get(ValueType &value, const char *name,
                                                               const Napi::Object &object) {
    value = object.Get(name).ToString().Utf8Value();
  }
};

class JsRestoreState {
public:
  JsRestoreState(Napi::ObjectReference &state, yijinjing::data::location_ptr location);

  void operator()(int64_t from, int64_t to, bool sync_schema = false);

  template <typename... Ts> void filter_no(int64_t from, int64_t to, bool sync_schema = false) {
    auto now = yijinjing::time::now_in_nano();
    auto source = location_->uid;
    auto locator = location_->locator;

    for (auto dest : locator->list_location_dest_by_db(location_)) {
      auto db_file = locator->layout_file(location_, longfist::enums::layout::SQLITE, fmt::format("{:08x}", dest));
      auto storage = cache::make_storage_ptr(db_file, longfist::StateDataTypes);
      if (sync_schema) {
        storage->sync_schema();
      }

      boost::hana::for_each(longfist::StateDataTypes, [&](auto it) {
        using DataType = typename decltype(+boost::hana::second(it))::type;
        if constexpr (type_belong_to<DataType, Ts...>()) {
          return;
        }

        for (const auto &data : cache::time_spec<DataType>::get_all(storage, from, to)) {
          try {
            set(data, state_, source, dest, now);
          } catch (const std::exception &e) {
            SPDLOG_ERROR("Unexpected exception by operator() set {}", e.what());
            continue;
          }
        }
      });
    }
  }

private:
  Napi::ObjectReference &state_;
  yijinjing::data::location_ptr location_;
  JsSet set = {};
};

class JsUpdateState {
public:
  explicit JsUpdateState(Napi::ObjectReference &state) : state_(state) {};

  template <typename DataType>
  void operator()(int64_t update_time, uint32_t source, uint32_t dest, const DataType &data) {
    set(data, state_, source, dest, update_time);
  }

  template <typename DataType> void operator<<(const typed_event_ptr<DataType> &event) {
    operator()(event->gen_time(), event->source(), event->dest(), event->template data<DataType>());
  }

private:
  Napi::ObjectReference &state_;
  JsSet set = {};
};

class JsPublishState {
public:
  JsPublishState(practice::apprentice &app, Napi::ObjectReference &state);

  void operator()(Napi::Object object);

private:
  practice::apprentice &app_;
  Napi::ObjectReference &state_;
  JsGet get = {};
};

class JsResetCache {
public:
  JsResetCache(practice::apprentice &app, Napi::ObjectReference &state);

  void operator()(const state<longfist::types::CacheReset> &state);

private:
  practice::apprentice &app_;
  Napi::ObjectReference &state_;
};

void InitObjectReference(const Napi::CallbackInfo &info, Napi::ObjectReference &data);

void InitStateMap(const Napi::CallbackInfo &info, Napi::ObjectReference &state, const std::string &name);

void RefreshTradingDataInStateMap(Napi::ObjectReference &state, const std::string &name);
} // namespace kungfu::node::serialize

#endif // KUNGFU_NODE_SERIALIZE_H
