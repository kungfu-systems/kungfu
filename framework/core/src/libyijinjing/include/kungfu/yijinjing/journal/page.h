// SPDX-License-Identifier: Apache-2.0

#ifndef YIJINJING_PAGE_H
#define YIJINJING_PAGE_H

#include <kungfu/longfist/core.h>
#include <kungfu/yijinjing/journal/common.h>
#include <kungfu/yijinjing/journal/frame.h>

namespace kungfu::yijinjing::journal {

class page {

public:
  virtual ~page();

  void flush();

  [[nodiscard]] uint32_t get_version() const { return header_->version; }

  [[nodiscard]] uint64_t get_page_size() const { return header_->page_size; }

  [[nodiscard]] data::location_ptr get_location() const { return location_; }

  [[nodiscard]] uint32_t get_dest_id() const { return dest_id_; }

  [[nodiscard]] uint32_t get_page_id() const { return page_id_; }

  [[nodiscard]] int64_t begin_time() const {
    return reinterpret_cast<longfist::types::frame_header *>(first_frame_address())->gen_time;
  }

  [[nodiscard]] int64_t end_time() const {
    return reinterpret_cast<longfist::types::frame_header *>(last_frame_address())->gen_time;
  }

  [[nodiscard]] uintptr_t address() const { return reinterpret_cast<uintptr_t>(header_); }

  [[nodiscard]] uintptr_t address_border() const {
    return address() + header_->page_size - sizeof(longfist::types::frame_header);
  }

  [[nodiscard]] uint64_t get_body_size() const { return size_ - header_->page_header_length; }

  [[nodiscard]] uintptr_t first_frame_address() const { return address() + header_->page_header_length; }

  [[nodiscard]] uintptr_t last_frame_address() const { return address() + header_->last_frame_position; }

  [[nodiscard]] bool is_full() const {
    return last_frame_address() + reinterpret_cast<longfist::types::frame_header *>(last_frame_address())->length >
           address_border();
  }

  [[nodiscard]] bool is_pre_open() const { return header_->status == longfist::enums::PageStatus::PreOpen; };

  /**
   * update page header when new frame added
   */
  void set_last_frame_position(uint64_t position);

  void enable_page();

  static page_ptr load(const data::location_ptr &location, uint32_t dest_id, uint64_t page_size, uint32_t page_id,
                       bool is_writing, bool lazy, bool pre_open = false);

  static page_ptr load_header_and_1st_frame_header(const data::location_ptr &location, uint32_t dest_id,
                                                   uint32_t page_id, bool is_writing, bool lazy);

  static std::string get_page_path(const data::location_ptr &location, uint32_t dest_id, uint32_t page_id);

  static uint32_t find_page_id(const data::location_ptr &location, uint32_t dest_id, int64_t time);

  static uint64_t find_page_size(const data::location_ptr &location, uint32_t dest_id, uint64_t page_size = 0);

  static bool check_page_existed(const data::location_ptr &location, uint32_t dest_id);

  static bool check_page_existed(const data::location_ptr &location, uint32_t dest_id, uint32_t page_id);

protected:
  const data::location_ptr location_;
  const uint32_t dest_id_;
  const uint32_t page_id_;
  const bool lazy_;
  const bool is_writing_;
  const size_t size_;
  const longfist::types::page_header *header_;

  page(data::location_ptr location, uint32_t dest_id, uint32_t page_id, size_t size, bool lazy, bool is_writing,
       uintptr_t address);

  friend class journal;

  friend class writer;

  friend class reader;
};

} // namespace kungfu::yijinjing::journal

#endif // YIJINJING_PAGE_H
