// SPDX-License-Identifier: Apache-2.0

#include <fmt/format.h>

#include <kungfu/wingchun/operator/live.h>
#include <kungfu/yijinjing/log.h>
#include <kungfu/yijinjing/time.h>

using namespace kungfu::practice;
using namespace kungfu::rx;
using namespace kungfu::longfist;
using namespace kungfu::longfist::types;
using namespace kungfu::longfist::enums;
using namespace kungfu::yijinjing;
using namespace kungfu::yijinjing::data;
using namespace kungfu::yijinjing::util;
using namespace kungfu::wingchun::factor;

namespace kungfu::wingchun::op {

std::shared_ptr<LiveStreamDataBatcher> LiveContext::live_stream_data_batcher_ = nullptr;

LiveContext::LiveContext(apprentice &app, const rx::connectable_observable<event_ptr> &events)
    : Context(app, events), broker_client_(app_), bookkeeper_(app_, broker_client_) {
  KUNGFU_SETUP_LOGGER(app_.get_home(), app_.get_home()->name);
}

void LiveContext::on_start() {
  broker_client_.on_start(events_);
  bookkeeper_.on_start(events_);

  auto start_events = events_ | skip_until(events_ | filter([&](auto e) { return started_; }));
  start_events | is(Deregister::tag) | $$(check_dependency_state(event));
  start_events | is(OperatorStateUpdate::tag) | $$(check_dependency_state(event));
  start_events | is(BrokerStateUpdate::tag) | $$(check_dependency_state(event));
}

bool LiveContext::is_started() const { return started_; }

void LiveContext::prepare(const event_ptr &event) {
  auto ledger_uid = app_.get_ledger_home_location()->uid;
  if (not app_.has_writer(ledger_uid)) {
    SPDLOG_TRACE("ledger writer not found");
    return;
  }
  auto writer = app_.get_writer(ledger_uid);

  if (not broker_states_requested_ and broker_client_.enrolled_md_connected() and
      broker_client_.enrolled_operator_connected()) {
    writer->mark(now(), BrokerStateRequest::tag);
    writer->mark(now(), OperatorStateRequest::tag);
    broker_states_requested_ = true;
  }

  if (not broker_client_.enrolled_md_ready() or not broker_client_.enrolled_operator_ready()) {
    return;
  }
  started_ = true;

  OperatorStateUpdate state_update;
  state_update.state = OperatorState::Ready;
  update_operator_state(state_update);
}

const std::string LiveContext::get_config() const {
  auto &config_map = app_.get_state_bank()[boost::hana::type_c<Config>];
  if (config_map.find(app_.get_live_home_uid()) == config_map.end()) {
    return "{}";
  }
  auto &config_obj = config_map.at(app_.get_live_home_uid());
  return config_obj.data.value;
}

int64_t LiveContext::now() const { return app_.now(); }

int32_t LiveContext::add_timer(int64_t nanotime, const std::function<void(event_ptr)> &callback) {
  return app_.add_timer(nanotime, callback);
}

int32_t LiveContext::add_time_interval(int64_t duration, const std::function<void(event_ptr)> &callback) {
  return app_.add_time_interval(duration, callback);
}

void LiveContext::clear_timer(int32_t timer_id) { app_.clear_timer(timer_id); }

void LiveContext::subscribe(const std::string &source, const std::vector<std::string> &instrument_ids,
                            const std::string &exchange_id) {
  auto md_location = broker_client_.find_md_location(source, app_.get_live_home());
  for (const auto &instrument_id : instrument_ids) {
    broker_client_.subscribe(md_location, exchange_id, instrument_id);
  }
  ensure_connect();
  send_instrument_keys();
}

void LiveContext::subscribe_all(const std::string &source, uint8_t market_type, uint64_t instrument_type,
                                uint64_t data_type) {
  auto md_location = broker_client_.find_md_location(source, app_.get_live_home());
  broker_client_.subscribe_all(md_location, market_type, instrument_type, data_type);
  ensure_connect();
  send_instrument_keys();
}

void LiveContext::subscribe_operator(const std::string &group, const std::string &name) {
  uint32_t hashed_op = hash_operator(group, name);

  auto home = app_.get_live_home();
  auto operator_location = location::make_shared(mode::LIVE, category::OPERATOR, group, name, home->locator);
  if (not app_.has_location(operator_location->uid)) {
    SPDLOG_ERROR("subscribe operator no location");
    throw wingchun_error(fmt::format("invalid operator {}_{}", group, name));
  }

  broker_client_.enroll_operator(operator_location);
}

void LiveContext::publish_synthetic_data(const std::string &key, const std::string &value) {
  auto writer = app_.get_writer(location::PUBLIC);
  auto current_time = now();
  SyntheticData synthetic_data;
  synthetic_data.update_time = current_time;
  synthetic_data.key = key;
  synthetic_data.value = value;
  writer->write(current_time, synthetic_data);
}

broker::Client &LiveContext::get_broker_client() { return broker_client_; }

book::Bookkeeper &LiveContext::get_bookkeeper() { return bookkeeper_; }

void LiveContext::check_dependency_state(const event_ptr &event) {
  bool all_dependency_ready = true;
  if (event->msg_type() == BrokerStateUpdate::tag) {
    if (event->data<BrokerStateUpdate>().state == BrokerState::Ready and state_ == OperatorState::Ready)
      return;
    if (event->data<BrokerStateUpdate>().state != BrokerState::Ready and state_ != OperatorState::Ready)
      return;
    all_dependency_ready = broker_client_.enrolled_md_ready();
  }
  if (event->msg_type() == OperatorStateUpdate::tag) {
    if (event->data<OperatorStateUpdate>().state == OperatorState::Ready and state_ == OperatorState::Ready)
      return;
    if (event->data<OperatorStateUpdate>().state != OperatorState::Ready and state_ != OperatorState::Ready)
      return;
    all_dependency_ready = broker_client_.enrolled_operator_ready();
  }
  if (event->msg_type() == Deregister::tag) {
    all_dependency_ready = broker_client_.enrolled_operator_ready() and broker_client_.enrolled_md_ready();
  }
  OperatorStateUpdate state_update;
  if (not all_dependency_ready) {
    state_update.state = OperatorState::DisConnected;
    update_operator_state(state_update);
  } else {
    state_update.state = OperatorState::Ready;
    update_operator_state(state_update);
  }
  SPDLOG_DEBUG("checked dependency, all dependency ready={}, ", all_dependency_ready);
}

void LiveContext::req_deregister() { app_.request_deregister(); }

void LiveContext::update_operator_state(OperatorStateUpdate &state_update) {
  state_ = state_update.state;
  auto writer = app_.get_writer(location::PUBLIC);
  state_update.update_time = now();
  state_update.location_uid = app_.get_live_home_uid();
  writer->write(state_update.update_time, state_update);
}

void LiveContext::ensure_connect() {
  if (not started_) {
    return;
  }

  const event_ptr &e = app_.get_reader()->current_frame();
  for (const auto &pair : app_.get_registry()) {
    SPDLOG_DEBUG("Register: {}", pair.second.to_string());
    broker_client_.connect(e, pair.second);
  }

  for (const auto &pair : app_.get_bands()) {
    SPDLOG_DEBUG("Band: {}", pair.second.to_string());
    broker_client_.connect(e, pair.second);
  }
}

void LiveContext::send_instrument_keys() {
  if (not is_started()) {
    return;
  }
  for (const auto &pair : app_.get_locations()) {
    SPDLOG_DEBUG("Location: {}", pair.second->to_string());
    broker_client_.try_renew(now(), pair.second);
  }
}

yijinjing::data::location_ptr LiveContext::get_location(uint32_t location_uid) {
  return app_.get_location(location_uid);
}

void LiveContext::set_resume_policy(longfist::enums::ResumePolicy resume_policy) {
  broker_client_.set_resume_policy(resume_policy);
}

longfist::enums::ResumePolicy LiveContext::get_resume_policy() { return broker_client_.get_resume_policy_value(); }

uint32_t LiveContext::get_home_uid() const { return app_.get_home_uid(); }

uint32_t LiveContext::get_live_home_uid() const { return app_.get_live_home_uid(); }

std::shared_ptr<StreamDataBatcher> LiveContext::batch_streaming() {
  if (!live_stream_data_batcher_) {
    live_stream_data_batcher_ = std::make_shared<LiveStreamDataBatcher>();
    live_stream_data_batcher_->on_start(events_);
  }
  return live_stream_data_batcher_;
}

} // namespace kungfu::wingchun::op
