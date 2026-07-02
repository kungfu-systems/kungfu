// SPDX-License-Identifier: Apache-2.0

//
// Created by Keren Dong on 2020/3/10.
//

#ifndef WINGCHUN_BROKER_H
#define WINGCHUN_BROKER_H

#include <kungfu/longfist/longfist.h>
#include <kungfu/wingchun/common.h>
#include <kungfu/yijinjing/io.h>
#include <kungfu/yijinjing/log.h>
#include <kungfu/yijinjing/practice/apprentice.h>

namespace kungfu::wingchun::broker {

FORWARD_DECLARE_CLASS_PTR(BrokerVendor)
FORWARD_DECLARE_CLASS_PTR(BrokerService)

class BrokerVendor : public practice::apprentice {
public:
  typedef yijinjing::data::locator_ptr locator_ptr;
  typedef yijinjing::data::location_ptr location_ptr;
  typedef longfist::enums::BrokerState BrokerState;

  BrokerVendor(const location_ptr &location, bool low_latency, const std::string &arguments);

  void on_exit() override;

  bool is_reactable(const event_ptr &event) override;

protected:
  virtual BrokerService_ptr get_service() = 0;

  void on_start() override;

private:
  void notify_broker_state();
};

class BrokerService {
public:
  typedef longfist::enums::BrokerState BrokerState;

  explicit BrokerService(BrokerVendor &vendor);

  virtual ~BrokerService() = default;

  virtual void pre_start();

  virtual void on_start();

  virtual void on_exit();

  [[nodiscard]] int64_t now() const;

  [[nodiscard]] BrokerState get_state();

  [[nodiscard]] std::string get_runtime_folder();

  [[nodiscard]] std::string get_config() const;

  [[nodiscard]] nlohmann::json get_kungfu_config() const;

  [[nodiscard]] longfist::types::RiskSetting get_risk_setting() const;

  [[nodiscard]] const yijinjing::data::location_ptr &get_home() const;

  [[nodiscard]] const yijinjing::data::location_ptr &get_live_home() const;

  [[nodiscard]] uint32_t get_home_uid() const;

  [[nodiscard]] uint32_t get_live_home_uid() const;

  [[nodiscard]] yijinjing::io_device_ptr get_io_device() const;

  [[nodiscard]] yijinjing::journal::writer_ptr get_writer(uint32_t dest_id) const;

  [[nodiscard]] yijinjing::journal::writer_ptr get_band_writer(uint32_t dest_id) const;

  [[nodiscard]] bool has_writer(uint32_t dest_id) const;

  [[nodiscard]] bool has_band_writer(uint32_t dest_id) const;

  [[nodiscard]] yijinjing::journal::writer_ptr &get_thread_writer(uint32_t page_size = 0);

  [[nodiscard]] yijinjing::journal::writer_ptr &get_public_writer();

  const rx::connectable_observable<event_ptr> &get_events() const;

  template <typename DataType>
  void write_to(const DataType &data, uint32_t dest_id = yijinjing::data::location::PUBLIC) {
    vendor_.write_to(now(), data, dest_id);
  }

  template <typename DataType>
  void try_write_to(
      const DataType &data, uint32_t dest_id = yijinjing::data::location::PUBLIC,
      const std::function<void()> &callback = []() {}) {
    vendor_.try_write_to(now(), data, dest_id, callback);
  }

  template <typename DataType>
  void try_write_raw_to(int64_t trigger_time, int32_t msg_type, const DataType &data, uint32_t length,
                        uint32_t dest_id = yijinjing::data::location::PUBLIC) {
    vendor_.try_write_raw_to(trigger_time, msg_type, data, length, dest_id);
  }

  [[nodiscard]] const cache::bank &get_state_bank() const;

  [[nodiscard]] bool check_if_stored_instruments(const std::string &trading_day) const;

  void record_stored_instruments_trading_day(const std::string &trading_day);

  [[nodiscard]] bool check_if_stored_baskets(const std::string &trading_day) const;

  void record_stored_baskets_trading_day(const std::string &trading_Day);

  int32_t add_timer(int64_t nanotime, const std::function<void(const event_ptr &)> &callback);

  int32_t add_time_interval(int64_t nanotime, const std::function<void(const event_ptr &)> &callback);

  void clear_timer(int32_t timer_id);

  void update_broker_state(BrokerState state);

  void request_deregister() { vendor_.request_deregister(); }

  [[nodiscard]] BrokerVendor &get_vendor() const { return vendor_; }

  uint32_t request_band(const std::string &band_name, uint64_t page_size = 0) {
    return vendor_.request_band(band_name, page_size);
  }

  virtual void on_arguments(const std::string &argument) {}

  virtual bool on_custom_event(const event_ptr &event) { return true; }

protected:
  volatile BrokerState state_;

private:
  BrokerVendor &vendor_;
};

} // namespace kungfu::wingchun::broker

#endif // WINGCHUN_BROKER_H
