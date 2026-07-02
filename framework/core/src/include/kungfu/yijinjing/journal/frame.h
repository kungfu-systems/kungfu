// SPDX-License-Identifier: Apache-2.0

#ifndef KUNGFU_YIJINJING_FRAME_H
#define KUNGFU_YIJINJING_FRAME_H

// TODO(libyijinjing 1c): drop longfist.h once typed to_string moves out of core;
// only the AllTypes loop below needs the full type registry
#include <kungfu/longfist/longfist.h>
#include <kungfu/yijinjing/journal/common.h>

#include <atomic>
#include <cstddef>

namespace kungfu::yijinjing::journal {
/**
 * Basic memory unit,
 * holds header / data / errorMsg (if needs)
 */
struct frame : event {
  ~frame() override = default;

  // ADR-0001: `length` is the frame publication token. Read it with acquire so
  // that, once a non-zero length is observed, all of the writer's prior stores
  // (payload, gen_time, frame_uid, the zeroed next-frame header) are visible.
  // This replaces the previous `volatile` field, which gave no cross-thread
  // ordering on weak-memory (ARM) targets.
  [[nodiscard]] bool has_data() const { return acquire_length() > 0 && header_->msg_type > 0; }

  [[nodiscard]] uintptr_t address() const { return reinterpret_cast<uintptr_t>(header_); }

  [[nodiscard]] uint32_t frame_length() const { return header_->length; }

  [[nodiscard]] uint32_t header_length() const { return header_->header_length; }

  [[nodiscard]] uint32_t data_length() const override { return frame_length() - header_length(); }

  [[nodiscard]] int64_t gen_time() const override { return header_->gen_time; }

  [[nodiscard]] int64_t trigger_time() const override { return header_->trigger_time; }

  [[nodiscard]] int32_t msg_type() const override { return header_->msg_type; }

  [[nodiscard]] uint32_t source() const override { return header_->source; }

  [[nodiscard]] uint32_t initial_source() const override { return header_->initial_source; }

  [[nodiscard]] uint32_t dest() const override { return header_->dest; }

  [[nodiscard]] const void *data_address() const override {
    return reinterpret_cast<void *>(address() + header_length());
  }

  [[nodiscard]] const char *data_as_bytes() const override {
    return reinterpret_cast<char *>(address() + header_length());
  }

  [[nodiscard]] std::vector<uint8_t> data_as_byte_array() const override {
    return {data_as_bytes(), data_as_bytes() + data_length()};
  }

  [[nodiscard]] std::string data_as_string() const override { return std::string{data_as_bytes(), data_length()}; }

  [[nodiscard]] std::string to_string() const override {
    auto j = header_->to_json();
    if (is_json()) {
      j["data"] = data_as_string();
    } else {
      hana::for_each(longfist::AllTypes, [&](auto pair) {
        using DataType = typename decltype(+hana::second(pair))::type;
        if (DataType::tag == msg_type()) {
          j["data"] = data<DataType>().to_string();
        }
      });
    }
    return j.dump(-1, ' ', false, nlohmann::json::basic_json::error_handler_t::replace);
  }

  [[nodiscard]] int8_t data_type() const override { return int8_t(header_->data_type); }

  [[nodiscard]] bool is_json() const override { return data_type() == longfist::enums::FrameDataType::Json; }

  [[nodiscard]] uint64_t frame_uid() const override { return header_->frame_uid; }

  [[nodiscard]] uint64_t trigger_frame_uid() const override { return header_->trigger_frame_uid; }

  [[nodiscard]] uint64_t stream_id() const override { return header_->stream_id; }

  template <typename T> size_t copy_data(const T &data) {
    size_t length = sizeof(T);
    memcpy(const_cast<void *>(data_address()), &data, length);
    return length;
  }

  void set_address(uintptr_t address) { header_ = reinterpret_cast<longfist::types::frame_header *>(address); }

  void move_to_next() { set_address(address() + frame_length()); }

  void set_header_length() { header_->header_length = sizeof(longfist::types::frame_header); }

  // Non-publishing write of the length field (e.g. to mark a page-end frame as
  // empty with length 0). Does NOT establish release ordering; use
  // publish_data_length() to make a frame visible to readers.
  void set_data_length(uint32_t length) { header_->length = header_length() + length; }

  // ADR-0001: publish the frame with a release store on `length`. Must be the
  // LAST write of the frame; it pairs with acquire_length() on the reader side.
  void publish_data_length(uint32_t length) {
    std::atomic_ref<uint32_t>(header_->length).store(header_length() + length, std::memory_order_release);
  }

  // ADR-0001: acquire-load of the publication token.
  [[nodiscard]] uint32_t acquire_length() const {
    return std::atomic_ref<uint32_t>(header_->length).load(std::memory_order_acquire);
  }

  void set_gen_time(int64_t gen_time) { header_->gen_time = gen_time; }

  void set_trigger_time(int64_t trigger_time) { header_->trigger_time = trigger_time; }

  void set_msg_type(int32_t msg_type) { header_->msg_type = msg_type; }

  void set_data_type(longfist::enums::FrameDataType data_type) { header_->data_type = data_type; }

  void set_source(uint32_t source) { header_->source = source; }

  void set_initial_source(uint32_t initial_source) { header_->initial_source = initial_source; }

  void set_dest(uint32_t dest) { header_->dest = dest; }

  void set_frame_uid(uint64_t frame_uid) { header_->frame_uid = frame_uid; }

  void set_trigger_frame_uid(uint64_t trigger_frame_uid) { header_->trigger_frame_uid = trigger_frame_uid; }

  void set_stream_id(uint64_t stream_id) { header_->stream_id = stream_id; }

  // ADR-0001: copy the header + payload but leave the `length` publication token
  // unwritten (it stays 0 from the prior next-header memset). The caller must
  // publish it last via publish_data_length() so a polling reader never observes
  // the token ahead of the copied payload. Relies on `length` being the first
  // field of frame_header (offset 0).
  void copy(const frame &source) {
    static_assert(offsetof(longfist::types::frame_header, length) == 0,
                  "length must be frame_header's first field for publish-safe copy");
    auto total = source.frame_length();
    memcpy(reinterpret_cast<char *>(header_) + sizeof(uint32_t),
           reinterpret_cast<const char *>(source.header_) + sizeof(uint32_t), total - sizeof(uint32_t));
  }

  frame() = default;

protected:
  longfist::types::frame_header *header_ = nullptr;

  friend struct cloned_frame;

  friend class journal;

  friend class writer;

  friend class replay_writer;
};

struct cloned_frame : frame {
  cloned_frame() : frame() {}

  ~cloned_frame() override { free(header_); };

  void copy(frame &from) {
    header_ = reinterpret_cast<longfist::types::frame_header *>(malloc(from.frame_length()));
    memset(header_, 0, from.frame_length());
    memcpy(header_, from.header_, from.frame_length());
  }

  void open(uint32_t data_length) {
    auto frame_length = sizeof(longfist::types::frame_header) + data_length;
    header_ = reinterpret_cast<longfist::types::frame_header *>(malloc(frame_length));
    memset(header_, 0, frame_length);
  }
};

} // namespace kungfu::yijinjing::journal
#endif // KUNGFU_YIJINJING_FRAME_H
