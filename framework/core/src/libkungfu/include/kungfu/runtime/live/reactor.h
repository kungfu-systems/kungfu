// SPDX-License-Identifier: Apache-2.0

//
// Created by Keren Dong on 2019-06-15.
//

#ifndef KUNGFU_RUNTIME_LIVE_REACTOR_H
#define KUNGFU_RUNTIME_LIVE_REACTOR_H

#include <atomic>

#include <kungfu/runtime/common.h>

#include <kungfu/runtime/io.h>
#include <kungfu/runtime/live/identity.h>
#include <kungfu/runtime/live/key_value_store.h>
#include <kungfu/runtime/live/route.h>
#include <kungfu/runtime/rx.h>
#include <kungfu/yijinjing/journal/journal.h>
#include <kungfu/yijinjing/log.h>
#include <kungfu/yijinjing/schema/registry.h>
#include <kungfu/yijinjing/time.h>

#ifndef KUNGFU_SETUP_LOG
#define KUNGFU_SETUP_LOG() kungfu::yijinjing::log::copy_log_settings(get_home(), get_home()->name)
#endif // KUNGFU_SETUP_LOG

namespace kungfu::runtime::live {

inline yijinjing::data::location_ptr make_system_location(const std::string &namespace_, const std::string &name,
                                                          const yijinjing::data::locator_ptr &locator,
                                                          uint32_t seed = KUNGFU_HASH_SEED) {
  return yijinjing::data::location::make_shared(locator->get_dir_mode(), yijinjing::enums::location_role::SYSTEM,
                                                namespace_, name, locator, seed);
}

typedef std::unordered_map<uint32_t, yijinjing::journal::writer_ptr> WriterMap;

class reactor : public yijinjing::resource {
public:
  explicit reactor(kungfu::runtime::io_device_ptr io_device);

  ~reactor() override;

  [[nodiscard]] bool is_usable() override;

  virtual void pre_setup();

  bool setup() override;

  void step(uint32_t count = 0);

  void run(uint32_t step_limit);

  [[nodiscard]] bool is_live() const;

  [[nodiscard]] bool is_low_latency() const;

  [[nodiscard]] const yijinjing::journal::bus_ptr &get_bus() const;

  void signal_stop();

  [[nodiscard]] int64_t now() const;

  void set_now(int64_t now);

  void set_begin_time(int64_t begin_time);

  [[nodiscard]] int64_t get_begin_time() const;

  void set_end_time(int64_t end_time);

  [[nodiscard]] int64_t get_end_time() const;

  [[nodiscard]] const yijinjing::data::locator_ptr &get_locator() const;

  [[nodiscard]] kungfu::runtime::io_device_ptr get_io_device() const;

  [[nodiscard]] const yijinjing::data::location_ptr &get_home() const;

  [[nodiscard]] uint32_t get_home_uid() const;

  [[nodiscard]] const std::string &get_home_uname() const;

  [[nodiscard]] const yijinjing::data::location_ptr &get_live_home() const;

  [[nodiscard]] uint32_t get_live_home_uid() const;

  [[nodiscard]] yijinjing::journal::reader_ptr get_reader() const;

  [[nodiscard]] virtual bool has_writer(uint32_t dest_id) const;

  [[nodiscard]] virtual yijinjing::journal::writer_ptr get_writer(uint32_t dest_id) const;

  [[nodiscard]] virtual bool has_off_thread_writer(uint32_t dest_id) const;

  [[nodiscard]] virtual yijinjing::journal::writer_ptr get_off_thread_writer(uint32_t dest_id) const;

  /// Returns a stable management snapshot. The caller may iterate it without
  /// racing writer membership changes on the reactor thread.
  [[nodiscard]] WriterMap get_writers() const;

  [[nodiscard]] bool has_location(uint32_t uid) const;

  [[nodiscard]] yijinjing::data::location_ptr get_location(uint32_t uid) const;

  [[nodiscard]] std::string get_location_uname(uint32_t uid) const;

  [[nodiscard]] bool is_location_live(uint32_t uid) const;

