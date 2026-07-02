#include <kungfu/wingchun/common.h>
#include <kungfu/wingchun/tool/sliceindexer.h>

using kungfu::yijinjing::time;
using kungfu::yijinjing::time_unit;
using namespace kungfu::longfist::types;
using namespace kungfu::longfist::enums;
using namespace kungfu::yijinjing::data;
using namespace kungfu::yijinjing::journal;

namespace kungfu::wingchun::tool {
location_ptr SliceIndexer::find_md_slice_location(int64_t nano_time, const std::string &group, const std::string &name,
                                                  const std::string &instrument_id, const std::string &exchange_id,
                                                  int32_t data_type) const {
  auto slice_locator = std::make_shared<locator>(mode::BACKTEST);
  uint32_t cache_uid = hash_backtest_cache(name, get_begin_time(), get_end_time());
  auto slice_location =
      location::make_shared(mode::BACKTEST, category::MD, group, fmt::format("{:08x}", cache_uid), slice_locator);
  return slice_location;
}

int64_t SliceIndexer::get_md_slice_end_time(int64_t nano_time, const std::string &group, const std::string &name,
                                            const std::string &instrument_id, const std::string &exchange_id,
                                            int32_t data_type) const {
  return get_end_time();
}

location_ptr SliceIndexer::find_operator_slice_location(int64_t nano_time, const std::string &group,
                                                        const std::string &name) const {
  auto slice_locator = std::make_shared<locator>(mode::BACKTEST);
  uint32_t cache_uid = hash_backtest_cache(name, get_begin_time(), get_end_time());
  auto slice_location =
      location::make_shared(mode::BACKTEST, category::OPERATOR, group, fmt::format("{:08x}", cache_uid), slice_locator);
  return slice_location;
}

int64_t SliceIndexer::get_operator_slice_end_time(int64_t nano_time, const std::string &group,
                                                  const std::string &name) const {
  return get_end_time();
}

int SliceIndexer::acquire_lead_ratio() const { return 1; }

int SliceIndexer::release_delay_ratio() const { return 0; }

location_ptr DayIndexer::find_md_slice_location(int64_t nano_time, const std::string &group, const std::string &name,
                                                const std::string &instrument_id, const std::string &exchange_id,
                                                int32_t data_type) const {
  auto slice_end_time = time::strftime(
      get_md_slice_end_time(nano_time, group, name, instrument_id, exchange_id, data_type), KUNGFU_DATETIME_FORMAT);
  std::string dir_name =
      fmt::format("{}_{}_{}@{}", slice_end_time, std::to_string(data_type), instrument_id, exchange_id);
  std::vector<std::string> tags = {"day_md", dir_name};
  auto slice_locator = std::make_shared<locator>(mode::DATA, tags);
  auto slice_location = location::make_shared(mode::DATA, category::MD, group, name, slice_locator);
  return slice_location;
}

int64_t DayIndexer::get_md_slice_end_time(int64_t nano_time, const std::string &group, const std::string &name,
                                          const std::string &instrument_id, const std::string &exchange_id,
                                          int32_t data_type) const {
  return end_of_day(nano_time);
}

location_ptr DayIndexer::find_operator_slice_location(int64_t nano_time, const std::string &group,
                                                      const std::string &name) const {
  auto slice_end_time = time::strftime(get_operator_slice_end_time(nano_time, group, name), KUNGFU_DATETIME_FORMAT);
  std::string dir_name = fmt::format("{}_{}_{}", slice_end_time, group, name);
  std::vector<std::string> tags = {"day_operator", dir_name};
  auto slice_locator = std::make_shared<locator>(mode::DATA, tags);
  auto slice_location = location::make_shared(mode::DATA, category::OPERATOR, group, name, slice_locator);
  return slice_location;
}
int64_t DayIndexer::get_operator_slice_end_time(int64_t nano_time, const std::string &group,
                                                const std::string &name) const {
  return end_of_day(nano_time);
}

int64_t DayIndexer::end_of_day(int64_t nano_time) const {
  // return nano_time - (nano_time % ( 15 * time_unit::NANOSECONDS_PER_SECOND));
  return nano_time - (nano_time % time_unit::NANOSECONDS_PER_HOUR) + time_unit::NANOSECONDS_PER_HOUR;
  // return time::calendar_day_start(nano_time) + time_unit::NANOSECONDS_PER_DAY;
}
} // namespace kungfu::wingchun::tool