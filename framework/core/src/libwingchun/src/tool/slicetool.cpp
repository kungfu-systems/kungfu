#include <cstddef>
#include <cstdint>
#include <kungfu/wingchun/common.h>
#include <kungfu/wingchun/tool/slicetool.h>
#include <kungfu/yijinjing/journal/assemble.h>
#include <kungfu/yijinjing/journal/bus.h>
#include <kungfu/yijinjing/log.h>

using kungfu::yijinjing::time;
using namespace kungfu::longfist::types;
using namespace kungfu::longfist::enums;
// using namespace kungfu::yijinjing::data;
using kungfu::yijinjing::data::location_ptr;
using namespace kungfu::yijinjing::journal;
namespace fs = std::filesystem;

namespace kungfu::wingchun::tool {
SliceTool::SliceTool(longfist::enums::category c, std::string group, std::string name, SliceIndexer_ptr indexer,
                     bool overwrite, std::string arguments, size_t size)
    : category_(c), group_(std::move(group)), name_(std::move(name)), indexer_(std::move(indexer)),
      overwrite_(overwrite), last_gen_time_(indexer_->get_begin_time()), arguments_(std::move(arguments)),
      reader_(std::make_shared<reader>(true, false, std::make_shared<bus>(false))), size_(size) {
  KUNGFU_SETUP_LOGGER(yijinjing::data::location::make_shared(mode::DATA, category::SYSTEM, group, name,
                                                             std::make_shared<yijinjing::data::locator>()),
                      name);
  if (indexer_->get_end_time() < indexer_->get_begin_time() or indexer_->get_begin_time() < 0) {
    throw wingchun_error(fmt::format("invalid time interval: begin_time={} later than end_time={}",
                                     time::strftime(indexer_->get_begin_time()),
                                     time::strftime(indexer_->get_end_time())));
  }
}

SliceTool::~SliceTool() {
  SPDLOG_DEBUG("SliceTool {} is destroyed", name_);
  for (auto it = lease_locations_.begin(); it != lease_locations_.end();) {
    for (const auto &expired_location : it->second) {
      SPDLOG_TRACE("sliced location expired, locator={}, location={} disjoining.",
                   expired_location->locator->get_root(), expired_location->uname);
      for (auto dest_id : expired_location->locator->list_location_dest(expired_location)) {
        reader_->disjoin_channel(expired_location, dest_id);
      }
      writer_maps_.erase(*expired_location);
      indexer_->sync_save_location(expired_location);
    }
    it = lease_locations_.erase(it);
  }
}

location_ptr SliceTool::find_md_slice_location(int64_t nano_time, const std::string &instrument_id,
                                               const std::string &exchange_id, int32_t data_type) const {
  return indexer_->find_md_slice_location(nano_time, group_, name_, instrument_id, exchange_id, data_type);
}

location_ptr SliceTool::find_operator_slice_location(int64_t nano_time) const {
  return indexer_->find_operator_slice_location(nano_time, group_, name_);
}

int64_t SliceTool::get_md_slice_end_time(int64_t nano_time, const std::string &instrument_id,
                                         const std::string &exchange_id, int32_t data_type) const {
  return indexer_->get_md_slice_end_time(nano_time, group_, name_, instrument_id, exchange_id, data_type);
}

int64_t SliceTool::get_operator_slice_end_time(int64_t nano_time) const {
  return indexer_->get_operator_slice_end_time(nano_time, group_, name_);
}

void SliceTool::write_raw_at(location_ptr slice_location, int64_t gen_time, int64_t trigger_time, uint32_t dest_id,
                             int32_t msg_type, uintptr_t data, uint32_t length) {
  valid_time(gen_time, trigger_time);
  auto writer = get_writer(slice_location, dest_id);
  auto frame = writer->open_frame(trigger_time, msg_type, length);
  memcpy(const_cast<void *>(frame->data_address()), reinterpret_cast<void *>(data), length);
  writer->close_frame(length, gen_time);
}

void SliceTool::write_raw_at_as(location_ptr slice_location, int64_t gen_time, int64_t trigger_time, uint32_t source_id,
                                uint32_t dest_id, int32_t msg_type, uintptr_t data, uint32_t length) {
  valid_time(gen_time, trigger_time);
  auto writer = get_writer(slice_location, dest_id);
  writer->write_raw_at_as(gen_time, trigger_time, source_id, dest_id, msg_type, data, length);
}

void SliceTool::join(const yijinjing::data::location_ptr &location, uint32_t dest_id, const int64_t from_time) {
  reader_->join(location, dest_id, from_time);
}

frame_ptr SliceTool::current_frame() const {
  reader_->sort();
  auto frame = reader_->current_frame();
  if (frame->msg_type() == longfist::types::PageEnd::tag) {
    reader_->next();
    return current_frame();
  }
  return frame;
}

void SliceTool::next() {
  const auto &frame = current_frame();
  int64_t now_time = frame->gen_time();
  for (auto it = lease_locations_.begin(); it != lease_locations_.end();) {
    if (it->first < now_time) {
      for (const auto &expired_location : it->second) {
        SPDLOG_TRACE("sliced location expired, locator={}, location={} disjoining.",
                     expired_location->locator->get_root(), expired_location->uname);
        for (auto dest_id : expired_location->locator->list_location_dest(expired_location)) {
          reader_->disjoin_channel(expired_location, dest_id);
        }
        writer_maps_.erase(*expired_location);
        indexer_->sync_save_location(expired_location);
      }
      it = lease_locations_.erase(it);
    } else {
      break;
    }
  }
  reader_->next();
}

bool SliceTool::data_available() const { return reader_->data_available(); }

writer_ptr SliceTool::get_writer(const yijinjing::data::location_ptr &location, uint32_t dest_id, int64_t end_time) {
  if (writer_maps_.find(*location) == writer_maps_.end()) {
    if (overwrite_) {
      std::string slice_dir = location->locator->layout_dir(location, layout::JOURNAL);
      fs::remove_all(slice_dir);
      SPDLOG_INFO("SliceTool ready to write to location={} in locator={}", location->uname,
                  location->locator->get_root());
    }
    lease_locations_[end_time].push_back(location);
  }

  auto &writer_map = writer_maps_[*location];
  if (writer_map.find(dest_id) == writer_map.end()) {
    writer_map[dest_id] =
        std::make_shared<yijinjing::journal::writer>(location, dest_id, true, std::make_shared<noop_publisher>(), false,
                                                     std::make_shared<yijinjing::journal::bus>(false), size_);
    join(location, dest_id, indexer_->get_begin_time());
  }
  return writer_map[dest_id];
}

void SliceTool::valid_time(int64_t gen_time, int64_t trigger_time) const {
  if (gen_time < trigger_time or trigger_time < indexer_->get_begin_time() or gen_time > indexer_->get_end_time()) {
    throw wingchun_error(fmt::format("invalid time: gen_time={}, trigger_time={}", gen_time, trigger_time));
  }
  if (gen_time < last_gen_time_) {
    throw wingchun_error(fmt::format("invalid time: gen_time={} < last_gen_time_={}", trigger_time, last_gen_time_));
  }
  last_gen_time_ = gen_time;
}

} // namespace kungfu::wingchun::tool