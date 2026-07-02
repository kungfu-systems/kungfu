#ifndef KUNGFU_TOOL_SLICE_INDEXER_H
#define KUNGFU_TOOL_SLICE_INDEXER_H
#include <kungfu/common.h>
#include <kungfu/longfist/types.h>
#include <kungfu/yijinjing/common.h>

namespace kungfu::wingchun::tool {
class SliceIndexer {
public:
  SliceIndexer(int64_t begin_time, int64_t end_time) : begin_time_(begin_time), end_time_(end_time) {}
  virtual ~SliceIndexer() = default;

  int64_t get_begin_time() const { return begin_time_; }

  int64_t get_end_time() const { return end_time_; }

  virtual yijinjing::data::location_ptr find_md_slice_location(int64_t nano_time, const std::string &group,
                                                               const std::string &name,
                                                               const std::string &instrument_id,
                                                               const std::string &exchange_id, int32_t data_type) const;

  virtual int64_t get_md_slice_end_time(int64_t nano_time, const std::string &group, const std::string &name,
                                        const std::string &instrument_id, const std::string &exchange_id,
                                        int32_t data_type) const;

  virtual yijinjing::data::location_ptr find_operator_slice_location(int64_t nano_time, const std::string &group,
                                                                     const std::string &name) const;

  virtual int64_t get_operator_slice_end_time(int64_t nano_time, const std::string &group,
                                              const std::string &name) const;

  virtual void submit_acquire_location(const yijinjing::data::location_ptr &location) {}

  virtual void submit_release_location(const yijinjing::data::location_ptr &location) {}

  virtual void wait_acquire_location(const yijinjing::data::location_ptr &location) {}

  virtual void wait_release_location(const yijinjing::data::location_ptr &location) {}

  virtual int acquire_lead_ratio() const;

  virtual int release_delay_ratio() const;

  virtual void sync_save_location(const yijinjing::data::location_ptr &location) {}

private:
  int64_t begin_time_;
  int64_t end_time_;
};

DECLARE_PTR(SliceIndexer);

class DayIndexer : public SliceIndexer {
public:
  DayIndexer(int64_t begin_time, int64_t end_time) : SliceIndexer(begin_time, end_time) {}
  virtual yijinjing::data::location_ptr find_md_slice_location(int64_t nano_time, const std::string &group,
                                                               const std::string &name,
                                                               const std::string &instrument_id,
                                                               const std::string &exchange_id,
                                                               int32_t data_type) const override;

  virtual int64_t get_md_slice_end_time(int64_t nano_time, const std::string &group, const std::string &name,
                                        const std::string &instrument_id, const std::string &exchange_id,
                                        int32_t data_type) const override;
  // virtual std::vector<InstrumentKey> get_all_instrument_key() const override;

  virtual yijinjing::data::location_ptr find_operator_slice_location(int64_t nano_time, const std::string &group,
                                                                     const std::string &name) const override;

  virtual int64_t get_operator_slice_end_time(int64_t nano_time, const std::string &group,
                                              const std::string &name) const override;
  int64_t end_of_day(int64_t nano_time) const;
};
} // namespace kungfu::wingchun::tool

#endif //  KUNGFU_TOOL_SLICE_INDEXER_H
