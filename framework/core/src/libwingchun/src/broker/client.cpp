// SPDX-License-Identifier: Apache-2.0

//
// Created by Keren Dong on 2020/3/12.
//

#include <kungfu/wingchun/broker/client.h>

using namespace kungfu::rx;
using namespace kungfu::longfist::types;
using namespace kungfu::longfist::enums;
using namespace kungfu::practice;
using namespace kungfu::yijinjing;
using namespace kungfu::yijinjing::data;

namespace kungfu::wingchun::broker {
int64_t ResumePolicy::get_connect_time(const apprentice &app, const Register &target) const {
  auto target_checkin_time = target.checkin_time;
  auto target_checkin_time_str = yijinjing::time::strftime(target_checkin_time);
  if (app.get_last_active_time() == INT64_MIN) {
    SPDLOG_DEBUG("app has no previous session, connect from target checkin_time {}", target_checkin_time_str);
    return target_checkin_time;
  }

  if (target.checkin_time >= app.get_checkin_time() and target.last_active_time >= app.get_checkin_time()) {
    SPDLOG_DEBUG("CASE [1] target:     ======    =====");
    SPDLOG_DEBUG("         strategy:   ===============");
    SPDLOG_DEBUG("connect from target checkin time {}", target_checkin_time_str);
    return target_checkin_time;
  }

  if (target.checkin_time >= app.get_checkin_time() and target.last_active_time <= app.get_last_active_time()) {
    SPDLOG_DEBUG("CASE[2] target:     ====       ======");
    SPDLOG_DEBUG("        strategy:   ======   ========");
    SPDLOG_DEBUG("connect from target checkin time {}", target_checkin_time_str);
    return target_checkin_time;
  }

  return get_resume_time(app, target);
}

int64_t StatelessResumePolicy::get_resume_time(const apprentice &app, const Register &target) const {
  auto resume_time = target.checkin_time;
  SPDLOG_DEBUG("Stateless resume policy, connect from target checkin_time {}", yijinjing::time::strftime(resume_time));
  return resume_time;
}

int64_t ContinuousResumePolicy::get_resume_time(const apprentice &app, const Register &target) const {
  auto resume_time = app.get_last_active_time();
  SPDLOG_DEBUG("Continuous resume policy, connect from app last_active_time {}", yijinjing::time::strftime(resume_time));
  return resume_time;
}

int64_t IntradayResumePolicy::get_resume_time(const apprentice &app, const Register &target) const {
  auto resume_time = std::max(app.get_last_active_time(), yijinjing::time::calendar_day_start(app.now()));
  SPDLOG_DEBUG("Intraday resume policy, connect from max(app last_active_time, today_start) {}",
               yijinjing::time::strftime(resume_time));
  return resume_time;
}

int64_t FromNowResumePolicy::get_connect_time(const apprentice &app, const Register &target) const {
  if (target.checkin_time >= app.get_checkin_time()) {
    SPDLOG_DEBUG("case[0] target started later than current, connect from target checkin_time {}",
                 yijinjing::time::strftime(target.checkin_time));
    return target.checkin_time;
  }
  return get_resume_time(app, target);
}

int64_t FromNowResumePolicy::get_resume_time(const apprentice &app, const Register &target) const {
  SPDLOG_DEBUG("From now resume policy, connect from now {}", yijinjing::time::strftime(app.now()));
  return app.now();
}

Client::Client(apprentice &app) : app_(app) {}

const Client::InstrumentKeyMap &Client::get_instrument_keys() const { return instrument_keys_; }

bool Client::is_ready(uint32_t app_location_uid) const {
  if (app_.has_location(app_location_uid)) {
    auto app_location = app_.get_location(app_location_uid);
    switch (app_location->category) {
    case longfist::enums::category::MD:
      return ready_md_locations_.find(app_location->uid) != ready_md_locations_.end() and
             app_.has_writer(app_location_uid);
    case longfist::enums::category::TD:
      return ready_td_locations_.find(app_location->uid) != ready_td_locations_.end() and
             app_.has_writer(app_location_uid);
    case longfist::enums::category::OPERATOR:
      return ready_op_locations_.find(app_location->uid) != ready_op_locations_.end();
    default:
      return false;
    }
  }
  return false;
}

bool Client::is_connected(uint32_t app_location_uid) const {
  if (app_.has_location(app_location_uid) and app_.has_writer(app_location_uid)) {
    return true;
  }
  return false;
}

bool Client::is_subscribed(const std::string &exchange_id, const std::string &instrument_id) const {
  return instrument_keys_.find(hash_instrument(exchange_id.c_str(), instrument_id.c_str())) != instrument_keys_.end();
}

void Client::subscribe(const InstrumentKey &instrument_key) {
  instrument_keys_.emplace(instrument_key.key, instrument_key);
}

void Client::unsubscribe(const InstrumentKey &instrument_key) { instrument_keys_.erase(instrument_key.key); }

void Client::subscribe(const std::string &exchange_id, const std::string &instrument_id) {
  uint32_t key = hash_instrument(exchange_id.c_str(), instrument_id.c_str());
  if (instrument_keys_.find(key) != instrument_keys_.end()) {
    return;
  }
  InstrumentKey instrument_key = {};
  instrument_key.key = key;
  kungfu::copy_string(instrument_key.instrument_id, instrument_id.c_str());
  kungfu::copy_string(instrument_key.exchange_id, exchange_id.c_str());
  instrument_key.instrument_type = get_instrument_type(exchange_id, instrument_id);
  subscribe(instrument_key);
}

void Client::unsubscribe(const std::string &exchange_id, const std::string &instrument_id) {
  uint32_t key = hash_instrument(exchange_id.c_str(), instrument_id.c_str());
  instrument_keys_.erase(key);
}

void Client::subscribe(const location_ptr &md_location, const std::string &exchange_id,
                       const std::string &instrument_id) {
  subscribe(exchange_id, instrument_id);
  exchange_md_locations_.emplace(exchange_id, md_location);
  instrument_md_locations_.emplace(hash_instrument(exchange_id.c_str(), instrument_id.c_str()), md_location);
}

void Client::renew(int64_t trigger_time, const location_ptr &md_location) {
  auto writer = app_.get_writer(md_location->uid);
  for (const auto &pair : instrument_keys_) {
    auto &instrument_key = pair.second;
    location_ptr source_location = {};
    if (exchange_md_locations_.find(instrument_key.exchange_id) != exchange_md_locations_.end()) {
      source_location = exchange_md_locations_.at(instrument_key.exchange_id);
    }
    if (instrument_md_locations_.find(instrument_key.key) != instrument_md_locations_.end()) {
      source_location = instrument_md_locations_.at(instrument_key.key);
    }
    if (source_location and md_location->uid == source_location->uid) {
      writer->write(trigger_time, instrument_key);
    }
  }
}

bool Client::try_renew(int64_t trigger_time, const location_ptr &md_location) {
  if (ready_md_locations_.find(md_location->uid) == ready_md_locations_.end()) {
    return false;
  }
  renew(trigger_time, md_location);
  return true;
}

void Client::sync(int64_t trigger_time, const yijinjing::data::location_ptr &td_location) {
  auto writer = app_.get_writer(td_location->uid);
  writer->mark(trigger_time, AssetRequest::tag);
  writer->mark(trigger_time, PositionRequest::tag);
}

bool Client::try_sync(int64_t trigger_time, const location_ptr &td_location) {
  if (ready_td_locations_.find(td_location->uid) == ready_td_locations_.end()) {
    return false;
  }
  sync(trigger_time, td_location);
  return true;
}

void Client::on_start(const rx::connectable_observable<event_ptr> &events) {
  events | is(Register::tag) | $$(connect(event, event->data<Register>()));
  events | is(Band::tag) | $$(connect(event, event->data<Band>()));
  events | is(BrokerStateUpdate::tag) | $$(update_app_state(event, event->data<BrokerStateUpdate>()));
  events | is(OperatorStateUpdate::tag) | $$(update_app_state(event, event->data<OperatorStateUpdate>()));
  events | is(Deregister::tag) | $$(on_deregister(event->data<Deregister>()));
}

void Client::connect(const event_ptr &event, const Register &register_data) {
  auto app_uid = register_data.location_uid;
  auto app_location = app_.get_location(app_uid);
  SPDLOG_DEBUG("register {}", app_location->uname);

  if (app_location->category == category::MD and should_connect_md(app_location)) {
    auto resume_time_point = get_resume_policy()->get_connect_time(app_, register_data);
    app_.request_write_to(app_.now(), app_uid);
    app_.request_read_from_public(app_.now(), app_uid, resume_time_point);
    SPDLOG_INFO("resume {} connection from {}", app_location->uname, yijinjing::time::strftime(resume_time_point));
  }
  if (app_location->category == category::TD and should_connect_td(app_location)) {
    auto resume_time_point = get_resume_policy()->get_connect_time(app_, register_data);
    app_.request_write_to(app_.now(), app_uid);
    app_.request_read_from(app_.now(), app_uid, resume_time_point);
    app_.request_read_from_public(app_.now(), app_uid, resume_time_point);
    app_.request_read_from_sync(app_.now(), app_uid, resume_time_point);
    SPDLOG_INFO("resume {} connection from {}", app_location->uname, yijinjing::time::strftime(resume_time_point));
  }
  if (app_location->category == category::STRATEGY and should_connect_strategy(app_location)) {
    auto resume_time_point = get_resume_policy()->get_connect_time(app_, register_data);
    app_.request_write_to(app_.now(), app_location->uid);
    app_.request_read_from(app_.now(), app_location->uid, resume_time_point);
    app_.request_read_from_public(app_.now(), app_location->uid, resume_time_point);
    SPDLOG_INFO("resume {} connection from {}", app_location->uname, yijinjing::time::strftime(resume_time_point));
  }
  if (app_location->category == category::OPERATOR and should_connect_operator(app_location)) {
    auto resume_time_point = get_resume_policy()->get_connect_time(app_, register_data);
    if (app_.get_home()->category == category::SYSTEM or app_.get_home()->category == category::MD) {
      app_.request_write_to(app_.now(), app_location->uid);
      app_.request_read_from(app_.now(), app_location->uid, resume_time_point);
    }
    app_.request_read_from_public(app_.now(), app_location->uid, resume_time_point);
    SPDLOG_INFO("resume {} connection from {}", app_location->uname, yijinjing::time::strftime(resume_time_point));
  }
}

void Client::connect(const event_ptr &event, const Band &band) {
  auto source_id = band.source_id;
  auto dest_id = band.dest_id;
  auto source_location = app_.get_location(source_id);
  if (source_location->category == category::MD and should_connect_md(source_location)) {
    SPDLOG_INFO("resume band from source {} {} to dest {} {}", source_id, app_.get_location_uname(source_id), dest_id,
                app_.get_location_uname(dest_id));
    app_.request_read_from_source_to_dest(event->gen_time(), source_location, dest_id);
  }
  if (source_location->category == category::OPERATOR and should_connect_operator(source_location)) {
    SPDLOG_INFO("resume band from source {} {} to dest {} {}", source_id, app_.get_location_uname(source_id), dest_id,
                app_.get_location_uname(dest_id));
    app_.request_read_from_source_to_dest(event->gen_time(), source_location, dest_id);
  }
}

void Client::on_deregister(const longfist::types::Deregister &deregister_data) {
  auto app_uid = deregister_data.location_uid;
  auto app_location = app_.get_location(app_uid);

  if (app_location->category == category::MD or app_location->category == category::TD) {
    broker_states_.emplace(app_uid, BrokerState::DisConnected);
    ready_md_locations_.erase(app_uid);
    ready_td_locations_.erase(app_uid);
  } else if (app_location->category == category::OPERATOR) {
    operator_states_.emplace(app_uid, OperatorState::DisConnected);
    ready_op_locations_.erase(app_uid);
  }
}

AutoClient::AutoClient(apprentice &app) : Client(app) {}

ResumePolicy_ptr AutoClient::get_resume_policy() const { return std::make_shared<FromNowResumePolicy>(); }

bool AutoClient::is_custom_subscribed(uint32_t md_location_uid) const { return false; }

bool AutoClient::is_custom_subscribed_all(uint32_t md_location_uid,
                                          kungfu::longfist::enums::SubscribeDataType data_type,
                                          const std::string &exchange, InstrumentType kf_instrument_type) const {
  return false;
}

bool AutoClient::is_all_subscribed(uint32_t md_location_uid) const { return false; }

bool AutoClient::should_connect_md(const location_ptr &md_location) const { return true; }

bool AutoClient::should_connect_td(const location_ptr &td_location) const { return true; }

bool AutoClient::should_connect_md(uint32_t md_location_uid) const { return true; }

bool AutoClient::should_connect_td(uint32_t td_location_uid) const { return true; }

bool AutoClient::should_connect_operator(const location_ptr &op_location) const { return true; }

bool AutoClient::should_connect_operator(uint32_t op_location_uid) const { return true; }

bool AutoClient::should_connect_strategy(const location_ptr &strategy_location) const { return true; }

bool AutoClient::should_connect_system(const location_ptr &system_location) const { return false; }

SilentAutoClient::SilentAutoClient(practice::apprentice &app) : AutoClient(app) {}

void SilentAutoClient::renew(int64_t trigger_time, const location_ptr &md_location) {}

void SilentAutoClient::sync(int64_t trigger_time, const location_ptr &td_location) {}

PassiveClient::PassiveClient(apprentice &app) : Client(app) {}

ResumePolicy_ptr PassiveClient::get_resume_policy() const {
  switch (resume_policy_) {
  case longfist::enums::ResumePolicy::Now:
    return std::make_shared<FromNowResumePolicy>();
  case longfist::enums::ResumePolicy::Stateless:
    return std::make_shared<StatelessResumePolicy>();
  case longfist::enums::ResumePolicy::Continuous:
    return std::make_shared<ContinuousResumePolicy>();
  case longfist::enums::ResumePolicy::Intraday:
    return std::make_shared<IntradayResumePolicy>();
  default:
    return std::make_shared<FromNowResumePolicy>();
  }
}

longfist::enums::ResumePolicy PassiveClient::get_resume_policy_value() const { return resume_policy_; }

bool PassiveClient::is_custom_subscribed(uint32_t md_location_uid) const {
  return should_connect_md(app_.get_location(md_location_uid)) and enrolled_md_custom_info_.at(md_location_uid);
}

bool PassiveClient::is_custom_subscribed_all(uint32_t md_location_uid,
                                             kungfu::longfist::enums::SubscribeDataType data_type,
                                             const std::string &exchange_id, InstrumentType kf_instrument_type) const {
  if (is_custom_subscribed(md_location_uid)) {
    const auto &custom_sub = custom_subs_.at(md_location_uid);
    SubscribeInstrumentType custom_type = instrument_type_to_subscribe_instrument_type(kf_instrument_type);

    for (const auto &it : custom_sub) {
      const std::string custom_exchange = exchange_id_from_market_type(it.market_type);
      if ((it.data_type == SubscribeDataType::All or (uint64_t(it.data_type) & uint64_t(data_type)) != 0) and
          (custom_exchange.empty() || custom_exchange == exchange_id) and
          (it.instrument_type == SubscribeInstrumentType::All or
           (uint64_t(custom_type) & uint64_t(it.instrument_type)) != 0)) {
        /// using & operator because it.instrument_type maybe InstrumentType::Stock | InstrumentType::Future
        return true;
      }
    }
  }
  return false;
}

bool PassiveClient::enrolled_operator_ready() const {
  return std::all_of(enrolled_op_locations_.begin(), enrolled_op_locations_.end(),
                     [this](const auto &it) { return is_ready(it.first); });
}

bool PassiveClient::enrolled_md_ready() const {
  return std::all_of(enrolled_md_locations_.begin(), enrolled_md_locations_.end(),
                     [this](const auto &it) { return is_ready(it.first); });
}

bool PassiveClient::enrolled_td_ready() const {
  return std::all_of(enrolled_td_locations_.begin(), enrolled_td_locations_.end(),
                     [this](const auto &it) { return is_ready(it.first); });
}

bool PassiveClient::enrolled_operator_connected() const {
  return std::all_of(enrolled_op_locations_.begin(), enrolled_op_locations_.end(),
                     [this](const auto &it) { return app_.has_location(it.first); });
}

bool PassiveClient::enrolled_md_connected() const {
  return std::all_of(enrolled_md_locations_.begin(), enrolled_md_locations_.end(),
                     [this](const auto &it) { return is_connected(it.first); });
}

bool PassiveClient::enrolled_td_connected() const {
  return std::all_of(enrolled_td_locations_.begin(), enrolled_td_locations_.end(),
                     [this](const auto &it) { return is_connected(it.first); });
}

bool PassiveClient::has_enrolled_td_channel(uint32_t home_uid) const {
  return std::all_of(enrolled_td_locations_.begin(), enrolled_td_locations_.end(), [this, home_uid](const auto &it) {
    return has_channel(home_uid, it.first) and has_channel(it.first, home_uid);
  });
}

const PassiveClient::EnrolledLocationMap &PassiveClient::get_enrolled_md_locations() const {
  return enrolled_md_locations_;
}

const PassiveClient::EnrolledLocationMap &PassiveClient::get_enrolled_td_locations() const {
  return enrolled_td_locations_;
}

const PassiveClient::EnrolledLocationMap &PassiveClient::get_enrolled_op_locations() const {
  return enrolled_op_locations_;
}

uint32_t PassiveClient::get_td_location_uid(const std::string &source, const std::string &account) const {
  uint32_t hashed_account = hash_account(source, account);
  if (enrolled_hash_td_locations_.find(hashed_account) == enrolled_hash_td_locations_.end()) {
    SPDLOG_ERROR(fmt::format("invalid account {}_{}", source, account));
    throw wingchun_error(fmt::format("invalid account {}_{}", source, account));
  }

  return enrolled_hash_td_locations_.at(hashed_account)->uid;
}

const yijinjing::data::location_ptr &PassiveClient::find_md_location(const std::string &source,
                                                                     const location_ptr &home) {
  if (str_key_md_locations_.find(source) == str_key_md_locations_.end()) {
    auto md_location = location::make_shared(mode::LIVE, category::MD, source, source, home->locator);
    if (not app_.has_location(md_location->uid)) {
      SPDLOG_ERROR(fmt::format("invalid md {}", source));
      throw wingchun_error(fmt::format("invalid md {}", source));
    }

    str_key_md_locations_.emplace(source, md_location);
  }
  return str_key_md_locations_.at(source);
}

bool PassiveClient::is_all_subscribed(uint32_t md_location_uid) const {
  if (should_connect_md(app_.get_location(md_location_uid))) {
    const auto &custom_sub = custom_subs_.at(md_location_uid);
    return std::any_of(custom_sub.begin(), custom_sub.end(), [](const auto &it) {
      return it.market_type == MarketType::All and it.instrument_type == SubscribeInstrumentType::All and
             it.data_type == SubscribeDataType::All;
    });
  }
  return false;
}

void PassiveClient::subscribe(const location_ptr &md_location, const std::string &exchange_id,
                              const std::string &instrument_id) {
  if (not is_custom_subscribed(md_location->uid)) {
    enroll_md(md_location, false);
  }
  Client::subscribe(md_location, exchange_id, instrument_id);
}

void PassiveClient::subscribe_all(const location_ptr &md_location, uint8_t market_type, uint64_t instrument_type,
                                  uint64_t data_type) {
  enroll_md(md_location, true);
  CustomSubscribe custrom_sub = {};
  custrom_sub.market_type = MarketType(market_type);
  custrom_sub.instrument_type = SubscribeInstrumentType(instrument_type);
  custrom_sub.data_type = SubscribeDataType(data_type);
  if (custom_subs_.find(md_location->uid) == custom_subs_.end()) {
    custom_subs_.emplace(md_location->uid, std::vector<CustomSubscribe>{});
  }
  custom_subs_[md_location->uid].push_back(custrom_sub);
}

void PassiveClient::renew(int64_t trigger_time, const location_ptr &md_location) {
  if (is_custom_subscribed(md_location->uid)) {
    const auto &custrom_sub = custom_subs_.at(md_location->uid);
    for (auto it : custrom_sub) {
      auto writer = app_.get_writer(md_location->uid);
      writer->write(trigger_time, it);
    }
  } else {
    Client::renew(trigger_time, md_location);
  }
}

void PassiveClient::sync(int64_t trigger_time, const location_ptr &td_location) {}

void PassiveClient::enroll_td(const location_ptr &td_location) {
  enrolled_td_locations_.emplace(td_location->uid, td_location);
  uint32_t hashed_account = hash_account(td_location->group, td_location->name);
  enrolled_hash_td_locations_.emplace(hashed_account, td_location);
}

void PassiveClient::enroll_md(const location_ptr &md_location, bool is_custom_subscribe) {
  enrolled_md_locations_.emplace(md_location->uid, md_location);
  enrolled_md_custom_info_.emplace(md_location->uid, is_custom_subscribe);
}

void PassiveClient::enroll_operator(const location_ptr &op_location) {
  enrolled_op_locations_.emplace(op_location->uid, op_location);
}

bool PassiveClient::should_connect_md(const location_ptr &md_location) const {
  return enrolled_md_locations_.find(md_location->uid) != enrolled_md_locations_.end();
}

bool PassiveClient::should_connect_md(uint32_t md_location_uid) const {
  return enrolled_md_locations_.find(md_location_uid) != enrolled_md_locations_.end();
}

bool PassiveClient::should_connect_td(const location_ptr &td_location) const {
  return enrolled_td_locations_.find(td_location->uid) != enrolled_td_locations_.end();
}

bool PassiveClient::should_connect_td(uint32_t td_location_uid) const {
  return enrolled_td_locations_.find(td_location_uid) != enrolled_td_locations_.end();
}

bool PassiveClient::should_connect_operator(const location_ptr &op_location) const {
  return enrolled_op_locations_.find(op_location->uid) != enrolled_op_locations_.end();
}

bool PassiveClient::should_connect_operator(uint32_t op_location_uid) const {
  return enrolled_op_locations_.find(op_location_uid) != enrolled_op_locations_.end();
}

bool PassiveClient::should_connect_strategy(const location_ptr &strategy_location) const { return false; }

bool PassiveClient::should_connect_system(const location_ptr &system_location) const { return false; };

void PassiveClient::set_resume_policy(longfist::enums::ResumePolicy resume_policy) { resume_policy_ = resume_policy; }

longfist::enums::ResumePolicy PassiveClient::get_resume_policy() { return resume_policy_; }
} // namespace kungfu::wingchun::broker
