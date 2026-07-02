// SPDX-License-Identifier: Apache-2.0

//
// Created by Keren Dong on 2020/3/12.
//

#ifndef WINGCHUN_BROKER_CLIENT_H
#define WINGCHUN_BROKER_CLIENT_H

#include <kungfu/longfist/longfist.h>
#include <kungfu/wingchun/broker/broker.h>
#include <kungfu/yijinjing/io.h>
#include <kungfu/yijinjing/log.h>
#include <kungfu/yijinjing/practice/apprentice.h>

namespace kungfu::wingchun::broker {
/**
 * Policy interface to decide the time point to resume when connecting to a broker.
 */
struct ResumePolicy {
  [[nodiscard]] virtual int64_t get_connect_time(const practice::apprentice &app,
                                                 const longfist::types::Register &target) const;

  [[nodiscard]] virtual int64_t get_resume_time(const practice::apprentice &app,
                                                const longfist::types::Register &target) const = 0;
};

DECLARE_PTR(ResumePolicy);

/**
 * Always resume from the last unread frame, is intended to be used by system services that needs continuity.
 */
struct StatelessResumePolicy : public ResumePolicy {
  [[nodiscard]] int64_t get_resume_time(const practice::apprentice &app,
                                        const longfist::types::Register &target) const override;
};

/**
 * Always resume from the last unread frame, is intended to be used by system services that needs continuity.
 */
struct ContinuousResumePolicy : public ResumePolicy {
  [[nodiscard]] int64_t get_resume_time(const practice::apprentice &app,
                                        const longfist::types::Register &target) const override;
};

/**
 * Resumes from the last unread frame, or the start of today if the last unread frame was before it.
 * This policy ensures the client does not look back data before today, is intended to be used by strategies.
 */
struct IntradayResumePolicy : public ResumePolicy {
  [[nodiscard]] int64_t get_resume_time(const practice::apprentice &app,
                                        const longfist::types::Register &target) const override;
};

struct FromNowResumePolicy : public ResumePolicy {
  [[nodiscard]] int64_t get_connect_time(const practice::apprentice &app,
                                         const longfist::types::Register &target) const override;

  [[nodiscard]] int64_t get_resume_time(const practice::apprentice &app,
                                        const longfist::types::Register &target) const override;
};

/**
 * Manage connections to brokers.
 */
class Client {
  typedef std::unordered_map<uint32_t, longfist::types::InstrumentKey> InstrumentKeyMap;
  typedef std::unordered_map<uint32_t, longfist::enums::BrokerState> BrokerStateMap;
  typedef std::unordered_map<uint32_t, longfist::enums::OperatorState> OperatorStateMap;
  typedef std::unordered_map<std::string, yijinjing::data::location_ptr> ExchangeSourceMap;
  typedef std::unordered_map<uint32_t, yijinjing::data::location_ptr> InstrumentSourceMap;

public:
  explicit Client(practice::apprentice &app);

  virtual ~Client() = default;

  [[nodiscard]] virtual ResumePolicy_ptr get_resume_policy() const = 0;

  [[nodiscard]] const InstrumentKeyMap &get_instrument_keys() const;

  [[nodiscard]] virtual bool is_ready(uint32_t broker_location_uid) const;

  [[nodiscard]] virtual bool is_connected(uint32_t broker_location_uid) const;

  [[nodiscard]] virtual bool is_custom_subscribed(uint32_t md_location_uid) const = 0;

  [[nodiscard]] virtual bool is_custom_subscribed_all(uint32_t md_location_uid,
                                                      kungfu::longfist::enums::SubscribeDataType data_type,
                                                      const std::string &exchange_id,
                                                      longfist::enums::InstrumentType kf_instrument_type) const = 0;

  [[nodiscard]] virtual bool is_all_subscribed(uint32_t md_location_uid) const = 0;

  [[nodiscard]] virtual bool is_subscribed(const std::string &exchange_id, const std::string &instrument_id) const;

  virtual void subscribe(const longfist::types::InstrumentKey &instrument_key);

