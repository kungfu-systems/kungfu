// SPDX-License-Identifier: Apache-2.0

//
// Created by Keren Dong on 2020/3/10.
//

#include <fstream>
#include <kungfu/common.h>
#include <kungfu/wingchun/broker/broker.h>
#include <kungfu/yijinjing/time.h>
#include <utility>

using namespace kungfu::rx;
using namespace kungfu::longfist::enums;
using namespace kungfu::longfist::types;
using namespace kungfu::practice;
using namespace kungfu::yijinjing;
using namespace kungfu::yijinjing::data;
using namespace kungfu::yijinjing::journal;

namespace kungfu::wingchun::broker {
BrokerVendor::BrokerVendor(const location_ptr &location, bool low_latency, const std::string &arguments)
    : apprentice(location, low_latency, arguments) {}

void BrokerVendor::on_start() {
  events_ | is(RequestWriteTo::tag, RequestReadFrom::tag, RequestReadFromPublic::tag, RequestReadFromSync::tag) |
      $$(notify_broker_state());
}

void BrokerVendor::on_exit() {
  auto service = get_service();
  service->on_exit();
}

void BrokerVendor::notify_broker_state() {
  auto service = get_service();
  service->update_broker_state(service->get_state());
}

bool BrokerVendor::is_reactable(const event_ptr &event) {
  if (is_custom_event(event)) {
    get_service()->on_custom_event(event);
    return false;
  }
  return true;
}

BrokerService::BrokerService(BrokerVendor &vendor) : vendor_(vendor), state_(BrokerState::Pending) {}

void BrokerService::pre_start() {}

void BrokerService::on_start() {}

void BrokerService::on_exit() {}

int64_t BrokerService::now() const { return vendor_.now(); }

BrokerState BrokerService::get_state() { return state_; }

std::string BrokerService::get_config() const {
  auto &config_map = get_state_bank()[boost::hana::type_c<Config>];
  if (config_map.find(get_live_home_uid()) == config_map.end()) {
    return "{}";
  }
  auto &config_obj = config_map.at(get_live_home_uid());
  return config_obj.data.value;
}

nlohmann::json BrokerService::get_kungfu_config() const {
  char *ext_dirs = std::getenv("EXTENSION_DIRS");
  if (ext_dirs != nullptr) {
    std::string ext_dirs_string(ext_dirs);
    std::string item;
    SPDLOG_INFO(" EXTENSION_DIRS = {} ", ext_dirs);
    std::stringstream ext_dirs_stringstream(ext_dirs_string);
#if (defined(_WIN32) || defined(_WIN64))
    while (std::getline(ext_dirs_stringstream, item, ';')) {
#else
    while (std::getline(ext_dirs_stringstream, item, ':')) {
#endif
      const std::string path = fmt::format("{}/{}/package.json", item, get_home()->group);
      if (std::filesystem::exists(path)) {
        std::ifstream f(path);
        nlohmann::json data = nlohmann::json::parse(f);
        if (data.contains("kungfuConfig") and data["kungfuConfig"].contains("config")) {
          return data["kungfuConfig"]["config"];
        }
      }
    }
  }
  return nlohmann::json::parse("{}");
}

RiskSetting BrokerService::get_risk_setting() const {
  auto &risk_setting_map = get_state_bank()[boost::hana::type_c<RiskSetting>];
  if (risk_setting_map.find(get_live_home_uid()) == risk_setting_map.end()) {
    return get_home()->to<RiskSetting>();
  }
  auto &risk_setting_obj = risk_setting_map.at(get_live_home_uid());
  return risk_setting_obj.data;
}

std::string BrokerService::get_runtime_folder() {
  return vendor_.get_locator()->layout_dir(get_live_home(), layout::LOG);
}

const location_ptr &BrokerService::get_home() const { return vendor_.get_home(); }

const location_ptr &BrokerService::get_live_home() const { return vendor_.get_live_home(); }

uint32_t BrokerService::get_home_uid() const { return vendor_.get_home_uid(); }

uint32_t BrokerService::get_live_home_uid() const { return vendor_.get_live_home_uid(); }

writer_ptr BrokerService::get_writer(uint32_t dest_id) const { return vendor_.get_writer(dest_id); }

bool BrokerService::has_writer(uint32_t dest_id) const { return vendor_.has_writer(dest_id); }

yijinjing::journal::writer_ptr BrokerService::get_band_writer(uint32_t dest_id) const {
  return vendor_.get_band_writer(dest_id);
}

bool BrokerService::has_band_writer(uint32_t dest_id) const { return vendor_.has_band_writer(dest_id); }

const cache::bank &BrokerService::get_state_bank() const { return vendor_.get_state_bank(); }

bool BrokerService::check_if_stored_instruments(const std::string &trading_day) const {
  SPDLOG_INFO("CHECK_IF_STORED_INSTRUMENTS trading_day {}", trading_day);
  auto &time_key_value_map = get_state_bank()[boost::hana::type_c<TimeKeyValue>];
  return std::any_of(time_key_value_map.begin(), time_key_value_map.end(), [&](const auto &pair) {
    const TimeKeyValue &timeKeyValue = pair.second.data;
    return (timeKeyValue.key == "instrument_stored_trading_day" ||
            timeKeyValue.key == "instrument_stored_trading_day_next_day") and
           (timeKeyValue.value == trading_day);
  });
}

void BrokerService::record_stored_instruments_trading_day(const std::string &trading_day) {
  if (not get_public_writer()) {
    SPDLOG_ERROR("has no writer for PUBLIC: {:8x}:{}", location::PUBLIC,
                 get_vendor().get_location_uname(location::PUBLIC));
  }
  TimeKeyValue instrument_stored_trading_day_tkv = {};
  instrument_stored_trading_day_tkv.update_time = now();
  instrument_stored_trading_day_tkv.key = "instrument_stored_trading_day";
  instrument_stored_trading_day_tkv.value = trading_day;
  get_public_writer()->write(now(), instrument_stored_trading_day_tkv);

  // 为了解决夜盘的问题
  TimeKeyValue instrument_stored_trading_day_next_day_tkv = {};
  instrument_stored_trading_day_next_day_tkv.update_time = yijinjing::time::next_trading_day_end(now());
  instrument_stored_trading_day_next_day_tkv.key = "instrument_stored_trading_day_next_day";
  instrument_stored_trading_day_next_day_tkv.value = trading_day;
  get_public_writer()->write(now(), instrument_stored_trading_day_next_day_tkv);

  SPDLOG_INFO("STORED_INSTRUMENT_TRADING_DAY {}", trading_day);
}

bool BrokerService::check_if_stored_baskets(const std::string &trading_day) const {
  SPDLOG_INFO("CHECK_IF_STORED_BASKETS trading_day {}", trading_day);
  auto &time_key_value_map = get_state_bank()[boost::hana::type_c<TimeKeyValue>];
  return std::any_of(time_key_value_map.begin(), time_key_value_map.end(), [&](const auto &pair) {
    return pair.second.data.key == "basket_stored_trading_day" and pair.second.data.value == trading_day;
  });
}

void BrokerService::record_stored_baskets_trading_day(const std::string &trading_day) {
  if (not get_public_writer()) {
    SPDLOG_ERROR("has no writer for PUBLIC: {:8x}:{}", location::PUBLIC,
                 get_vendor().get_location_uname(location::PUBLIC));
  }
  TimeKeyValue basket_stored_trading_day_tkv = {};
  basket_stored_trading_day_tkv.update_time = now();
  basket_stored_trading_day_tkv.key = "basket_stored_trading_day";
  basket_stored_trading_day_tkv.value = trading_day;
  get_public_writer()->write(now(), basket_stored_trading_day_tkv);

  SPDLOG_INFO("STORED_BASKET_TRADING_DAY {}", trading_day);
}

int32_t BrokerService::add_timer(int64_t nanotime, const std::function<void(const event_ptr &)> &callback) {
  return vendor_.add_timer(nanotime, callback);
}

int32_t BrokerService::add_time_interval(int64_t nanotime, const std::function<void(const event_ptr &)> &callback) {
  return vendor_.add_time_interval(nanotime, callback);
}

void BrokerService::clear_timer(int32_t timer_id) { vendor_.clear_timer(timer_id); }

void BrokerService::update_broker_state(BrokerState state) {
  state_ = state;
  if (not get_public_writer()) {
    SPDLOG_ERROR("has no writer for PUBLIC: {:8x}:{}", location::PUBLIC,
                 get_vendor().get_location_uname(location::PUBLIC));
  }
  BrokerStateUpdate &broker_state = get_public_writer()->open_data<BrokerStateUpdate>();
  broker_state.state = state_;
  broker_state.location_uid = get_live_home_uid();
  get_public_writer()->close_data();
}

yijinjing::io_device_ptr BrokerService::get_io_device() const { return get_vendor().get_io_device(); }

writer_ptr &BrokerService::get_thread_writer(uint32_t page_size) { return vendor_.get_thread_writer(page_size); }

writer_ptr &BrokerService::get_public_writer() { return vendor_.get_public_writer(); }

const rx::connectable_observable<event_ptr> &BrokerService::get_events() const { return vendor_.get_events(); }

} // namespace kungfu::wingchun::broker
