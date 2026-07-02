// SPDX-License-Identifier: Apache-2.0

//
// Created by Keren Dong on 2020/5/22.
//

#ifndef YIJINJING_ASSEMBLE_H
#define YIJINJING_ASSEMBLE_H

#include <kungfu/yijinjing/journal/journal.h>

namespace kungfu::yijinjing::journal {

struct assemble_exception : std::runtime_error {
  explicit assemble_exception(const std::string &msg) : std::runtime_error(msg) { SPDLOG_CRITICAL(msg); }
};

class sink {
public:
  sink();
  virtual ~sink() = default;
  virtual void put(const data::location_ptr &location, uint32_t dest_id, const frame_ptr &frame) = 0;
  virtual void close(){};
  uint64_t find_page_size(const data::location_ptr &location, uint32_t dest_id);

  [[nodiscard]] publisher_ptr get_publisher();
  [[nodiscard]] bus_ptr get_bus();

private:
  publisher_ptr publisher_;
  bus_ptr bus_;
};
DECLARE_PTR(sink)

class null_sink : public sink {
public:
  null_sink() = default;
  void put(const data::location_ptr &location, uint32_t dest_id, const frame_ptr &frame) override{};
};

class copy_sink : public sink {
public:
  explicit copy_sink(data::locator_ptr locator);
  void put(const data::location_ptr &location, uint32_t dest_id, const frame_ptr &frame) override;

private:
  data::locator_ptr locator_;
  std::unordered_map<uint32_t, std::unordered_map<uint32_t, writer_ptr>> writers_ = {};
};

class assemble {
public:
  explicit assemble(const std::vector<data::locator_ptr> &locators, const std::string &mode = "*",
                    const std::string &category = "*", const std::string &group = "*", const std::string &name = "*");

  explicit assemble(const data::locator_ptr &locator, const std::string &mode = "*", const std::string &category = "*",
                    const std::string &group = "*", const std::string &name = "*");

  explicit assemble(const data::location_ptr &source_location, uint32_t dest_id,
                    uint32_t assemble_mode = longfist::enums::AssembleMode::Channel, int64_t from_time = 0);

  virtual ~assemble() = default;

  assemble operator+(assemble &other);

  assemble &operator+=(const assemble &other);

  assemble &operator-=(const assemble &other);

  void operator>>(const sink_ptr &sink);

  bool data_available();

  void next();

  frame_ptr current_frame();

  page_ptr current_page();

  template <typename T> std::vector<T> read_all(int32_t msg_type = T::tag, int64_t end_time = INT64_MAX) {
    std::vector<T> v{};
    while (data_available() and current_frame()->gen_time() < end_time) {
      if (current_frame()->msg_type() == msg_type) {
        v.push_back(current_frame()->template data<T>());
      }
      next();
    }
    return v;
  }

  template <typename T> std::vector<T> read_all(const T &, int64_t end_time = INT64_MAX) {
    return read_all<T>(T::tag, end_time);
  }

  template <typename T>
  std::vector<std::pair<longfist::types::frame_header, T>> read_header_data(int32_t msg_type = T::tag,
                                                                            int64_t end_time = INT64_MAX) {
    std::vector<std::pair<longfist::types::frame_header, T>> v{};
    while (data_available() and current_frame()->gen_time() < end_time) {
      if (current_frame()->msg_type() == msg_type) {
        v.emplace_back(*reinterpret_cast<longfist::types::frame_header *>(current_frame()->address()),
                       current_frame()->template data<T>());
      }
      next();
    }
    return v;
  }

  template <typename T>
  std::vector<std::pair<longfist::types::frame_header, T>> read_header_data(const T &, int64_t end_time = INT64_MAX) {
    return read_header_data<T>(T::tag, end_time);
  }

  std::vector<std::pair<longfist::types::frame_header, std::vector<uint8_t>>> read_bytes(int32_t msg_type,
                                                                                         int64_t end_time = INT64_MAX);

  template <typename T>
  std::vector<std::pair<longfist::types::frame_header, std::vector<uint8_t>>> read_bytes(const T & = {},
                                                                                         int64_t end_time = INT64_MAX) {
    return read_bytes(T::tag, end_time);
  }

  std::vector<longfist::types::frame_header> read_headers(int32_t msg_type, int64_t end_time = INT64_MAX);

  template <typename T>
  std::vector<longfist::types::frame_header> read_headers(const T & = {}, int64_t end_time = INT64_MAX) {
    return read_headers(T::tag, end_time);
  }

  void seek_to_time(int64_t nano_time);

  void move_to_time(int64_t nano_time);

  [[nodiscard]] const std::vector<reader_ptr> &get_readers() const { return readers_; }

  void disjoin(const yijinjing::data::location_ptr &location);

  void disjoin_channel(const yijinjing::data::location_ptr &location, uint32_t dest_id);

protected:
  std::vector<reader_ptr> readers_ = {};
  reader_ptr current_reader_ = {};

private:
  const std::string mode_;
  const std::string category_;
  const std::string group_;
  const std::string name_;
  publisher_ptr publisher_;
  std::vector<data::locator_ptr> locators_ = {};
  int64_t from_time_ = 0;

  void sort();
};
DECLARE_PTR(assemble)
} // namespace kungfu::yijinjing::journal
#endif // YIJINJING_ASSEMBLE_H