  virtual void unsubscribe(const longfist::types::InstrumentKey &instrument_key);

  virtual void subscribe(const std::string &exchange_id, const std::string &instrument_id);

  virtual void unsubscribe(const std::string &exchange_id, const std::string &instrument_id);

  virtual void subscribe(const yijinjing::data::location_ptr &md_location, const std::string &exchange_id,
                         const std::string &instrument_id);

  virtual void connect(const event_ptr &event, const longfist::types::Register &register_data);

  virtual void connect(const event_ptr &event, const longfist::types::Band &band);

  virtual void renew(int64_t trigger_time, const yijinjing::data::location_ptr &md_location);

  virtual bool try_renew(int64_t trigger_time, const yijinjing::data::location_ptr &md_location);

  virtual void sync(int64_t trigger_time, const yijinjing::data::location_ptr &td_location);

  virtual bool try_sync(int64_t trigger_time, const yijinjing::data::location_ptr &td_location);

  virtual void on_start(const rx::connectable_observable<event_ptr> &events);

  [[nodiscard]] virtual bool should_connect_md(const yijinjing::data::location_ptr &md_location) const = 0;

  [[nodiscard]] virtual bool should_connect_td(const yijinjing::data::location_ptr &td_location) const = 0;

  [[nodiscard]] virtual bool should_connect_md(uint32_t md_location_uid) const = 0;

  [[nodiscard]] virtual bool should_connect_td(uint32_t td_location_uid) const = 0;

  [[nodiscard]] virtual bool should_connect_operator(const yijinjing::data::location_ptr &op_location) const = 0;

  [[nodiscard]] virtual bool should_connect_operator(uint32_t op_location_uid) const = 0;

  [[nodiscard]] virtual bool should_connect_strategy(const yijinjing::data::location_ptr &strategy_location) const = 0;

  [[nodiscard]] virtual bool should_connect_system(const yijinjing::data::location_ptr &system_location) const = 0;

  [[nodiscard]] kungfu::yijinjing::data::location_ptr get_location(uint32_t uid) const {
    return app_.get_location(uid);
  }

  [[nodiscard]] bool has_channel(uint32_t source, uint32_t dest) const { return app_.has_channel(source, dest); }

protected:
  practice::apprentice &app_;

private:
  BrokerStateMap broker_states_ = {};
  OperatorStateMap operator_states_ = {};
  InstrumentKeyMap instrument_keys_ = {};
  ExchangeSourceMap exchange_md_locations_ = {};
  InstrumentSourceMap instrument_md_locations_ = {};
  yijinjing::data::location_map ready_md_locations_ = {};
  yijinjing::data::location_map ready_td_locations_ = {};
  yijinjing::data::location_map ready_op_locations_ = {};

  template <typename AppStateUpdate,
            std::enable_if_t<std::is_same_v<AppStateUpdate, longfist::types::BrokerStateUpdate> or
                             std::is_same_v<AppStateUpdate, longfist::types::OperatorStateUpdate>>...>
  void update_app_state(const event_ptr &event, const AppStateUpdate &state) {
    using AppState = decltype(state.state);
    using kungfu::longfist::enums::category;
    using yijinjing::data::location_map;
    auto state_value = state.state;
    auto app_location = app_.get_location(state.location_uid);
    bool state_ready = state_value == AppState::Ready;
    bool state_reset = state_value == AppState::Connected or state_value == AppState::DisConnected;

    auto switch_broker_state = [&](category broker_category, location_map &ready_locations, auto on_app_ready) {
      bool ready_recorded = ready_locations.find(app_location->uid) != ready_locations.end();
      if (state_ready and not ready_recorded) {
        ready_locations.emplace(app_location->uid, app_location);
        SPDLOG_INFO("{} ready, state {}", app_location->uname, static_cast<int>(state_value));
        on_app_ready();
      }
      if (state_reset and ready_recorded) {
        ready_locations.erase(app_location->uid);
        SPDLOG_INFO("{} reset, state {}", app_location->uname, static_cast<int>(state_value));
      }
    };
    if constexpr (std::is_same<AppState, longfist::enums::BrokerState>::value) {
      if (app_location->category == longfist::enums::category::MD) {
        switch_broker_state(longfist::enums::category::MD, ready_md_locations_,
                            [&]() { renew(event->gen_time(), app_location); });
        broker_states_.emplace(app_location->uid, state_value);
      }
      if (app_location->category == longfist::enums::category::TD) {
        switch_broker_state(category::TD, ready_td_locations_, [&]() { sync(event->gen_time(), app_location); });
        broker_states_.emplace(app_location->uid, state_value);
      }
    }
    if constexpr (std::is_same<AppState, longfist::enums::OperatorState>::value) {
      if (app_location->category == category::OPERATOR) {
        switch_broker_state(category::OPERATOR, ready_op_locations_, [&]() {});

        operator_states_.emplace(app_location->uid, state_value);
      }
    }
  }

