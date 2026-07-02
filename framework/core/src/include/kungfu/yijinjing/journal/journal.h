// SPDX-License-Identifier: Apache-2.0

#ifndef YIJINJING_JOURNAL_H
#define YIJINJING_JOURNAL_H

#include <kungfu/common.h>
#include <kungfu/longfist/longfist.h>
#include <kungfu/yijinjing/journal/bus.h>
#include <kungfu/yijinjing/journal/common.h>
#include <kungfu/yijinjing/journal/frame.h>
#include <kungfu/yijinjing/journal/page.h>
#include <kungfu/yijinjing/time.h>
#include <mutex>

namespace kungfu::yijinjing::journal {

struct noop_publisher : public publisher {
  noop_publisher() = default;
  bool is_usable() override { return true; }
  bool setup() override { return true; }
  int notify() override { return 0; }
  int publish(const std::string &json_message, int flags = PUBLISH_NONBLOCK, bool no_exception = false) override {
    return 0;
  };
};

/**
 * Journal class, the abstraction of continuous memory access
 */
struct journal_key {
  journal_key(uint32_t locator_uid, uint32_t location_uid, uint32_t dest_id)
      : locator_uid(locator_uid), location_uid(location_uid), dest_id(dest_id) {}

  journal_key(const data::location_ptr &location, uint32_t dest_id)
      : locator_uid(location->locator->locator_uid), location_uid(location->uid), dest_id(dest_id) {}

  bool operator<(const journal_key &rhs) const {
    return std::tie(locator_uid, location_uid, dest_id) < std::tie(rhs.locator_uid, rhs.location_uid, rhs.dest_id);
  }

  uint32_t locator_uid;
  uint32_t location_uid;
  uint32_t dest_id;
};

typedef std::map<journal_key, journal_ptr> JournalMap;
class journal {
public:
  explicit journal(data::location_ptr location, uint32_t dest_id, bool is_writing, bool lazy, bool low_latency,
                   bus_ptr bus, uint64_t page_size,
                   longfist::enums::Priority priority = longfist::enums::Priority::Medium);

  journal(const journal &other);

  virtual ~journal();

  [[nodiscard]] frame_ptr &current_frame() { return frame_; }

  [[nodiscard]] uint64_t current_frame_id() const { return page_frame_nb_; }

  [[nodiscard]] page_ptr &current_page() { return page_; }

  [[nodiscard]] uint32_t current_page_id() { return page_->get_page_id(); }

  [[nodiscard]] const data::location_ptr &get_location() const { return location_; }

  [[nodiscard]] uint32_t get_source() const { return location_->location_uid; }

  [[nodiscard]] uint32_t get_dest() const { return dest_id_; }

  /**
   * move current frame to the next available one
   */
  virtual void next();

  /**
   * makes sure after this call, next time user calls current_frame() gets the right available frame
   * (gen_time() > nanotime or writable)
   * @param nanotime
   */
  virtual void seek_to_time(int64_t nanotime);

  virtual void release_page();

  const bus_ptr &get_bus() { return bus_; }

  const page_ptr &get_page() { return page_; }

protected:
  const data::location_ptr location_;
  const uint64_t page_size_;
  const uint32_t dest_id_;
  const bool is_writing_;
  const bool lazy_;
  const bool low_latency_;
  const longfist::enums::Priority priority_;
  bus_ptr bus_ = {};
  page_ptr pre_create_page_ = {};
  page_ptr page_ = {};
  page_ptr preload_page_ = {};
  std::recursive_mutex load_page_mtx_ = {};
  std::vector<page_ptr> passed_page_collector_ = {};
  std::recursive_mutex passed_page_collector_mtx_ = {};
  frame_ptr frame_ = {};
  uint64_t page_frame_nb_ = 0;
  bool replica_ = false;
  bool keep_page_ = false;
  uint32_t max_pre_create_size_ = 0;

  virtual void load_page(uint32_t page_id);

  virtual void close_page(int64_t trigger_time, int64_t last_gen_time);

  /** load next page, current page will be released if not empty */
  virtual void load_next_page();

  virtual void preload_next_page();

  virtual void try_load_next_extra_page();

  friend class reader;

  friend class writer;

  friend class replay_writer;
};

class reader {
public:
  explicit reader(bool lazy, bool low_latency, bus_ptr bus)
      : lazy_(lazy), low_latency_(low_latency), bus_(std::move(bus)), current_(nullptr) {}

  reader(const reader &other);

  virtual ~reader();

