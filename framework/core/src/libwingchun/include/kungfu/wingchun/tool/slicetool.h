
#ifndef KUNGFU_TOOL_SLICE_TOOL_H
#define KUNGFU_TOOL_SLICE_TOOL_H

#include <cstddef>
#include <kungfu/common.h>
#include <kungfu/longfist/longfist.h>
#include <kungfu/wingchun/tool/sliceindexer.h>
#include <kungfu/yijinjing/common.h>
#include <kungfu/yijinjing/journal/journal.h>
#include <kungfu/yijinjing/practice/hero.h>
#include <unordered_map>

namespace kungfu::wingchun::tool {

class SliceTool {

public:
  SliceTool(longfist::enums::category category, std::string group, std::string name, SliceIndexer_ptr indexer,
            bool overwrite = true, std::string arguments = "{}", std::size_t size = 128);

  virtual ~SliceTool();

  int64_t get_begin_time() const { return indexer_->get_begin_time(); }

  int64_t get_end_time() const { return indexer_->get_end_time(); }

  std::string get_arguments() const { return arguments_; }

  virtual void run() {};

  template <typename DataType, std::enable_if_t<longfist::is_market_data<DataType>()>...>
  void write_at(int64_t gen_time, int64_t trigger_time, uint32_t dest_id, const DataType &data) {
    valid_time(gen_time, trigger_time);
    auto md_location = find_md_slice_location(gen_time, data.instrument_id, data.exchange_id, DataType::tag);
    auto end_time = get_md_slice_end_time(gen_time, data.instrument_id, data.exchange_id, DataType::tag);
    auto writer = get_writer(md_location, dest_id, end_time);
    writer->write_at(gen_time, trigger_time, data);
  }

  template <typename DataType, std::enable_if_t<std::is_same_v<DataType, longfist::types::SyntheticData>>...>
  void write_at(int64_t gen_time, int64_t trigger_time, uint32_t dest_id, const DataType &data) {
    valid_time(gen_time, trigger_time);
    auto op_location = find_operator_slice_location(gen_time);
    auto end_time = get_operator_slice_end_time(gen_time);
    auto writer = get_writer(op_location, dest_id, end_time);
    writer->write_at(gen_time, trigger_time, data);
  }

  yijinjing::data::location_ptr find_md_slice_location(int64_t nano_time, const std::string &instrument_id,
                                                       const std::string &exchange_id, int32_t data_type) const;

  yijinjing::data::location_ptr find_operator_slice_location(int64_t nano_time) const;

  int64_t get_md_slice_end_time(int64_t nano_time, const std::string &instrument_id, const std::string &exchange_id,
                                int32_t data_type) const;

  int64_t get_operator_slice_end_time(int64_t nano_time) const;

  void next();

  bool data_available() const;

  void join(const yijinjing::data::location_ptr &location, uint32_t dest_id, const int64_t from_time);

  yijinjing::journal::frame_ptr current_frame() const;

  yijinjing::journal::writer_ptr get_writer(const yijinjing::data::location_ptr &location, uint32_t dest_id,
                                            int64_t end_time = INT64_MAX);

protected:
  void write_raw_at(yijinjing::data::location_ptr location, int64_t gen_time, int64_t trigger_time, uint32_t dest_id,
                    int32_t msg_type, uintptr_t data, uint32_t length);

  void write_raw_at_as(yijinjing::data::location_ptr location, int64_t gen_time, int64_t trigger_time, uint32_t source,
                       uint32_t dest_id, int32_t msg_type, uintptr_t data, uint32_t length);

  longfist::enums::category category_;
  std::string group_;
  std::string name_;
  SliceIndexer_ptr indexer_;
  bool overwrite_;
  std::unordered_map<yijinjing::data::location, practice::WriterMap> writer_maps_;
  std::map<int64_t, std::vector<yijinjing::data::location_ptr>> lease_locations_{};
  yijinjing::journal::reader_ptr reader_;
  mutable int64_t last_gen_time_;
  const std::string arguments_;
  std::size_t size_;

  void valid_time(int64_t gen_time, int64_t trigger_time) const;
};

DECLARE_PTR(SliceTool);

} // namespace kungfu::wingchun::tool

#endif // KUNGFU_TOOL_SLICE_TOOL_H