  void on_deregister(const longfist::types::Deregister &deregister_data);
};

/**
 * Automatically connects all brokers, and subscribe only the instruments that has been explicitly added.
 * In addition to brokers it also handle connections to strategies. This is intended to be used by system services like
 * ledger, risk, watcher, etc.
 */
class AutoClient : public Client {
public:
  explicit AutoClient(practice::apprentice &app);

  [[nodiscard]] ResumePolicy_ptr get_resume_policy() const override;

  [[nodiscard]] bool is_custom_subscribed(uint32_t md_location_uid) const override;

  [[nodiscard]] bool is_custom_subscribed_all(uint32_t md_location_uid,
                                              kungfu::longfist::enums::SubscribeDataType data_type,
                                              const std::string &exchange_id,
                                              longfist::enums::InstrumentType kf_instrument_type) const override;

  [[nodiscard]] bool is_all_subscribed(uint32_t md_location) const override;

protected:
  [[nodiscard]] bool should_connect_md(const yijinjing::data::location_ptr &md_location) const override;

  [[nodiscard]] bool should_connect_td(const yijinjing::data::location_ptr &td_location) const override;

  [[nodiscard]] bool should_connect_md(uint32_t md_location_uid) const override;

  [[nodiscard]] bool should_connect_td(uint32_t td_location_uid) const override;

  [[nodiscard]] bool should_connect_operator(const yijinjing::data::location_ptr &op_location) const override;

  [[nodiscard]] bool should_connect_operator(uint32_t op_location_uid) const override;

  [[nodiscard]] bool should_connect_strategy(const yijinjing::data::location_ptr &strategy_location) const override;

  [[nodiscard]] bool should_connect_system(const yijinjing::data::location_ptr &system_location) const override;

private:
  StatelessResumePolicy resume_policy_ = {};
};

/**
 * Automatically connect all brokers and strategies.
 * It differs from AutoClient in the sense that it does not issue any subscriptions, but assumes all instruments that
 * seen is subscribed.
 */
class SilentAutoClient : public AutoClient {
public:
  explicit SilentAutoClient(practice::apprentice &app);

  // [[nodiscard]] bool is_subscribed(const std::string &exchange_id, const std::string &instrument_id) const override;

  void renew(int64_t trigger_time, const yijinjing::data::location_ptr &md_location) override;

  void sync(int64_t trigger_time, const yijinjing::data::location_ptr &td_location) override;
};

/**
 * Only connects brokers that has been explicitly added. It supports subscribe_all for MD that has such ability.
 */
class PassiveClient : public Client {
  typedef std::unordered_map<uint32_t, bool> EnrollmentMap;
  typedef std::unordered_map<uint32_t, yijinjing::data::location_ptr> EnrolledLocationMap;
  typedef std::unordered_map<uint32_t, std::vector<longfist::types::CustomSubscribe>> CustomSubscribeMap;

public:
  explicit PassiveClient(practice::apprentice &app);

  [[nodiscard]] ResumePolicy_ptr get_resume_policy() const override;

  longfist::enums::ResumePolicy get_resume_policy_value() const;

  [[nodiscard]] bool is_custom_subscribed(uint32_t md_location_uid) const override;

