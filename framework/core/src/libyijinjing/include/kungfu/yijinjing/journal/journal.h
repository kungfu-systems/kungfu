// SPDX-License-Identifier: Apache-2.0

#ifndef YIJINJING_JOURNAL_H
#define YIJINJING_JOURNAL_H

#include <chrono>
#include <kungfu/common.h>
#include <kungfu/yijinjing/journal/bus.h>
#include <kungfu/yijinjing/journal/common.h>
#include <kungfu/yijinjing/journal/frame.h>
#include <kungfu/yijinjing/journal/page.h>
#include <kungfu/yijinjing/ownership.h>
#include <kungfu/yijinjing/schema/core.h>
#include <kungfu/yijinjing/time.h>
#include <mutex>
#include <queue>
#include <thread>

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

enum class page_precreation : uint8_t { disabled, coordinator };

/**
 * Page lifecycle knobs: how long a passed page is retained, and the page-size
 * ceiling above which the coordinator stops pre-creating the next page.
 *
 * These are diagnostic knobs. They are carried as policy rather than read from
 * the process environment inside the journal, so that a journal's behaviour is
 * a function of its arguments only — copyable, testable, and injectable.
 */
struct page_lifecycle_policy {
  /// Retain passed pages instead of releasing them (diagnostic).
  bool keep_page = false;
  /// Skip coordinator pre-creation once page size exceeds this many MB.
  /// Zero means no ceiling, i.e. pre-creation is never skipped on size.
  uint32_t max_pre_create_size_mb = 0;

  [[nodiscard]] static constexpr page_lifecycle_policy defaults() noexcept { return {}; }
};

enum class page_lifecycle_parse_status : uint8_t { ok, max_pre_create_size_invalid };

/**
 * Outcome of parsing page lifecycle configuration. Parse failure is a value,
 * not an exception and not a swallowed log: the caller decides whether an
 * unusable setting deserves a warning or a hard stop (ADR-0082 tier 3).
 * On failure `policy` carries the defaults for the field that failed.
 */
struct page_lifecycle_parse_result {
  page_lifecycle_policy policy;
  page_lifecycle_parse_status status = page_lifecycle_parse_status::ok;

  [[nodiscard]] constexpr bool ok() const noexcept { return status == page_lifecycle_parse_status::ok; }
};

/**
 * Parse page lifecycle configuration from raw string values.
 *
 * Pure: it reads no process state, so it is unit-testable without mutating the
 * environment. The entry layer supplies the values; historically these came
 * from KF_KEEP_PAGE / KF_MAX_PRE_CREATE_SIZE.
 *
 * @param keep_page_value       presence means enabled (any value, including
 *                              empty); nullptr means absent. This preserves the
 *                              historical getenv()-presence contract.
 * @param max_pre_create_size_value decimal MB; nullptr means absent.
 */
[[nodiscard]] page_lifecycle_parse_result parse_page_lifecycle(const char *keep_page_value,
                                                               const char *max_pre_create_size_value);

struct journal_open_policy {
  page_open_policy current_page;
  page_open_policy preload_page;
  page_precreation precreation;
  /// Defaulted so every existing named factory keeps its aggregate initializer.
  page_lifecycle_policy lifecycle = {};

  [[nodiscard]] static constexpr journal_open_policy reader() noexcept {
    return {page_open_policy::reader(), page_open_policy::reader_preload(), page_precreation::disabled};
  }
  [[nodiscard]] static constexpr journal_open_policy coordinator_reader() noexcept {
    return {page_open_policy::reader(), page_open_policy::reader_preload(), page_precreation::coordinator};
  }
  [[nodiscard]] static constexpr journal_open_policy writer() noexcept {
    return {page_open_policy::writer(), page_open_policy::writer_preload(), page_precreation::disabled};
  }

  [[nodiscard]] constexpr journal_open_policy with_lifecycle(page_lifecycle_policy value) const noexcept {
    journal_open_policy copy = *this;
    copy.lifecycle = value;
    return copy;
  }
};

