// SPDX-License-Identifier: Apache-2.0

//
// Created by Keren Dong on 2019-06-15.
//

#ifndef KUNGFU_RUNTIME_LIVE_REACTOR_H
#define KUNGFU_RUNTIME_LIVE_REACTOR_H

#include <kungfu/runtime/common.h>

#include <kungfu/runtime/io.h>
#include <kungfu/runtime/live/identity.h>
#include <kungfu/runtime/rx.h>
#include <kungfu/runtime/util/rocks.h>
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

  [[nodiscard]] virtual bool has_band_writer(uint32_t dest_id) const;

  [[nodiscard]] virtual yijinjing::journal::writer_ptr get_band_writer(uint32_t dest_id) const;

  [[nodiscard]] const WriterMap &get_writers() const;

  [[nodiscard]] bool has_location(uint32_t uid) const;

  [[nodiscard]] yijinjing::data::location_ptr get_location(uint32_t uid) const;

  [[nodiscard]] std::string get_location_uname(uint32_t uid) const;

  [[nodiscard]] bool is_location_live(uint32_t uid) const;

  [[nodiscard]] bool has_channel(uint32_t source, uint32_t dest) const;

  [[nodiscard]] bool has_channel(uint64_t hash) const;

  [[nodiscard]] const yijinjing::types::Channel &get_channel(uint32_t source, uint32_t dest) const;

  [[nodiscard]] const yijinjing::types::Channel &get_channel(uint64_t hash) const;

  [[nodiscard]] const std::unordered_map<uint64_t, yijinjing::types::Channel> &get_channels() const;

  [[nodiscard]] bool has_band(uint32_t source, uint32_t dest) const;

  [[nodiscard]] bool has_band(uint64_t hash) const;

  [[nodiscard]] const yijinjing::types::Band &get_band(uint32_t source, uint32_t dest) const;

  [[nodiscard]] const yijinjing::types::Band &get_band(uint64_t hash) const;

  [[nodiscard]] const std::unordered_map<uint64_t, yijinjing::types::Band> &get_bands() const;

  [[nodiscard]] const std::unordered_map<uint32_t, yijinjing::types::Register> &get_registry() const;

  [[nodiscard]] const std::unordered_map<uint32_t, yijinjing::data::location_ptr> &get_locations() const;

  virtual void on_notify();

  virtual void on_exit();

  [[nodiscard]] virtual bool is_reactable(const event_ptr &event);

  [[nodiscard]] virtual rocksdb::DB *get_coordinator_rocksdb() const;

  [[nodiscard]] virtual rocksdb::DB *get_peer_rocksdb() const;

  [[nodiscard]] virtual std::string get_coordinator_kv(const std::string &key) const;

  [[nodiscard]] virtual std::map<std::string, std::string> get_coordinator_kvs(const std::set<std::string> &keys) const;

  virtual void put_coordinator_kv(const std::string &key, const std::string &value) const;

  virtual void put_coordinator_kvs(const std::map<std::string, std::string> &kvs) const;

  [[nodiscard]] virtual std::string get_peer_kv(const std::string &key) const;

  [[nodiscard]] virtual std::map<std::string, std::string> get_peer_kvs(const std::set<std::string> &keys) const;

  virtual void put_peer_kv(const std::string &key, const std::string &value) const;

  virtual void put_peer_kvs(const std::map<std::string, std::string> &kvs) const;

  virtual void read_location_from_rocksdb();

  virtual void ensure_coordinator_rocksdb();

  void write_location_to_rocksdb(const yijinjing::data::location_ptr &location);

  void request_deregister() {
    continual_ = false;
    live_ = false;
  }

  [[nodiscard]] yijinjing::data::location_ptr get_ledger_home_location() const;

  [[nodiscard]] yijinjing::data::location_ptr get_coordinator_home_location() const;

  [[nodiscard]] yijinjing::data::location_ptr get_coordinator_cmd_location() const;

  [[nodiscard]] const rx::connectable_observable<event_ptr> &get_events() const;

  void disjoin(const yijinjing::data::location_ptr &location);

  void disjoin_channel(const yijinjing::data::location_ptr &location, uint32_t dest_id);

protected:
  int64_t begin_time_;
  int64_t end_time_;
  yijinjing::journal::reader_ptr reader_;
  WriterMap writers_ = {};
  WriterMap band_writers_ = {};
  mutable std::mutex band_mtx_{};
  const size_t main_thread_id_{};
  std::set<std::string> location_uid64s_ = {};

  rx::connectable_observable<event_ptr> events_ = {};

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

  void register_band(int64_t trigger_time, const yijinjing::types::Band &band);

  void deregister_band(uint32_t source_id);

  void require_read_from(int64_t trigger_time, uint32_t dest_id, uint32_t source_id, int64_t from_time,
                         uint64_t page_size = 0);

  void require_read_from_public(int64_t trigger_time, uint32_t dest_id, uint32_t source_id, int64_t from_time,
                                uint64_t page_size = 0);

  void require_read_from_sync(int64_t trigger_time, uint32_t dest_id, uint32_t source_id, int64_t from_time,
                              uint64_t page_size = 0);

  void require_write_to(int64_t trigger_time, uint32_t source_id, uint32_t dest_id, uint64_t page_size = 0);

  void require_write_to_band(int64_t trigger_time, uint32_t source_id, const yijinjing::data::location_ptr &location,
                             uint64_t page_size = 0) const;

  virtual void react() = 0;

  virtual void on_active() = 0;

  virtual void on_frame() = 0;

  void cleanup_reader_disjoin();

protected:
  kungfu::runtime::io_device_ptr io_device_;
  rx::composite_subscription cs_;
  int64_t now_;
  mutable rocksdb::DB *coordinator_db_ = {};
  mutable rocksdb::DB *peer_db_ = {};
  mutable std::mutex coordinator_db_mtx_ = {};
  mutable std::mutex peer_db_mtx_ = {};
  inline static const std::string LOCATION_KEYS = "location_uid64";

  std::unordered_map<uint64_t, yijinjing::types::Band> bands_ = {};
  std::unordered_map<uint64_t, yijinjing::types::Channel> channels_ = {};
  std::unordered_map<uint32_t, yijinjing::data::location_ptr> locations_ = {};
  std::unordered_map<uint64_t, yijinjing::data::location_ptr> location64s_ = {};
  std::unordered_map<uint32_t, yijinjing::types::Register> registry_ = {};
  std::set<yijinjing::data::location_ptr> disjoin_locations_ = {};
  std::set<std::pair<yijinjing::data::location_ptr, uint32_t>> disjoin_channels_ = {};

  volatile bool continual_ = true;
  volatile bool live_ = false;
  volatile uint32_t step_limit_ = 0;

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