  [[nodiscard]] bool has_channel(uint32_t source, uint32_t dest) const;

  [[nodiscard]] bool has_channel(uint64_t hash) const;

  [[nodiscard]] const yijinjing::types::Channel &get_channel(uint32_t source, uint32_t dest) const;

  [[nodiscard]] const yijinjing::types::Channel &get_channel(uint64_t hash) const;

  [[nodiscard]] const std::unordered_map<uint64_t, yijinjing::types::Channel> &get_channels() const;

  [[nodiscard]] bool has_outlet(uint32_t source, uint32_t dest) const;

  [[nodiscard]] bool has_outlet(uint64_t hash) const;

  [[nodiscard]] const yijinjing::types::Outlet &get_outlet(uint32_t source, uint32_t dest) const;

  [[nodiscard]] const yijinjing::types::Outlet &get_outlet(uint64_t hash) const;

  [[nodiscard]] const std::unordered_map<uint64_t, yijinjing::types::Outlet> &get_outlets() const;

  [[nodiscard]] const std::unordered_map<uint32_t, yijinjing::types::Register> &get_registry() const;

  [[nodiscard]] const std::unordered_map<uint32_t, yijinjing::data::location_ptr> &get_locations() const;

  virtual void on_notify();

  virtual void on_exit();

  [[nodiscard]] virtual bool is_reactable(const event_ptr &event);

  [[nodiscard]] virtual key_value_store_ptr get_coordinator_store() const;

  [[nodiscard]] virtual key_value_store_ptr get_peer_store() const;

  [[nodiscard]] virtual std::string get_coordinator_kv(const std::string &key) const;

  [[nodiscard]] virtual std::map<std::string, std::string> get_coordinator_kvs(const std::set<std::string> &keys) const;

  virtual void put_coordinator_kv(const std::string &key, const std::string &value) const;

  virtual void put_coordinator_kvs(const std::map<std::string, std::string> &kvs) const;

  [[nodiscard]] virtual std::string get_peer_kv(const std::string &key) const;

  [[nodiscard]] virtual std::map<std::string, std::string> get_peer_kvs(const std::set<std::string> &keys) const;

  virtual void put_peer_kv(const std::string &key, const std::string &value) const;

  virtual void put_peer_kvs(const std::map<std::string, std::string> &kvs) const;

  virtual void read_location_from_store();

  virtual void ensure_coordinator_store();

  void write_location_to_store(const yijinjing::data::location_ptr &location);

  void request_deregister() {
    continual_ = false;
    live_ = false;
  }

  [[nodiscard]] yijinjing::data::location_ptr get_ledger_home_location() const;

  [[nodiscard]] yijinjing::data::location_ptr get_coordinator_home_location() const;

  [[nodiscard]] yijinjing::data::location_ptr get_coordinator_cmd_location() const;

  [[nodiscard]] const rx::connectable_observable<event_ptr> &get_events() const;

  // Register a per-frame callback for a carrier_type on the live event stream.
  // Intended to be called from a subclass react hook (peer::on_react() /
  // coordinator::on_react(), including a Python subclass via the binding), so the
  // subscription is installed before the reactor connects events_. This is the
  // react hook that lets a live consumer written outside C++ react to frames
  // without a bespoke C++ reactor subclass. Lives on the common base so both peer
  // and coordinator subclasses can use it.
  void observe(int32_t carrier_type, const std::function<void(const event_ptr &)> &callback);

  void disjoin(const yijinjing::data::location_ptr &location);

  void disjoin_channel(const yijinjing::data::location_ptr &location, uint32_t dest_id);

protected:
  int64_t begin_time_;
  int64_t end_time_;
  yijinjing::journal::reader_ptr reader_;
  WriterMap writers_ = {};
  WriterMap off_thread_writers_ = {};
  mutable std::mutex writers_mtx_{};
  mutable std::mutex off_thread_mtx_{};
  const size_t main_thread_id_{};
  std::set<std::string> location_uid64s_ = {};