struct reader_policy {
  journal_open_policy journal;
  bool discover_page_size;

  [[nodiscard]] static constexpr reader_policy peer() noexcept { return {journal_open_policy::reader(), true}; }
  [[nodiscard]] static constexpr reader_policy coordinator() noexcept {
    return {journal_open_policy::coordinator_reader(), false};
  }

  [[nodiscard]] constexpr reader_policy with_lifecycle(page_lifecycle_policy value) const noexcept {
    return {journal.with_lifecycle(value), discover_page_size};
  }
};

class journal {
public:
  explicit journal(data::location_ptr location, uint32_t dest_id, journal_open_policy policy, bool low_latency,
                   bus_ptr bus, uint64_t page_size,
                   yijinjing::enums::Priority priority = yijinjing::enums::Priority::Medium);

  [[deprecated("use journal_open_policy")]] explicit journal(
      data::location_ptr location, uint32_t dest_id, bool is_writing, bool lazy, bool low_latency, bus_ptr bus,
      uint64_t page_size, yijinjing::enums::Priority priority = yijinjing::enums::Priority::Medium);

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
  const journal_open_policy policy_;
  const bool low_latency_;
  const yijinjing::enums::Priority priority_;
  bus_ptr bus_ = {};
  page_ptr pre_create_page_ = {};
  page_ptr page_ = {};
  page_ptr preload_page_ = {};
  std::mutex load_page_mtx_ = {};
  std::vector<page_ptr> passed_page_collector_ = {};
  std::mutex passed_page_collector_mtx_ = {};
  frame_ptr frame_ = {};
  uint64_t page_frame_nb_ = 0;

  /// Page lifecycle is carried by policy_ (const, and copied by the copy
  /// constructor), so a copied journal keeps the behaviour it was configured
  /// with. These were previously mutable members seeded from getenv() in the
  /// constructor body, which the copy constructor silently dropped.
  [[nodiscard]] bool keep_page() const noexcept { return policy_.lifecycle.keep_page; }
  [[nodiscard]] uint32_t max_pre_create_size_mb() const noexcept { return policy_.lifecycle.max_pre_create_size_mb; }

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
  explicit reader(reader_policy policy, bool low_latency, bus_ptr bus)
      : policy_(policy), low_latency_(low_latency), bus_(std::move(bus)), current_(nullptr) {}

  [[deprecated("use reader_policy")]] explicit reader(bool lazy, bool low_latency, bus_ptr bus)
      : reader(lazy ? reader_policy::peer() : reader_policy::coordinator(), low_latency, std::move(bus)) {}

  reader(const reader &other);

  virtual ~reader();

  /**
   * join journal at given data location
   * @param location where the journal locates
   * @param dest_id journal dest id
   * @param from_time subscribe events after this time, 0 means from start
   */
  virtual void join(const data::location_ptr &location, uint32_t dest_id, int64_t from_time, uint64_t page_size = 0,
                    yijinjing::enums::Priority priority = yijinjing::enums::Priority::Medium);

  virtual void disjoin(const data::location_ptr &location);

  virtual void disjoin_channel(const data::location_ptr &location, uint32_t dest_id);

  /**
   * The cursor surface is single-consumer and thread-affine. Journal membership
   * may be snapshotted concurrently, but advancing or inspecting this cursor
   * from multiple threads is unsupported.
   */
  [[nodiscard]] frame_ptr current_frame() const {
    assert_cursor_thread(true);
    return current_->current_frame();
  }

  [[nodiscard]] uint64_t current_frame_id() const {
    assert_cursor_thread(true);
    return current_->current_frame_id();
  }

  [[nodiscard]] page_ptr current_page() const {
    assert_cursor_thread(true);
    return current_->current_page();
  }

  [[nodiscard]] uint32_t current_page_id() const {
    assert_cursor_thread(true);
    return current_->current_page_id();
  }

  /** Snapshot safe for concurrent management iteration. */
  [[nodiscard]] JournalMap get_journals() const;

