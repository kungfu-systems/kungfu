#ifndef KUNGFU_TOOL_CACHE_WRITER_H
#define KUNGFU_TOOL_CACHE_WRITER_H

#include <kungfu/common.h>
#include <kungfu/longfist/longfist.h>
#include <kungfu/wingchun/tool/sliceindexer.h>
#include <kungfu/yijinjing/common.h>
#include <kungfu/yijinjing/journal/journal.h>

#include <utility>

namespace kungfu::wingchun::tool {

class CacheTool {
  static int64_t parse_time(const std::string &time);

public:
  CacheTool(longfist::enums::category category, std::string group, std::string name, std::string begin_time,
            std::string end_time, yijinjing::data::locator_ptr locator, bool overwrite = true);
  CacheTool(longfist::enums::category category, std::string group, std::string name, int64_t begin_time,
            int64_t end_time, yijinjing::data::locator_ptr locator, bool overwrite = true);

  virtual ~CacheTool() = default;

  int64_t get_begin_time() const { return begin_time_; }

  int64_t get_end_time() const { return end_time_; }

  yijinjing::data::location_ptr get_location() const { return cache_location_; }

  virtual void run() {};

  template <typename T> void write_at(int64_t gen_time, int64_t trigger_time, uint32_t dest_id, const T &data) {
    valid_time(gen_time, trigger_time);
    valid_dest(dest_id, gen_time);

    writers_.at(dest_id)->write_at(gen_time, trigger_time, data);
  }

protected:
  void write_raw_at(int64_t gen_time, int64_t trigger_time, uint32_t dest_id, int32_t msg_type, uintptr_t data,
                    uint32_t length);

  void write_raw_at_as(int64_t gen_time, int64_t trigger_time, uint32_t source, uint32_t dest_id, int32_t msg_type,
                       uintptr_t data, uint32_t length);

  void next();

  bool data_available() const;

  int64_t get_last_read_gen_time() const { return last_read_gen_time_; }

  void join(uint32_t dest_id, int64_t from_time);

  yijinjing::journal::frame_ptr current_frame() const;

  longfist::enums::category category_;
  std::string group_;
  std::string name_;
  yijinjing::data::locator_ptr locator_;
  yijinjing::data::location_ptr cache_location_;
  yijinjing::publisher_ptr publisher_;
  std::unordered_map<uint32_t, yijinjing::journal::writer_ptr> writers_ = {};
  yijinjing::journal::reader_ptr reader_;
  int64_t begin_time_;
  int64_t end_time_;
  int64_t last_gen_time_;
  mutable int64_t last_read_gen_time_;

  void init(bool overwrite);

  void valid_time(int64_t gen_time, int64_t trigger_time);

  void valid_dest(uint32_t dest_id, int64_t gen_time);
};

class CacheToolWriter : public CacheTool {
public:
  CacheToolWriter(longfist::enums::category category, std::string group, std::string name, std::string begin_time,
                  std::string end_time, yijinjing::data::locator_ptr locator)
      : CacheTool(category, std::move(group), std::move(name), std::move(begin_time), std::move(end_time),
                  std::move(locator), true) {}

  CacheToolWriter(longfist::enums::category category, std::string group, std::string name, int64_t begin_time,
                  int64_t end_time, yijinjing::data::locator_ptr locator)
      : CacheTool(category, std::move(group), std::move(name), begin_time, end_time, std::move(locator), true) {}

  void write_raw(int64_t time_stamp, int32_t msg_type, uint32_t dest_id, uintptr_t data, uint32_t length) {
    write_raw_at(time_stamp, time_stamp, dest_id, msg_type, data, length);
  }
};

class CacheToolReader : public CacheTool {
public:
  CacheToolReader(longfist::enums::category category, std::string group, std::string name, std::string begin_time,
                  std::string end_time, yijinjing::data::locator_ptr locator)
      : CacheTool(category, std::move(group), std::move(name), std::move(begin_time), std::move(end_time),
                  std::move(locator), false) {}

  CacheToolReader(longfist::enums::category category, std::string group, std::string name, int64_t begin_time,
                  int64_t end_time, yijinjing::data::locator_ptr locator)
      : CacheTool(category, std::move(group), std::move(name), begin_time, end_time, std::move(locator), false) {}

  yijinjing::journal::frame_ptr current_frame() const { return CacheTool::current_frame(); }

  void next() { return CacheTool::next(); }

  bool data_available() const { return CacheTool::data_available(); }

  void join(uint32_t dest_id) { return CacheTool::join(dest_id, get_last_read_gen_time()); }
};

} // namespace kungfu::wingchun::tool

#endif // KUNGFU_TOOL_CACHE_WRITER_H