  /**
   * join journal at given data location
   * @param location where the journal locates
   * @param dest_id journal dest id
   * @param from_time subscribe events after this time, 0 means from start
   */
  virtual void join(const data::location_ptr &location, uint32_t dest_id, int64_t from_time, uint64_t page_size = 0,
                    longfist::enums::Priority priority = longfist::enums::Priority::Medium);

  virtual void disjoin(const data::location_ptr &location);

  virtual void disjoin_channel(const data::location_ptr &location, uint32_t dest_id);

  [[nodiscard]] frame_ptr current_frame() const { return current_->current_frame(); }

  [[nodiscard]] uint64_t current_frame_id() const { return current_->current_frame_id(); }

  [[nodiscard]] page_ptr current_page() const { return current_->current_page(); }

  [[nodiscard]] uint32_t current_page_id() const { return current_->current_page_id(); }

  [[nodiscard]] const JournalMap &get_journals() const { return journals_; }

  [[nodiscard]] journal_ptr get_current_journal() const { return current_; }

  [[nodiscard]] journal_ptr get_journal(const data::location_ptr &location, uint32_t dest_id);

  virtual bool data_available();

  /** seek journal to time */
  virtual void seek_to_time(int64_t nanotime);

  /** seek next frame */
  virtual void next();

  virtual void sort();

  virtual void release_page();

  virtual void preload_next_page();

  void clear();

  static uint64_t find_page_size(const data::location_ptr &location, uint32_t dest_id);

protected:
  void sort_without_buffer();

  void build_buffer();

  struct later {
    bool operator()(const journal_ptr &lhs, const journal_ptr &rhs) const;
  };

  const bool lazy_;
  const bool low_latency_;
  bus_ptr bus_;
  journal_ptr current_;
  JournalMap journals_;
  bool buffer_built_{false};
  std::vector<journal_ptr> no_data_journals_buffer_{};
  std::priority_queue<journal_ptr, std::vector<journal_ptr>, later> has_data_journals_heap_{};
  std::recursive_mutex mtx_{};
};

class writer {
public:
  explicit writer(const data::location_ptr &location, uint32_t dest_id, bool lazy, publisher_ptr publisher,
                  bool low_latency, const bus_ptr &bus);

  explicit writer(const data::location_ptr &location, uint32_t dest_id, bool lazy, publisher_ptr publisher,
                  bool low_latency, const bus_ptr &bus, uint64_t page_size);

  explicit writer(const data::location_ptr &location, uint32_t dest_id, bool lazy, publisher_ptr publisher,
                  bool low_latency, const bus_ptr &bus, uint64_t page_size, int64_t begin_time);

  explicit writer(const data::location_ptr &location, uint32_t dest_id, bool lazy, publisher_ptr publisher,
                  bool low_latency, const bus_ptr &bus, const journal_ptr &journal, int64_t begin_time);

  virtual ~writer() = default;

  [[nodiscard]] const data::location_ptr &get_location() const { return journal_->location_; }

  [[nodiscard]] uint32_t get_dest() const { return journal_->dest_id_; }

  [[nodiscard]] journal_ptr get_journal() const { return journal_; }

  [[nodiscard]] page_ptr get_current_page() const { return journal_->page_; }

  virtual uint64_t current_frame_uid();

  virtual frame_ptr open_frame(int64_t trigger_time, int32_t msg_type, size_t length, uint64_t stream_id = 0);

  virtual frame_ptr open_frame_lock_free(int64_t trigger_time, int32_t msg_type, size_t length, uint64_t stream_id = 0);

  virtual void close_frame(size_t data_length, int64_t gen_time = time::now_in_nano());

  virtual void close_frame_lock_free(size_t data_length, int64_t gen_time = time::now_in_nano());

  virtual void copy_frame(const frame_ptr &source);

  virtual void release_page();

  virtual void preload_next_page();

  virtual void mark(int64_t trigger_time, int32_t msg_type);

  virtual void mark_at(int64_t gen_time, int64_t trigger_time, int32_t msg_type);

  virtual void write_raw(int64_t trigger_time, int32_t msg_type, uintptr_t data, uint32_t length);

  virtual void write_bytes(int64_t trigger_time, int32_t msg_type, const std::vector<uint8_t> &data, uint32_t length);

  virtual void write_raw_at_as(int64_t gen_time, int64_t trigger_time, uint32_t source, uint32_t dest, int32_t msg_type,
                               uintptr_t data, uint32_t length);

  /**
   * Using auto with the return mess up the reference with the undlerying memory address, DO NOT USE it.
   * @tparam T
   * @param trigger_time
   * @param msg_type
   * @return a casted reference to the underlying memory address in mmap file
   */
  template <typename T> std::enable_if_t<size_fixed_v<T>, T &> open_data(int64_t trigger_time = 0) {
    auto frame = open_frame(trigger_time, T::tag, sizeof(T));
    return const_cast<T &>(frame->template data<T>());
  }

