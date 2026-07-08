// SPDX-License-Identifier: Apache-2.0

//
// Created by Keren Dong on 2022/12/3.
//

#include "operators.h"

using namespace kungfu::rx;
using namespace kungfu::yijinjing;
using namespace kungfu::yijinjing::enums;
using namespace kungfu::yijinjing::types;
using namespace kungfu::runtime;
using namespace kungfu::yijinjing::data;
using namespace kungfu::runtime::practice;

namespace kungfu::node::serialize {
JsRestoreState::JsRestoreState(Napi::ObjectReference &state, location_ptr location)
    : state_(state), location_(std::move(location)) {
  SPDLOG_DEBUG("restore state from {}", location_->uname);
}

void JsRestoreState::operator()(int64_t from, int64_t to, bool sync_schema) {
  auto now = yijinjing::time::now_in_nano();
  auto source = location_->uid;
  auto locator = location_->locator;

  for (auto dest : locator->list_location_dest_by_db(location_)) {
    auto db_file = locator->layout_file(location_, layout::SQLITE, fmt::format("{:08x}", dest));
    auto storage = runtime::cache::make_storage_ptr(db_file, yijinjing::StateDataTypes);
    if (sync_schema) {
      storage->sync_schema();
    }
    boost::hana::for_each(StateDataTypes, [&](auto it) {
      using DataType = typename decltype(+boost::hana::second(it))::type;
      for (const auto &data : runtime::cache::time_spec<DataType>::get_all(storage, from, to)) {
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

} // namespace kungfu::node::serialize