  [[nodiscard]] journal_ptr get_current_journal() const {
    assert_cursor_thread(true);
    return current_;
  }

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
  void assert_cursor_thread(bool claim) const;
  [[nodiscard]] std::vector<journal_ptr> journal_snapshot() const;
  void sort_without_buffer();

  void build_buffer();

  struct later {
    bool operator()(const journal_ptr &lhs, const journal_ptr &rhs) const;
  };

  const reader_policy policy_;
  const bool low_latency_;
  bus_ptr bus_;
  journal_ptr current_;
  JournalMap journals_;
  bool buffer_built_{false};
  std::vector<journal_ptr> no_data_journals_buffer_{};
  std::priority_queue<journal_ptr, std::vector<journal_ptr>, later> has_data_journals_heap_{};
  mutable std::mutex journals_mtx_{};
#ifndef NDEBUG
  mutable std::mutex cursor_owner_mtx_{};
  mutable std::thread::id cursor_owner_thread_{};
#endif
};

class writer {
public:
  class frame_transaction {
  public:
    frame_transaction(frame_transaction &&other) noexcept;
    frame_transaction &operator=(frame_transaction &&other) noexcept;
    frame_transaction(const frame_transaction &) = delete;
    frame_transaction &operator=(const frame_transaction &) = delete;
    ~frame_transaction();

    [[nodiscard]] ::kungfu::yijinjing::journal::frame *frame() const { return frame_; }
    [[nodiscard]] void *data() const { return const_cast<void *>(frame_->data_address()); }
    void commit(size_t data_length, int64_t gen_time = time::now_in_nano());

  private:
    friend class writer;
    friend class replay_writer;
    frame_transaction(writer &owner, ::kungfu::yijinjing::journal::frame *frame, bool replay = false) noexcept;
    void abort() noexcept;

    writer *owner_;
    ::kungfu::yijinjing::journal::frame *frame_;
    bool replay_{false};
  };

  explicit writer(const data::location_ptr &location, uint32_t dest_id, publisher_ptr publisher, bool low_latency,
                  const bus_ptr &bus);

  explicit writer(const data::location_ptr &location, uint32_t dest_id, publisher_ptr publisher, bool low_latency,
                  const bus_ptr &bus, uint64_t page_size);

  explicit writer(const data::location_ptr &location, uint32_t dest_id, publisher_ptr publisher, bool low_latency,
                  const bus_ptr &bus, uint64_t page_size, int64_t begin_time);

  explicit writer(const data::location_ptr &location, uint32_t dest_id, publisher_ptr publisher, bool low_latency,
                  const bus_ptr &bus, const journal_ptr &journal, int64_t begin_time);

  [[deprecated("writer mapping policy is explicit")]]
  explicit writer(const data::location_ptr &location, uint32_t dest_id, bool lazy, publisher_ptr publisher,
                  bool low_latency, const bus_ptr &bus);

  [[deprecated("writer mapping policy is explicit")]]
  explicit writer(const data::location_ptr &location, uint32_t dest_id, bool lazy, publisher_ptr publisher,
                  bool low_latency, const bus_ptr &bus, uint64_t page_size);

  [[deprecated("writer mapping policy is explicit")]]
  explicit writer(const data::location_ptr &location, uint32_t dest_id, bool lazy, publisher_ptr publisher,
                  bool low_latency, const bus_ptr &bus, uint64_t page_size, int64_t begin_time);

  [[deprecated("writer mapping policy is explicit")]]
  explicit writer(const data::location_ptr &location, uint32_t dest_id, bool lazy, publisher_ptr publisher,
                  bool low_latency, const bus_ptr &bus, const journal_ptr &journal, int64_t begin_time);

  virtual ~writer() = default;

  [[nodiscard]] const data::location_ptr &get_location() const { return journal_->location_; }

  [[nodiscard]] uint32_t get_dest() const { return journal_->dest_id_; }

  [[nodiscard]] journal_ptr get_journal() const { return journal_; }

  [[nodiscard]] page_ptr get_current_page() const { return journal_->page_; }

  [[nodiscard]] const ownership::evidence &ownership_status() const { return writer_lease_.status(); }

