// SPDX-License-Identifier: Apache-2.0

//
// Created by Keren Dong on 2020/1/1.
//

#ifndef KUNGFU_NODE_IO_H
#define KUNGFU_NODE_IO_H

#include "common.h"
#include "journal.h"

#include <kungfu/runtime/io.h>

namespace kungfu::node {

class IODevice : public Napi::ObjectWrap<IODevice>, public kungfu::runtime::io_device {
public:
  explicit IODevice(const Napi::CallbackInfo &info);

  static void Init(Napi::Env env, Napi::Object exports);

  Napi::Value OpenReader(const Napi::CallbackInfo &info);

  Napi::Value GetAllLocations(const Napi::CallbackInfo &info);

  static Napi::Value NewInstance(const Napi::Value arg) { return constructor.New({arg}); }

  static yijinjing::data::locator_ptr GetLocatorByIndex(const Napi::Array &locators, int index = 0);

  static yijinjing::data::location_ptr ExtractLocation(const Napi::CallbackInfo &info, int index,
                                                       const yijinjing::data::locator_ptr &locator);

  static std::vector<yijinjing::data::locator_ptr> ExtractLocators(const Napi::CallbackInfo &info);

  static yijinjing::data::locator_ptr GetDefaultRuntimeLocator();

  static yijinjing::data::locator_ptr GetRuntimeLocator(const std::string &dirname);

  static yijinjing::data::locator_ptr ExtractRuntimeLocatorByIndex(const Napi::CallbackInfo &info, int index);

  static Napi::FunctionReference constructor;

  static void cleanup() {
    SPDLOG_INFO("IODevice reset");
    IODevice::constructor.Reset();
  }
};
} // namespace kungfu::node

#endif // KUNGFU_NODE_IO_H