  template <typename T> T &open_custom_data(int32_t msg_type, int64_t trigger_time = 0) {
    auto frame = open_frame(trigger_time, msg_type, sizeof(T));
    return const_cast<T &>(*reinterpret_cast<const T *>(frame->data_address()));
  }

  virtual void close_data(int64_t gen_time = time::now_in_nano());

  template <typename T>
  std::enable_if_t<size_fixed_v<T>> write(int64_t trigger_time, const T &data, int32_t msg_type = T::tag) {
    auto frame = open_frame(trigger_time, msg_type, sizeof(T));
    auto size = frame->copy_data(data);
    close_frame(size);
  }

  template <typename T>
  std::enable_if_t<size_unfixed_v<T>> write(int64_t trigger_time, const T &data, int32_t msg_type = T::tag) {
    auto s = data.to_string();
    auto size = s.length();
    auto frame = open_frame(trigger_time, msg_type, size);
    memcpy(const_cast<void *>(frame->data_address()), s.c_str(), size);
    close_frame(size);
  }

  // this function can not be used for remote journal
  template <typename T>
  std::enable_if_t<size_fixed_v<T>> write_as(int64_t trigger_time, const T &data, uint32_t source, uint32_t dest) {
    auto frame = open_frame(trigger_time, T::tag, sizeof(T));
    auto size = frame->copy_data(data);
    frame->set_source(source);
    frame->set_dest(dest);
    close_frame(size);
  }

  template <typename T>
  std::enable_if_t<size_unfixed_v<T>> write_as(int64_t trigger_time, const T &data, uint32_t source, uint32_t dest) {
    auto s = data.to_string();
    auto size = s.length();
    auto frame = open_frame(trigger_time, T::tag, size);
    memcpy(const_cast<void *>(frame->data_address()), s.c_str(), size);
    frame->set_source(source);
    frame->set_dest(dest);
    close_frame(size);
  }

  template <typename T>
  std::enable_if_t<size_fixed_v<T>> write_at(int64_t gen_time, int64_t trigger_time, const T &data) {
    auto frame = open_frame(trigger_time, T::tag, sizeof(T));
    auto size = frame->copy_data(data);
    close_frame(size, gen_time);
  }

  template <typename T>
  std::enable_if_t<size_unfixed_v<T>> write_at(int64_t gen_time, int64_t trigger_time, const T &data) {
    auto s = data.to_string();
    auto size = s.length();
    auto frame = open_frame(trigger_time, T::tag, size);
    memcpy(const_cast<void *>(frame->data_address()), s.c_str(), size);
    close_frame(size, gen_time);
  }

protected:
  journal_ptr journal_;
  std::mutex writer_mtx_ = {};
  const uint64_t frame_id_base_;
  publisher_ptr publisher_;
  size_t size_to_write_;
  int64_t last_gen_time_;
  uint32_t writer_start_time_32int_;

  void close_page(int64_t trigger_time);
};

class writer_hook {
public:
  writer_hook() = default;

  virtual ~writer_hook() = default;

  virtual void on_open_frame(int64_t trigger_time, frame_ptr frame) = 0;

  virtual void on_close_frame(int64_t gen_time, frame_ptr frame) = 0;
};

class hookable_writer : public writer {
public:
  explicit hookable_writer(const data::location_ptr &location, uint32_t dest_id, bool lazy, publisher_ptr publisher,
                           bool low_latency, const bus_ptr &bus, uint64_t page_size, writer_hook_ptr hook)
      : writer(location, dest_id, lazy, std::move(publisher), low_latency, bus, page_size), hook_(std::move(hook)) {}

  frame_ptr open_frame(int64_t trigger_time, int32_t msg_type, size_t length, uint64_t stream_id = 0) override;

  void close_frame(size_t data_length, int64_t gen_time) override;

private:
  writer_hook_ptr hook_;
};

class replay_writer : public writer {
public:
  explicit replay_writer(const data::location_ptr &location, uint32_t dest_id, publisher_ptr publisher,
                         const bus_ptr &bus, uint64_t page_size, int64_t begin_time);

  frame_ptr open_frame(int64_t trigger_time, int32_t msg_type, size_t length, uint64_t stream_id = 0) override;

  void close_frame(size_t data_length, int64_t gen_time) override;

  uint64_t current_frame_uid() override;

private:
  reader_ptr reader_for_write_;
  cloned_frame_ptr cloned_frame_ = std::make_shared<cloned_frame>();
};

} // namespace kungfu::yijinjing::journal
#endif // YIJINJING_JOURNAL_H
