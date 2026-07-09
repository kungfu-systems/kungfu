// SPDX-License-Identifier: Apache-2.0

//
// Created by Keren Dong on 2020/1/1.
//

#include "io.h"

using namespace kungfu::yijinjing;
using namespace kungfu::yijinjing::enums;
using namespace kungfu::yijinjing::types;
using namespace kungfu::runtime;
using namespace kungfu::yijinjing::data;

namespace kungfu::node {

Napi::FunctionReference IODevice::constructor = {};

IODevice::IODevice(const Napi::CallbackInfo &info)
    : ObjectWrap(info),
      io_device(ExtractLocation(info, 0, IODevice::ExtractRuntimeLocatorByIndex(info, 1)), false, true) {
  Napi::Env env = info.Env();
  Napi::HandleScope scope(env);
}

Napi::Value IODevice::OpenReader(const Napi::CallbackInfo &info) { return Reader::NewInstance(info.This()); }

locator_ptr IODevice::GetLocatorByIndex(const Napi::Array &locators, int index) {
  if (not IsValid(locators, index, &Napi::Value::IsString)) {
    throw Napi::Error::New(locators.Env(), "Invalid locator argument");
  }

  auto dirname = locators[index].As<Napi::String>().Utf8Value();
  return IODevice::GetRuntimeLocator(dirname);
}

std::vector<locator_ptr> IODevice::ExtractLocators(const Napi::CallbackInfo &info) {
  if (not IsValid(info, 0, &Napi::Value::IsArray)) {
    throw Napi::Error::New(info.Env(), "Invalid locators argument");
  }
  std::vector<locator_ptr> result = {};
  auto locators = info[0].As<Napi::Array>();
  for (int i = 0; i < locators.Length(); i++) {
    result.push_back(IODevice::GetLocatorByIndex(locators, i));
  }
  return result;
}

Napi::Value IODevice::GetAllLocations(const Napi::CallbackInfo &info) {

  auto locator = get_locator();
  auto table = Napi::Object::New(info.Env());

  for (auto location : locator->list_locations(".*", ".*", ".*", ".*")) {
    auto uid = fmt::format("{:016x}", location->uid);
    auto locationObj = Napi::Object::New(info.Env());
    locationObj.Set("role", Napi::String::New(info.Env(), get_location_role_name(location->role)));
    locationObj.Set("namespace", Napi::String::New(info.Env(), location->namespace_));
    locationObj.Set("name", Napi::String::New(info.Env(), location->name));
    locationObj.Set("mode", Napi::String::New(info.Env(), get_mode_name(location->mode)));
    locationObj.Set("uname", Napi::String::New(info.Env(), location->uname));
    locationObj.Set("uid", Napi::Number::New(info.Env(), location->uid));
    table.Set(uid, locationObj);
  }

  return table;
}

location_ptr IODevice::ExtractLocation(const Napi::CallbackInfo &info, int index, const locator_ptr &locator) {
  try {
    if (info[index].IsObject()) {
      auto obj = info[index].ToObject();
      auto namespace_value = obj.Has("namespace") ? obj.Get("namespace") : obj.Get("group");
      return location::make_shared(get_mode_by_name(obj.Get("mode").ToString().Utf8Value()),
                                   get_location_role_by_name(obj.Get("role").ToString().Utf8Value()),
                                   namespace_value.ToString().Utf8Value(), obj.Get("name").ToString().Utf8Value(),
                                   locator);
    } else {
      return location::make_shared(get_mode_by_name(info[index + 3].As<Napi::String>().Utf8Value()),
                                   get_location_role_by_name(info[index].As<Napi::String>().Utf8Value()),
                                   info[index + 1].As<Napi::String>().Utf8Value(),
                                   info[index + 2].As<Napi::String>().Utf8Value(), locator);
    }
  } catch (const std::exception &ex) {
    throw Napi::Error::New(info.Env(), fmt::format("invalid location arguments: {}", ex.what()));
  } catch (...) {
    throw Napi::Error::New(info.Env(), "invalid location arguments");
  }
}

locator_ptr IODevice::GetRuntimeLocator(const std::string &dirname) {
  return std::make_shared<yijinjing::data::locator>(dirname);
}

locator_ptr IODevice::GetDefaultRuntimeLocator() { return std::make_shared<yijinjing::data::locator>(); }

locator_ptr IODevice::ExtractRuntimeLocatorByIndex(const Napi::CallbackInfo &info, int index) {
  if (not IsValid(info, index, &Napi::Value::IsString)) {
    throw Napi::Error::New(info.Env(), "Invalid Info[" + std::to_string(index) + "] type, not string");
  }

  auto runtime_dir = info[index].As<Napi::String>().Utf8Value();
  return IODevice::GetRuntimeLocator(runtime_dir);
}

void IODevice::Init(Napi::Env env, Napi::Object exports) {
  Napi::HandleScope scope(env);
  env.AddCleanupHook(cleanup);

  Napi::Function func = DefineClass(env, "IODevice",
                                    {
                                        InstanceMethod("openReader", &IODevice::OpenReader),
                                        InstanceMethod("getAllLocations", &IODevice::GetAllLocations),
                                    });

  constructor = Napi::Persistent(func);
  constructor.SuppressDestruct();

  exports.Set("IODevice", func);
}
} // namespace kungfu::node
