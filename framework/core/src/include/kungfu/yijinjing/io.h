// SPDX-License-Identifier: Apache-2.0

//
// Created by Keren Dong on 2019-06-01.
//

#ifndef KUNGFU_IO_H
#define KUNGFU_IO_H

#include <kungfu/yijinjing/journal/journal.h>
#include <kungfu/yijinjing/nanomsg/socket.h>

namespace kungfu::yijinjing {
namespace journal {
// defined in typed_frame_dump.cpp: installs the full-registry raw-payload
// dumper into the core frame's to_string seam (idempotent)
void install_typed_frame_dumper();
} // namespace journal

FORWARD_DECLARE_CLASS_PTR(session)

#define SETUP_TIMEOUT 50
#define TEST_USABLE_TIMEOUT 500
#define DEFAULT_RECV_TIMEOUT 100
#define DEFAULT_NOTICE_TIMEOUT 1000
#define REGISTER_TIMEOUT_SECONDS 60

class io_device : public resource {
public:
  io_device(data::location_ptr home, bool low_latency, bool lazy);

  ~io_device() override = default;

  bool is_usable() override { return publisher_ and observer_ and publisher_->is_usable() and observer_->is_usable(); }

  [[nodiscard]] bool is_lazy() const { return lazy_; }

  bool setup() override {
    bool prc = publisher_->setup();
    bool orc = observer_->setup();
    return prc && orc;
  }

  [[nodiscard]] const data::locator_ptr &get_locator() const { return home_->locator; }

  [[nodiscard]] const data::location_ptr &get_home() const { return home_; }

  [[nodiscard]] const data::location_ptr &get_live_home() const { return live_home_; }

  [[nodiscard]] bool is_low_latency() const { return low_latency_; }

  [[nodiscard]] bool is_resource_manager_required() const {
    return low_latency_ && lazy_ && home_->mode == kungfu::longfist::enums::mode::LIVE;
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
  const bool lazy_;
  int64_t begin_time_;
  nanomsg::url_factory_ptr url_factory_;
  publisher_ptr publisher_;
  observer_ptr observer_;
  journal::bus_ptr bus_;
};

DECLARE_PTR(io_device)

class io_device_master : public io_device {
public:
  io_device_master(data::location_ptr home, bool low_latency);
};

DECLARE_PTR(io_device_master)

class io_device_client : public io_device {
public:
  io_device_client(data::location_ptr home, bool low_latency);

  bool is_usable() override;

  bool setup() override;
};

DECLARE_PTR(io_device_client)

class io_device_console : public io_device {
public:
  io_device_console(data::location_ptr home, int32_t console_width, int32_t console_height);

  void trace(int64_t begin_time, int64_t end_time, bool in, bool out, std::string csv);

  void show(int64_t begin_time, int64_t end_time, bool in, bool out, std::string csv);

private:
  int32_t console_width_;
  int32_t console_height_;
};

DECLARE_PTR(io_device_console)

void handle_sql_error(int rc, const std::string &error_tip);
void ensure_sqlite_initilize();
void ensure_sqlite_shutdown();
} // namespace kungfu::yijinjing
#endif // KUNGFU_IO_H