  rx::connectable_observable<event_ptr> events_ = {};
  rx::loop_error_state_ptr loop_error_state_ = std::make_shared<rx::loop_error_state>();

  const yijinjing::data::location_ptr coordinator_home_location_;
  const yijinjing::data::location_ptr coordinator_cmd_location_;
  const yijinjing::data::location_ptr ledger_home_location_;

  static uint64_t make_source_dest_hash(uint32_t source_id, uint32_t dest_id);

  bool check_location_exists(uint32_t source_id, uint32_t dest_id) const;

  bool check_location_live(uint32_t source_id, uint32_t dest_id) const;

  void add_location(int64_t trigger_time, const yijinjing::data::location_ptr &location);

  void add_location(int64_t trigger_time, const yijinjing::types::Location &location);

  void remove_location(int64_t trigger_time, uint32_t location_uid);

  void register_location(int64_t trigger_time, const yijinjing::types::Register &register_data);

  void deregister_location(int64_t trigger_time, uint32_t location_uid);

  void register_channel(int64_t trigger_time, const yijinjing::types::Channel &channel);

  void deregister_channel(uint32_t source_id);

  void register_outlet(int64_t trigger_time, const yijinjing::types::Outlet &outlet);

  void deregister_outlet(uint32_t source_id);

  void require_read_from(int64_t trigger_time, uint32_t dest_id, uint32_t source_id, int64_t from_time,
                         uint64_t page_size = 0);

  void require_read_from_public(int64_t trigger_time, uint32_t dest_id, uint32_t source_id, int64_t from_time,
                                uint64_t page_size = 0);

  void require_read_from_sync(int64_t trigger_time, uint32_t dest_id, uint32_t source_id, int64_t from_time,
                              uint64_t page_size = 0);

  void require_write_to(int64_t trigger_time, uint32_t source_id, uint32_t dest_id, uint64_t page_size = 0);

  void require_write_to_outlet(int64_t trigger_time, uint32_t source_id, const yijinjing::data::location_ptr &location,
                               uint64_t page_size = 0) const;

  virtual void react() = 0;

  /**
   * Declare a route selecting one carrier type (KF-ADR-019f86da-4f90-786d-9fd5-468c3f3d231b).
   *
   * The matcher is derived from T, so the carrier recorded for topology queries
   * cannot drift from the filter actually installed. Declaring does not
   * subscribe: wire_routes() installs every declared route in phase order, which
   * is what makes the phase an enforced order rather than a claim about source
   * layout.
   */
  template <typename T>
  route_builder declare(route_phase phase, const char *name, std::function<void(const event_ptr &)> handler) {
    route_record record;
    record.phase = phase;
    record.name = name;
    record.carrier = T::tag;
    record.matcher = [](const event_ptr &event) { return event->carrier_type() == T::tag; };
    record.handler = std::move(handler);
    return routes_.add(std::move(record));
  }

  /**
   * Declare a catch-all route over journal frames.
   *
   * This is the RTTI predicate `instanceof<frame>()`: it matches every journal
   * frame while naming no carrier type, which is why such a route is invisible
   * to any search for a carrier and must be recorded to be attributable.
   */
  route_builder declare_frames(route_phase phase, const char *name, std::function<void(const event_ptr &)> handler);

  /**
   * Declare a route over every event, selecting no carrier type.
   *
   * Unlike declare_frames() this applies no RTTI predicate: it is the shape of a
   * route whose selection lives entirely in its guard or stream stage.
   */
  route_builder declare_events(route_phase phase, const char *name, std::function<void(const event_ptr &)> handler);

