// SPDX-License-Identifier: Apache-2.0

#ifndef YIJINJING_PAGE_H
#define YIJINJING_PAGE_H

#include <kungfu/yijinjing/journal/common.h>
#include <kungfu/yijinjing/journal/frame.h>
#include <kungfu/yijinjing/platform/mmap.h>
#include <kungfu/yijinjing/schema/core.h>

#include <atomic>

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
    return reinterpret_cast<yijinjing::types::frame_header *>(first_frame_address())->gen_time;
  }

  [[nodiscard]] int64_t end_time() const;

  [[nodiscard]] uintptr_t address() const { return region_.address(); }

  [[nodiscard]] uintptr_t address_border() const;

  [[nodiscard]] uint64_t get_body_size() const;

  [[nodiscard]] uintptr_t first_frame_address() const;

  [[nodiscard]] uintptr_t last_frame_address() const;

  [[nodiscard]] bool is_full() const {
    return last_frame_address() + reinterpret_cast<yijinjing::types::frame_header *>(last_frame_address())->length >
           address_border();
  }

  [[nodiscard]] bool is_pre_open() const { return acquire_status() == yijinjing::enums::PageStatus::PreOpen; };

  /**
   * update page header when new frame added
   */
  void set_last_frame_position(uint64_t position);

  void enable_page();

  static page_ptr load(const data::location_ptr &location, uint32_t dest_id, uint64_t page_size, uint32_t page_id,
                       bool is_writing, bool lazy, bool pre_open = false, bool allow_create = false);

  static page_ptr load_header_and_1st_frame_header(const data::location_ptr &location, uint32_t dest_id,
                                                   uint32_t page_id, bool is_writing, bool lazy);

  static std::string get_page_path(const data::location_ptr &location, uint32_t dest_id, uint32_t page_id);

  static uint32_t find_page_id(const data::location_ptr &location, uint32_t dest_id, int64_t time);

  static uint64_t find_page_size(const data::location_ptr &location, uint32_t dest_id, uint64_t page_size = 0);

  static bool check_page_existed(const data::location_ptr &location, uint32_t dest_id);

  static bool check_page_existed(const data::location_ptr &location, uint32_t dest_id, uint32_t page_id);

protected:
  platform::mapped_region region_;
  const data::location_ptr location_;
  const uint32_t dest_id_;
  const uint32_t page_id_;
  const bool is_writing_;
  const size_t size_;
  const yijinjing::types::page_header *header_;

  page(data::location_ptr location, uint32_t dest_id, uint32_t page_id, size_t size, bool lazy, bool is_writing,
       platform::mapped_region region);

  [[nodiscard]] uint64_t acquire_last_frame_position() const;
  [[nodiscard]] yijinjing::enums::PageStatus acquire_status() const;
  void publish_status(yijinjing::enums::PageStatus status);
  static std::string resolve_page_path(const data::location_ptr &location, uint32_t dest_id, uint32_t page_id,
                                       bool create_not_exist);

  friend class journal;

  friend class writer;

  friend class reader;
};

} // namespace kungfu::yijinjing::journal

#endif // YIJINJING_PAGE_H
