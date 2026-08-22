// SPDX-License-Identifier: Apache-2.0

//
// Created by Keren Dong on 2019-06-01.
//

#ifndef KUNGFU_IO_H
#define KUNGFU_IO_H

#include <atomic>
#include <condition_variable>
#include <mutex>

#include <kungfu/runtime/common.h>

#include <kungfu/runtime/nanomsg/socket.h>
#include <kungfu/yijinjing/journal/journal.h>

namespace kungfu::runtime {
namespace journal {
// defined in typed_frame_dump.cpp: installs the full-registry raw-payload
// dumper into the core frame's to_string seam (idempotent)
void install_typed_frame_dumper();
} // namespace journal

struct io_mapping_policy {
  yijinjing::journal::reader_policy reader;
  bool resource_manager_required;
  bool legacy_lazy_value;

  [[nodiscard]] static constexpr io_mapping_policy peer() noexcept {
    return {yijinjing::journal::reader_policy::peer(), true, true};
  }
  [[nodiscard]] static constexpr io_mapping_policy coordinator() noexcept {
    return {yijinjing::journal::reader_policy::coordinator(), false, false};
  }
  [[nodiscard]] static constexpr io_mapping_policy from_legacy_lazy(bool lazy) noexcept {
    return lazy ? peer() : coordinator();
  }

  [[nodiscard]] constexpr io_mapping_policy
  with_lifecycle(yijinjing::journal::page_lifecycle_policy value) const noexcept {
    return {reader.with_lifecycle(value), resource_manager_required, legacy_lazy_value};
  }
};

FORWARD_DECLARE_CLASS_PTR(session)

#define SETUP_TIMEOUT 50
#define TEST_USABLE_TIMEOUT 500
#define DEFAULT_RECV_TIMEOUT 100
#define DEFAULT_NOTICE_TIMEOUT 1000
#define REGISTER_TIMEOUT_SECONDS 60

class io_device : public resource {
public:
  io_device(data::location_ptr home, bool low_latency, io_mapping_policy policy);

  ~io_device() override = default;

  bool is_usable() override { return publisher_ and observer_ and publisher_->is_usable() and observer_->is_usable(); }

  [[nodiscard]] bool is_lazy() const { return mapping_policy_.legacy_lazy_value; }

  bool setup() override {
    bool prc = publisher_->setup();
    bool orc = observer_->setup();
    return prc && orc;
  }

  virtual void cancel_usability_probe() {}

  [[nodiscard]] const data::locator_ptr &get_locator() const { return home_->locator; }

  [[nodiscard]] const data::location_ptr &get_home() const { return home_; }

  [[nodiscard]] const data::location_ptr &get_live_home() const { return live_home_; }

  [[nodiscard]] bool is_low_latency() const { return low_latency_; }

  [[nodiscard]] bool is_resource_manager_required() const {
    return low_latency_ && mapping_policy_.resource_manager_required &&
           home_->mode == kungfu::yijinjing::enums::mode::LIVE;
  }

  [[nodiscard]] const journal::bus_ptr &get_bus() const { return bus_; }

  virtual journal::reader_ptr open_reader_to_subscribe();

  virtual journal::reader_ptr open_reader(const data::location_ptr &location, uint32_t dest_id);

  virtual journal::writer_ptr open_writer(uint32_t dest_id, uint64_t page_size = 0);

  virtual journal::writer_ptr open_writer_at(const data::location_ptr &location, uint32_t dest_id,
                                             uint64_t page_size = 0);

  journal::writer_ptr open_hookable_writer(uint32_t dest_id, const journal::writer_hook_ptr &hook,
                                           uint64_t page_size = 0);

  journal::writer_ptr open_hookable_writer_at(const data::location_ptr &location, uint32_t dest_id,
                                              const journal::writer_hook_ptr &hook, uint64_t page_size = 0);

  [[nodiscard]] nanomsg::url_factory_ptr get_url_factory() const { return url_factory_; }

  [[nodiscard]] publisher_ptr get_publisher() { return publisher_; }

  [[nodiscard]] observer_ptr get_observer() { return observer_; }

  void set_begin_time(int64_t begin_time) { begin_time_ = begin_time; }

  void update_seed(uint32_t seed);

protected:
  data::location_ptr home_;
  data::location_ptr live_home_;
  const bool low_latency_;
  const io_mapping_policy mapping_policy_;
  int64_t begin_time_;
  nanomsg::url_factory_ptr url_factory_;
  publisher_ptr publisher_;
  observer_ptr observer_;
  journal::bus_ptr bus_;
};

DECLARE_PTR(io_device)

class io_device_coordinator : public io_device {
public:
  io_device_coordinator(data::location_ptr home, bool low_latency);
};

DECLARE_PTR(io_device_coordinator)

class io_device_peer : public io_device {
public:
  io_device_peer(data::location_ptr home, bool low_latency);

  bool is_usable() override;

  bool setup() override;

  void cancel_usability_probe() override;

private:
  std::atomic<bool> usability_probe_cancelled_{false};
  std::mutex usability_probe_mutex_;
  std::condition_variable usability_probe_condition_;
  publisher_ptr usability_probe_publisher_;
  observer_ptr usability_probe_observer_;
};

DECLARE_PTR(io_device_peer)

void handle_sql_error(int rc, const std::string &error_tip);
void ensure_sqlite_initilize();
void ensure_sqlite_shutdown();
} // namespace kungfu::runtime
#endif // KUNGFU_IO_H