  /**
   * Subscribe a carrier route immediately and record it as dynamic.
   *
   * For a route installed outside react(), where declaring is impossible because
   * wire_routes() has already run — `on_start()` reached from
   * `on_request_start()` is the case that forces this: it subscribes to events_
   * from inside an events_ handler. Its position follows from when the call ran,
   * not from a phase, so it is recorded to stay attributable rather than to be
   * ordered.
   */
  template <typename T>
  void declare_dynamic(route_extension extension, const char *name, std::function<void(const event_ptr &)> handler) {
    route_record record;
    record.name = name;
    record.dynamic = true;
    record.extension = extension;
    record.carrier = T::tag;
    record.matcher = [](const event_ptr &event) { return event->carrier_type() == T::tag; };
    record.handler = handler;
    routes_.add(std::move(record));
    // Qualified: this is a template, so an unqualified is()/$() would be a
    // dependent call resolved by ADL at instantiation, and ADL on the carrier
    // tag's int type never reaches kungfu::rx.
    events_ | rx::is(T::tag) | rx::$([handler](const event_ptr &event) { handler(event); });
  }

  /** As declare_dynamic, for a route that selects no carrier. */
  void declare_dynamic_events(route_extension extension, const char *name,
                              const std::function<void(const event_ptr &)> &handler);

  /**
   * Record a subscription this reactor installs through its own operator chain.
   *
   * The timer and lazy-write paths compose their chain themselves and cannot
   * hand a plain handler to declare_dynamic. Noting them keeps the table a
   * complete account of what is subscribed, which is what the closed-world check
   * is defined against; it does not install or order anything.
   */
  void note_dynamic_route(route_extension extension, std::string name, int32_t carrier = 0);

  /** Validate the declared routes, then subscribe them in phase order. */
  void wire_routes();

  /** The recorded route table, including dynamic routes, as JSON. */
  [[nodiscard]] std::string routes_json() const { return routes_.to_json(); }

  /** Names of every recorded route handling `carrier`. */
  [[nodiscard]] std::vector<std::string> route_consumers_of(int32_t carrier) const {
    return routes_.consumers_of(carrier);
  }

  virtual void on_active() = 0;

  virtual void on_frame() = 0;

  void cleanup_reader_disjoin();

  [[nodiscard]] std::exception_ptr get_loop_error() const { return loop_error_state_->first_error(); }

protected:
  kungfu::runtime::io_device_ptr io_device_;
  rx::composite_subscription cs_;
  route_table routes_ = {};
  int64_t now_;
  mutable key_value_store_ptr coordinator_store_ = {};
  mutable key_value_store_ptr peer_store_ = {};
  mutable std::mutex coordinator_store_mtx_ = {};
  mutable std::mutex peer_store_mtx_ = {};
  inline static const std::string LOCATION_KEYS = "location_uid64";

  std::unordered_map<uint64_t, yijinjing::types::Outlet> outlets_ = {};
  std::unordered_map<uint64_t, yijinjing::types::Channel> channels_ = {};
  std::unordered_map<uint32_t, yijinjing::data::location_ptr> locations_ = {};
  std::unordered_map<uint64_t, yijinjing::data::location_ptr> location64s_ = {};
  std::unordered_map<uint32_t, yijinjing::types::Register> registry_ = {};
  std::set<yijinjing::data::location_ptr> disjoin_locations_ = {};
  std::set<std::pair<yijinjing::data::location_ptr, uint32_t>> disjoin_channels_ = {};

  std::atomic_bool continual_{true};
  std::atomic_bool live_{false};
  std::atomic_uint32_t step_limit_{0};

  void produce(const rx::subscriber<event_ptr> &sb);

  virtual bool drain(const rx::subscriber<event_ptr> &sb);

  void deal_notice(bool bypass, bool notify, const rx::subscriber<event_ptr> &sb);

  template <typename T>
  std::enable_if_t<T::reflect> do_require_read_from(yijinjing::journal::writer_ptr &&writer, int64_t trigger_time,
                                                    uint32_t dest_id, uint32_t source_id, int64_t from_time,
                                                    uint64_t page_size = 0) {
    if (check_location_exists(source_id, dest_id)) {
      T &msg = writer->template open_data<T>(trigger_time);
      msg.source_id = source_id;
      msg.from_time = from_time;
      msg.page_size = page_size;
      writer->close_data();
    }
  }

  static void delegate_produce(reactor *instance, const rx::subscriber<event_ptr> &subscriber);
};
} // namespace kungfu::runtime::live
#endif // KUNGFU_RUNTIME_LIVE_REACTOR_H
