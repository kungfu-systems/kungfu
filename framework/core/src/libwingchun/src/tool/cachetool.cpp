#include <kungfu/wingchun/common.h>
#include <kungfu/wingchun/tool/cachetool.h>
#include <kungfu/yijinjing/journal/assemble.h>
#include <kungfu/yijinjing/journal/bus.h>
#include <kungfu/yijinjing/log.h>

using kungfu::yijinjing::time;
using namespace kungfu::longfist::types;
using namespace kungfu::longfist::enums;
using namespace kungfu::yijinjing::data;
using namespace kungfu::yijinjing::journal;
namespace fs = std::filesystem;

namespace kungfu::wingchun::tool {

int64_t CacheTool::parse_time(const std::string &time_string) {
  int64_t time_stamp = time::strptime(time_string, {KUNGFU_DATETIME_FORMAT, KUNGFU_TRADING_DAY_FORMAT,
                                                    KUNGFU_TIMESTAMP_FORMAT, KUNGFU_HISTORY_DAY_FORMAT});
  if (time_stamp < 0) {
    throw wingchun_error(fmt::format("invalid time format: {}", time_string));
  }
  return time_stamp;
}

CacheTool::CacheTool(longfist::enums::category c, std::string group, std::string name, std::string begin_time,
                     std::string end_time, locator_ptr locator, bool overwrite)
    : category_(c), group_(std::move(group)), name_(std::move(name)), begin_time_(parse_time(begin_time)),
      end_time_(parse_time(end_time)), last_gen_time_(begin_time_), last_read_gen_time_(begin_time_),
      locator_(std::move(locator)) {
  init(overwrite);
}

CacheTool::CacheTool(longfist::enums::category c, std::string group, std::string name, int64_t begin_time,
                     int64_t end_time, locator_ptr locator, bool overwrite)
    : category_(c), group_(std::move(group)), name_(std::move(name)), begin_time_(begin_time), end_time_(end_time),
      last_gen_time_(begin_time), last_read_gen_time_(end_time), locator_(std::move(locator)) {
  init(overwrite);
}

void CacheTool::write_raw_at(int64_t gen_time, int64_t trigger_time, uint32_t dest_id, int32_t msg_type, uintptr_t data,
                             uint32_t length) {
  valid_time(gen_time, trigger_time);
  valid_dest(dest_id, gen_time);
  auto frame = writers_.at(dest_id)->open_frame(trigger_time, msg_type, length);
  memcpy(const_cast<void *>(frame->data_address()), reinterpret_cast<void *>(data), length);
  writers_.at(dest_id)->close_frame(length, gen_time);
}

void CacheTool::write_raw_at_as(int64_t gen_time, int64_t trigger_time, uint32_t source_id, uint32_t dest_id,
                                int32_t msg_type, uintptr_t data, uint32_t length) {
  valid_time(gen_time, trigger_time);
  valid_dest(dest_id, gen_time);
  writers_.at(dest_id)->write_raw_at_as(gen_time, trigger_time, source_id, dest_id, msg_type, data, length);
}

void CacheTool::join(uint32_t dest_id, const int64_t from_time) { reader_->join(cache_location_, dest_id, from_time); }

frame_ptr CacheTool::current_frame() const {
  reader_->sort();
  auto frame = reader_->current_frame();
  if (frame->msg_type() == longfist::types::PageEnd::tag) {
    reader_->next();
    return current_frame();
  }
  last_read_gen_time_ = frame->gen_time();
  return frame;
}

void CacheTool::next() { reader_->next(); }

bool CacheTool::data_available() const { return reader_->data_available(); }

void CacheTool::init(bool overwrite) {
  if (end_time_ < begin_time_ or begin_time_ < 0) {
    throw wingchun_error(fmt::format("invalid time interval: begin_time={} later than end_time={}",
                                     time::strftime(begin_time_), time::strftime(end_time_)));
  }
  uint32_t cache_uid = hash_backtest_cache(name_, begin_time_, end_time_);
  cache_location_ =
      location::make_shared(mode::BACKTEST, category_, group_, fmt::format("{:08x}", cache_uid), locator_);
  publisher_ = std::make_shared<yijinjing::journal::noop_publisher>();
  if (overwrite) {
    std::string cache_dir = locator_->layout_dir(cache_location_, layout::JOURNAL);
    fs::remove_all(cache_dir);
    SPDLOG_INFO("cacheTool ready to write to: {}", cache_location_->uname);
  }
  writers_[location::PUBLIC] = std::make_shared<yijinjing::journal::writer>(
      cache_location_, location::PUBLIC, true, publisher_, false, std::make_shared<yijinjing::journal::bus>(false));
  reader_ = std::make_shared<yijinjing::journal::reader>(true, false, std::make_shared<yijinjing::journal::bus>(false));
  reader_->join(cache_location_, location::PUBLIC, begin_time_);
  KUNGFU_SETUP_LOGGER(cache_location_, cache_location_->name);
}

void CacheTool::valid_time(int64_t gen_time, int64_t trigger_time) {
  if (gen_time < trigger_time or trigger_time < begin_time_ or gen_time > end_time_) {
    throw wingchun_error(fmt::format("invalid time: gen_time={}, trigger_time={}", gen_time, trigger_time));
  }
  if (gen_time < last_gen_time_) {
    throw wingchun_error(fmt::format("invalid time: gen_time={} < last_gen_time_={}", trigger_time, last_gen_time_));
  }
  last_gen_time_ = gen_time;
}

void CacheTool::valid_dest(uint32_t dest_id, int64_t gen_time) {

  if (writers_.find(dest_id) == writers_.end()) {
    writers_[dest_id] = std::make_shared<writer>(cache_location_, dest_id, true, publisher_, false,
                                                 std::make_shared<yijinjing::journal::bus>(false));
    join(dest_id, gen_time);
  }
}
} // namespace kungfu::wingchun::tool