  [[nodiscard]] bool is_custom_subscribed_all(uint32_t md_location_uid,
                                              kungfu::longfist::enums::SubscribeDataType data_type,
                                              const std::string &exchange_id,
                                              longfist::enums::InstrumentType kf_instrument_type) const override;

  [[nodiscard]] bool is_all_subscribed(uint32_t md_location) const override;

  void subscribe(const yijinjing::data::location_ptr &md_location, const std::string &exchange_id,
                 const std::string &instrument_id) override;

  void subscribe_all(const yijinjing::data::location_ptr &md_location, uint8_t market_type = 0,
                     uint64_t instrument_type = 0, uint64_t data_type = 0);

  void renew(int64_t trigger_time, const yijinjing::data::location_ptr &md_location) override;

  void sync(int64_t trigger_time, const yijinjing::data::location_ptr &td_location) override;

  void enroll_td(const yijinjing::data::location_ptr &td_location);

  void enroll_md(const yijinjing::data::location_ptr &md_location, bool is_custom_subscribe);

  void enroll_operator(const yijinjing::data::location_ptr &op_location);

  bool enrolled_operator_ready() const;

  bool enrolled_md_ready() const;

  bool enrolled_td_ready() const;

  bool enrolled_operator_connected() const;

  bool enrolled_md_connected() const;

  bool enrolled_td_connected() const;

  bool has_enrolled_td_channel(uint32_t home_uid) const;

  const EnrolledLocationMap &get_enrolled_md_locations() const;

  const EnrolledLocationMap &get_enrolled_td_locations() const;

  const EnrolledLocationMap &get_enrolled_op_locations() const;

  uint32_t get_td_location_uid(const std::string &source, const std::string &account) const;

  const yijinjing::data::location_ptr &find_md_location(const std::string &source,
                                                        const yijinjing::data::location_ptr &home);

  void set_resume_policy(longfist::enums::ResumePolicy resume_policy);

  longfist::enums::ResumePolicy get_resume_policy();

protected:
  [[nodiscard]] bool should_connect_md(const yijinjing::data::location_ptr &md_location) const override;

  [[nodiscard]] bool should_connect_td(const yijinjing::data::location_ptr &td_location) const override;

  [[nodiscard]] bool should_connect_md(uint32_t md_location_uid) const override;

  [[nodiscard]] bool should_connect_td(uint32_t td_location_uid) const override;

  [[nodiscard]] bool should_connect_operator(const yijinjing::data::location_ptr &op_location) const override;

  [[nodiscard]] bool should_connect_operator(uint32_t op_location_uid) const override;

  [[nodiscard]] bool should_connect_strategy(const yijinjing::data::location_ptr &strategy_location) const override;

  [[nodiscard]] bool should_connect_system(const yijinjing::data::location_ptr &system_location) const override;

private:
  longfist::enums::ResumePolicy resume_policy_ = longfist::enums::ResumePolicy::Now;
  CustomSubscribeMap custom_subs_ = {};
  EnrollmentMap enrolled_md_custom_info_ = {};
  EnrolledLocationMap enrolled_md_locations_ = {};
  EnrolledLocationMap enrolled_td_locations_ = {};
  EnrolledLocationMap enrolled_hash_td_locations_ = {};
  EnrolledLocationMap enrolled_op_locations_ = {};

