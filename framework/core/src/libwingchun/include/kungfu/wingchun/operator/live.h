// SPDX-License-Identifier: Apache-2.0

#ifndef WINGCHUN_OPERATOR_LIVE_H
#define WINGCHUN_OPERATOR_LIVE_H

#include <kungfu/wingchun/operator/context.h>

namespace kungfu::wingchun::op {
class LiveContext : public Context {
public:
  explicit LiveContext(practice::apprentice &app, const rx::connectable_observable<event_ptr> &events);

  /**
   * checked_ is strated started.
   * @return current time in nano seconds
   */
  virtual bool is_started() const override;

  /**
   * Get current time in nano seconds.
   * @return current time in nano seconds
   */
  int64_t now() const override;

  /**
   * Get location_uid of current process
   * @return location_uid
   */
  uint32_t get_home_uid() const override;

  /**
   * Get location_uid of current process
   * @return location_uid
   */
  uint32_t get_live_home_uid() const;

  /**
   * Get config from database.
   * @return config of current location_uid
   */
  const std::string get_config() const override;

  /**
   * Add one shot timer callback.
   * @param nanotime when to call in nano seconds
   * @param callback callback function
   */
  int32_t add_timer(int64_t nanotime, const std::function<void(event_ptr)> &callback) override;

  /**
   * Add periodically callback.
   * @param duration duration in nano seconds
   * @param callback callback function
   */
  int32_t add_time_interval(int64_t duration, const std::function<void(event_ptr)> &callback) override;

  /**
   * Clear timer
   * @param timer_id id of timer, return by add_timer and add_time_interval
   */
  void clear_timer(int32_t timer_id) override;

  /**
   * Subscribe market data.
   * @param source MD group
   * @param instrument_ids instrument IDs
   * @param exchange_id exchange ID
   */
  void subscribe(const std::string &source, const std::vector<std::string> &instrument_ids,
                 const std::string &exchange_id) override;

  /**
   * Subscribe all from given MD
   * @param source MD group
   */
  void subscribe_all(const std::string &source, uint8_t market_type = 0, uint64_t instrument_type = 0,
                     uint64_t data_type = 0) override;

  /**
   * Subscribe operator data.
   * @param group OPERATOR group
   * @param name OPERATOR name
   */
  void subscribe_operator(const std::string &group, const std::string &name) override;

  /**
   * publish operator data.
   * @param key key of data to be published
   * @param value value of data to be published
   */
  void publish_synthetic_data(const std::string &key, const std::string &value) override;

  /**
   * request deregister.
   * @return void
   */
  void req_deregister() override;

  /**
   * Update Strategy State
   * @param state StrategyState
   * @param infos vector<string>, info_a, info_b, info_c.
   */
  void update_operator_state(longfist::types::OperatorStateUpdate &state_update) override;

  /**
   * Get broker client.
   * @return broker client reference
   */
  broker::Client &get_broker_client() override;

  /**
   * Get bookkeeper.
   * @return bookkeeper reference
   */
  book::Bookkeeper &get_bookkeeper() override;

  void check_dependency_state(const event_ptr &event);

  yijinjing::data::location_ptr get_location(uint32_t location_uid) override;

  void set_resume_policy(longfist::enums::ResumePolicy resume_policy) override;

  longfist::enums::ResumePolicy get_resume_policy() override;

  std::shared_ptr<wingchun::factor::StreamDataBatcher> batch_streaming() override;

protected:
  void on_start() override;

  void prepare(const event_ptr &event) override;

  void ensure_connect();

  void send_instrument_keys();

private:
  longfist::enums::OperatorState state_;
  bool broker_states_requested_{false};

  static std::shared_ptr<wingchun::factor::LiveStreamDataBatcher> live_stream_data_batcher_;
  broker::PassiveClient broker_client_;
  book::Bookkeeper bookkeeper_;
};

DECLARE_PTR(LiveContext)
} // namespace kungfu::wingchun::op

#endif // WINGCHUN_OPERATOR_LIVE_H