  virtual uint64_t current_frame_uid();

  [[nodiscard]] virtual frame_transaction reserve_frame(int64_t trigger_time, int32_t carrier_type, size_t length,
                                                        uint64_t stream_id = 0);

  [[deprecated("use reserve_frame(); split open/close ownership is not exception-safe for caller abandonment")]]
  virtual frame_ptr open_frame(int64_t trigger_time, int32_t carrier_type, size_t length, uint64_t stream_id = 0);

  [[deprecated("unserialized compatibility API; it is not generally lock-free")]]
  virtual frame_ptr open_frame_lock_free(int64_t trigger_time, int32_t carrier_type, size_t length,
                                         uint64_t stream_id = 0);

  [[deprecated("use frame_transaction::commit()")]]
  virtual void close_frame(size_t data_length, int64_t gen_time = time::now_in_nano());

  [[deprecated("unserialized compatibility API; it is not generally lock-free")]]
  virtual void close_frame_lock_free(size_t data_length, int64_t gen_time = time::now_in_nano());

  virtual void copy_frame(const frame_ptr &source);

  virtual void release_page();

  virtual void preload_next_page();

  virtual void mark(int64_t trigger_time, int32_t carrier_type);

  virtual void mark_at(int64_t gen_time, int64_t trigger_time, int32_t carrier_type);

  virtual void write_raw(int64_t trigger_time, int32_t carrier_type, uintptr_t data, uint32_t length);

  virtual void write_bytes(int64_t trigger_time, int32_t carrier_type, const std::vector<uint8_t> &data,
                           uint32_t length);

  virtual void write_raw_at_as(int64_t gen_time, int64_t trigger_time, uint32_t source, uint32_t dest,
                               int32_t carrier_type, uintptr_t data, uint32_t length);

  /**
   * Using auto with the return mess up the reference with the undlerying memory address, DO NOT USE it.
   * @tparam T
   * @param trigger_time
   * @param carrier_type
   * @return a casted reference to the underlying memory address in mmap file
   */
#if defined(__clang__)
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
#elif defined(__GNUC__)
#pragma GCC diagnostic push
#pragma GCC diagnostic ignored "-Wdeprecated-declarations"
#elif defined(_MSC_VER)
#pragma warning(push)
#pragma warning(disable : 4996)
#endif
  template <typename T> std::enable_if_t<size_fixed_v<T>, T &> open_data(int64_t trigger_time = 0) {
    auto frame = open_frame(trigger_time, T::tag, sizeof(T));
    return const_cast<T &>(frame->template data<T>());
  }

  template <typename T> T &open_custom_data(int32_t carrier_type, int64_t trigger_time = 0) {
    auto frame = open_frame(trigger_time, carrier_type, sizeof(T));
    return const_cast<T &>(*reinterpret_cast<const T *>(frame->data_address()));
  }
#if defined(__clang__)
#pragma clang diagnostic pop
#elif defined(__GNUC__)
#pragma GCC diagnostic pop
#elif defined(_MSC_VER)
#pragma warning(pop)
#endif

  virtual void close_data(int64_t gen_time = time::now_in_nano());

  template <typename T>
  std::enable_if_t<size_fixed_v<T>> write(int64_t trigger_time, const T &data, int32_t carrier_type = T::tag) {
    auto tx = reserve_frame(trigger_time, carrier_type, sizeof(T));
    auto size = tx.frame()->copy_data(data);
    tx.commit(size);
  }

  template <typename T>
  std::enable_if_t<size_unfixed_v<T>> write(int64_t trigger_time, const T &data, int32_t carrier_type = T::tag) {
    auto s = data.to_string();
    auto size = s.length();
    auto tx = reserve_frame(trigger_time, carrier_type, size);
    memcpy(tx.data(), s.c_str(), size);
    tx.commit(size);
  }

