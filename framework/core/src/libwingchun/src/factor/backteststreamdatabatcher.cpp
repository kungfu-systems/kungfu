// SPDX-License-Identifier: Apache-2.0

#include <kungfu/wingchun/factor/backteststreamdatabatcher.h>

using namespace kungfu::rx;
using namespace kungfu::longfist::types;

namespace kungfu::wingchun::factor {
std::vector<kungfu::yijinjing::data::location_ptr>
BackTestStreamDataBatcher::get_locations(const std::string &source, int64_t begin_time,
                                         const std::string &instrument_id, const std::string &exchange_id,
                                         int32_t data_tag) {
  int64_t slice_begin_time = begin_time;
  std::vector<kungfu::yijinjing::data::location_ptr> location_vec;
  while (slice_begin_time <= app_.now()) {
    auto location =
        from_indexer_->find_md_slice_location(slice_begin_time, source, source, instrument_id, exchange_id, data_tag);

    if (location) {
      auto vector = location->locator->list_location_dest(location);
      if (vector.empty()) {
        SPDLOG_WARN("没有journal文件");
      } else {
        location_vec.push_back(location);
      }
    }
    slice_begin_time = 1 + from_indexer_->get_md_slice_end_time(slice_begin_time, source, source, instrument_id,
                                                                exchange_id, data_tag);
  }
  return location_vec;
}

int64_t BackTestStreamDataBatcher::get_begin_time(const std::string instrument_exchange_type_id) {
  if (time_stamp_map_.find(instrument_exchange_type_id) != time_stamp_map_.end()) {
    return time_stamp_map_[instrument_exchange_type_id];
  } else {
    return app_.get_begin_time();
  }
}
} // namespace kungfu::wingchun::factor