  std::unordered_map<std::string, yijinjing::data::location_ptr> str_key_md_locations_ = {};
};

template <typename DataType, std::enable_if_t<longfist::is_market_data<DataType>()>...>
static constexpr bool is_own_event(const Client &broker_client, const event_ptr &event) {
  if (event->msg_type() == DataType::tag) {
    const DataType &data = event->data<DataType>();
    if (broker_client.is_custom_subscribed(event->source())) {
      if ((std::is_same_v<DataType, longfist::types::Quote> &&
           broker_client.is_custom_subscribed_all(event->source(), kungfu::longfist::enums::SubscribeDataType::Snapshot,
                                                  data.exchange_id, data.instrument_type)) ||
          (std::is_same_v<DataType, longfist::types::Tree> &&
           broker_client.is_custom_subscribed_all(event->source(), kungfu::longfist::enums::SubscribeDataType::Tree,
                                                  data.exchange_id, data.instrument_type)) ||
          (std::is_same_v<DataType, longfist::types::Depth> &&
           broker_client.is_custom_subscribed_all(event->source(), kungfu::longfist::enums::SubscribeDataType::Depth,
                                                  data.exchange_id, data.instrument_type)) ||
          (std::is_same_v<DataType, longfist::types::Tick> &&
           broker_client.is_custom_subscribed_all(event->source(), kungfu::longfist::enums::SubscribeDataType::Tick,
                                                  data.exchange_id, data.instrument_type)) ||
          (std::is_same_v<DataType, longfist::types::Transaction> &&
           broker_client.is_custom_subscribed_all(event->source(),
                                                  kungfu::longfist::enums::SubscribeDataType::Transaction,
                                                  data.exchange_id, data.instrument_type)) ||
          (std::is_same_v<DataType, longfist::types::Entrust> &&
           broker_client.is_custom_subscribed_all(event->source(), kungfu::longfist::enums::SubscribeDataType::Entrust,
                                                  data.exchange_id, data.instrument_type))) {
        return true;
      }
    }
    if (broker_client.is_subscribed(data.exchange_id, data.instrument_id)) {
      return true;
    }
  }
  return false;
}

template <typename DataType, std::enable_if_t<std::is_same_v<DataType, longfist::types::Register> or
                                              std::is_same_v<DataType, longfist::types::Deregister>>...>
static constexpr bool is_own_event(const Client &broker_client, const event_ptr &event) {
  if (event->msg_type() == DataType::tag) {
    const DataType &data = event->data<DataType>();
    return broker_client.should_connect_md(data.location_uid) or broker_client.should_connect_td(data.location_uid) or
           broker_client.should_connect_operator(data.location_uid);
  }
  return false;
}

template <typename DataType, std::enable_if_t<std::is_same_v<DataType, longfist::types::BrokerStateUpdate>>...>
static constexpr bool is_own_event(const Client &broker_client, const event_ptr &event) {
  if (event->msg_type() == DataType::tag) {
    const DataType &data = event->data<DataType>();
    return (broker_client.should_connect_md(data.location_uid) or broker_client.should_connect_td(data.location_uid));
  }
  return false;
};

template <typename DataType, std::enable_if_t<std::is_same_v<DataType, longfist::types::OperatorStateUpdate>>...>
static constexpr bool is_own_event(const Client &broker_client, const event_ptr &event) {
  if (event->msg_type() == DataType::tag) {
    const DataType &data = event->data<DataType>();
    return broker_client.should_connect_operator(data.location_uid);
  }
  return false;
}

template <typename DataType> static constexpr auto is_own(const Client &broker_client) {
  return rx::filter([&](const event_ptr &event) { return is_own_event<DataType>(broker_client, event); });
}

static const std::map<int32_t, std::function<bool(const Client &broker_client, const event_ptr &)>> map_is_own_event = {
    {longfist::types::Quote::tag, is_own_event<longfist::types::Quote>},
    {longfist::types::Tree::tag, is_own_event<longfist::types::Tree>},
    {longfist::types::Depth::tag, is_own_event<longfist::types::Depth>},
    {longfist::types::Tick::tag, is_own_event<longfist::types::Tick>},
    {longfist::types::Entrust::tag, is_own_event<longfist::types::Entrust>},
    {longfist::types::Transaction::tag, is_own_event<longfist::types::Transaction>},
    {longfist::types::BrokerStateUpdate::tag, is_own_event<longfist::types::BrokerStateUpdate>},
    {longfist::types::OperatorStateUpdate::tag, is_own_event<longfist::types::OperatorStateUpdate>},
    {longfist::types::Deregister::tag, is_own_event<longfist::types::Deregister>},
};

} // namespace kungfu::wingchun::broker

#endif // WINGCHUN_BROKER_CLIENT_H