  // this function can not be used for remote journal
  template <typename T>
  std::enable_if_t<size_fixed_v<T>> write_as(int64_t trigger_time, const T &data, uint32_t source, uint32_t dest) {
    auto tx = reserve_frame(trigger_time, T::tag, sizeof(T));
    auto size = tx.frame()->copy_data(data);
    tx.frame()->set_source(source);
    tx.frame()->set_dest(dest);
    tx.commit(size);
  }

  template <typename T>
  std::enable_if_t<size_unfixed_v<T>> write_as(int64_t trigger_time, const T &data, uint32_t source, uint32_t dest) {
    auto s = data.to_string();
    auto size = s.length();
    auto tx = reserve_frame(trigger_time, T::tag, size);
    memcpy(tx.data(), s.c_str(), size);
    tx.frame()->set_source(source);
    tx.frame()->set_dest(dest);
    tx.commit(size);
  }

  template <typename T>
  std::enable_if_t<size_fixed_v<T>> write_at(int64_t gen_time, int64_t trigger_time, const T &data) {
    auto tx = reserve_frame(trigger_time, T::tag, sizeof(T));
    auto size = tx.frame()->copy_data(data);
    tx.commit(size, gen_time);
  }

  template <typename T>
  std::enable_if_t<size_unfixed_v<T>> write_at(int64_t gen_time, int64_t trigger_time, const T &data) {
    auto s = data.to_string();
    auto size = s.length();
    auto tx = reserve_frame(trigger_time, T::tag, size);
    memcpy(tx.data(), s.c_str(), size);
    tx.commit(size, gen_time);
  }

protected:
  ownership::lease writer_lease_;
  journal_ptr journal_;
  std::timed_mutex writer_mtx_ = {};
  publisher_ptr publisher_;
  size_t size_to_write_;
  int64_t last_gen_time_;

  virtual void on_frame_opened(int64_t trigger_time, ::kungfu::yijinjing::journal::frame *frame);
  virtual void on_frame_closing(int64_t gen_time, ::kungfu::yijinjing::journal::frame *frame);
  ::kungfu::yijinjing::journal::frame *open_frame_unserialized(int64_t trigger_time, int32_t carrier_type,
                                                               size_t length, uint64_t stream_id);
  void close_frame_unserialized(size_t data_length, int64_t gen_time);
  void abort_frame_unserialized() noexcept;
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
  explicit hookable_writer(const data::location_ptr &location, uint32_t dest_id, publisher_ptr publisher,
                           bool low_latency, const bus_ptr &bus, uint64_t page_size, writer_hook_ptr hook)
      : writer(location, dest_id, std::move(publisher), low_latency, bus, page_size), hook_(std::move(hook)) {}

  [[deprecated("writer mapping policy is explicit")]]
  explicit hookable_writer(const data::location_ptr &location, uint32_t dest_id, bool lazy, publisher_ptr publisher,
                           bool low_latency, const bus_ptr &bus, uint64_t page_size, writer_hook_ptr hook)
      : writer(location, dest_id, lazy, std::move(publisher), low_latency, bus, page_size), hook_(std::move(hook)) {}

private:
  void on_frame_opened(int64_t trigger_time, ::kungfu::yijinjing::journal::frame *frame) override;
  void on_frame_closing(int64_t gen_time, ::kungfu::yijinjing::journal::frame *frame) override;
  writer_hook_ptr hook_;
};

class replay_writer : public writer {
public:
  explicit replay_writer(const data::location_ptr &location, uint32_t dest_id, publisher_ptr publisher,
                         const bus_ptr &bus, uint64_t page_size, int64_t begin_time);

  frame_ptr open_frame(int64_t trigger_time, int32_t carrier_type, size_t length, uint64_t stream_id = 0) override;

  void close_frame(size_t data_length, int64_t gen_time) override;

  frame_transaction reserve_frame(int64_t trigger_time, int32_t carrier_type, size_t length,
                                  uint64_t stream_id = 0) override;

  uint64_t current_frame_uid() override;

private:
  reader_ptr reader_for_write_;
  cloned_frame_ptr cloned_frame_ = std::make_shared<cloned_frame>();
};

} // namespace kungfu::yijinjing::journal
#endif // YIJINJING_JOURNAL_H
