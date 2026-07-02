// SPDX-License-Identifier: Apache-2.0

//
// Created by Keren Dong on 2022/12/3.
//

#include "operators.h"

using namespace kungfu::rx;
using namespace kungfu::longfist;
using namespace kungfu::longfist::enums;
using namespace kungfu::longfist::types;
using namespace kungfu::yijinjing;
using namespace kungfu::yijinjing::data;
using namespace kungfu::practice;

namespace kungfu::node::serialize {
JsResetCache::JsResetCache(apprentice &app, Napi::ObjectReference &state) : app_(app), state_(state) {}

void JsResetCache::operator()(const state<CacheReset> &state) {
  auto source = state.source;
  auto dest = state.dest;
  const auto &request = state.data;
  boost::hana::for_each(StateDataTypes, [&](auto it) {
    using DataType = typename decltype(+boost::hana::second(it))::type;
    if (DataType::tag == request.msg_type) {
      auto type_name = DataType::type_name.c_str();
      auto table = state_.Get(type_name).ToObject();
      auto names = table.GetPropertyNames();
      std::vector<std::string> delete_keys = {};
      for (int i = 0; i < names.Length(); i++) {
        auto name = names.Get(i).ToString().Utf8Value();
        auto value = table.Get(name).ToObject();
        auto source_id = value.Get("source").ToNumber().Uint32Value();
        auto dest_id = value.Get("dest").ToNumber().Uint32Value();
        if ((source_id == source and dest_id == dest) or source_id == dest) {
          delete_keys.push_back(name);
        }
      }
      for (const auto &key : delete_keys) {
        table.Delete(key);
      }
    }
  });
}

} // namespace kungfu::node::serialize